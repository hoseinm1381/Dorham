//go:build linux

package backend

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSpeechDelegatedRoot(t *testing.T) {
	got, e := speechDelegatedRoot("0::/system.slice/dorham.service/app\n")
	if e != nil || got != "/sys/fs/cgroup/system.slice/dorham.service" {
		t.Fatal(got, e)
	}
	for _, value := range []string{"0::/system.slice/dorham.service", "0::/app", "0::/a/../b/app", "1:cpu:/a/app"} {
		if _, e := speechDelegatedRoot(value); e == nil {
			t.Fatalf("accepted %s", value)
		}
	}
}

// Explicit opt-in: these tests need a disposable delegated systemd service.
func cpuKernelOptIn(t *testing.T) string {
	t.Helper()
	if os.Getenv("DORHAM_TTS_CPU_TEST") != "1" {
		t.Skip("requires isolated delegated Linux service")
	}
	dir := os.Getenv("DORHAM_TTS_CPU_EVIDENCE")
	if !filepath.IsAbs(dir) || !strings.HasPrefix(filepath.Base(dir), "dorham-tts-cpu-") {
		t.Fatal("invalid owned CPU evidence directory")
	}
	if e := os.MkdirAll(dir, 0700); e != nil {
		t.Fatal(e)
	}
	return dir
}
func cpuEvidence(t *testing.T, dir, name string, value any) {
	t.Helper()
	data, e := json.MarshalIndent(value, "", "  ")
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(dir, name), data, 0600); e != nil {
		t.Fatal(e)
	}
}
func cpuStats(path string) map[string]int64 {
	out := map[string]int64{}
	data, _ := os.ReadFile(filepath.Join(path, "cpu.stat"))
	for _, line := range strings.Split(string(data), "\n") {
		p := strings.Fields(line)
		if len(p) == 2 {
			out[p[0]], _ = strconv.ParseInt(p[1], 10, 64)
		}
	}
	return out
}

func TestSpeechCPUHelper(t *testing.T) {
	if os.Getenv("DORHAM_TTS_CPU_HELPER") != "1" {
		t.Skip("helper subprocess only")
	}
	dir := cpuKernelOptIn(t)
	membership, e := os.ReadFile("/proc/self/cgroup")
	if e != nil {
		t.Fatal(e)
	}
	cpuEvidence(t, dir, fmt.Sprintf("pid-%d.json", os.Getpid()), M{"pid": os.Getpid(), "cgroup": string(membership), "phase": "first user code after Go runtime startup"})
	var children []*exec.Cmd
	if os.Getenv("DORHAM_TTS_CPU_CHILD") != "1" {
		for i := 0; i < 4; i++ {
			cmd := exec.Command(os.Args[0], "-test.run=^TestSpeechCPUHelper$")
			cmd.Env = append(os.Environ(), "DORHAM_TTS_CPU_CHILD=1")
			if e := cmd.Start(); e != nil {
				t.Fatal(e)
			}
			children = append(children, cmd)
		}
	}
	end := time.Now().Add(18 * time.Second)
	var n uint64
	for time.Now().Before(end) {
		for i := 0; i < 4096; i++ {
			n = n*6364136223846793005 + 1
		}
	}
	if n == 42 {
		t.Log(n)
	}
	for _, cmd := range children {
		if e := cmd.Wait(); e != nil {
			t.Fatal(e)
		}
	}
}

func TestSpeechCPUKernelQuotaAndDescendants(t *testing.T) {
	dir := cpuKernelOptIn(t)
	cmd := exec.Command(os.Args[0], "-test.run=^TestSpeechCPUHelper$")
	cmd.Env = append(os.Environ(), "DORHAM_TTS_CPU_HELPER=1")
	group, release, e := prepareSpeechCPU(cmd, 30)
	if e != nil {
		t.Fatal(e)
	}
	defer release()
	defer group.kill()
	for _, path := range []string{filepath.Dir(group.path), filepath.Join(filepath.Dir(group.path), "app")} {
		data, e := os.ReadFile(filepath.Join(path, "cpu.max"))
		if e != nil || !strings.HasPrefix(string(data), "max ") {
			t.Fatalf("API/parent CPU unexpectedly limited: %s %q %v", path, data, e)
		}
	}
	before := cpuStats(group.path)
	started := time.Now()
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	release()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	type sample struct {
		Elapsed float64 `json:"elapsedSeconds"`
		CPUUsec int64   `json:"cpuUsec"`
		Percent float64 `json:"hostPercent"`
	}
	var samples []sample
	lastAt := started
	lastCPU := before["usage_usec"]
	for {
		select {
		case e = <-done:
			if e != nil {
				t.Fatal(e)
			}
			goto finished
		case <-time.After(time.Second):
			now := time.Now()
			stat := cpuStats(group.path)
			percent := float64(stat["usage_usec"]-lastCPU) / now.Sub(lastAt).Seconds() / 10000 / float64(group.cpus)
			samples = append(samples, sample{now.Sub(started).Seconds(), stat["usage_usec"] - before["usage_usec"], percent})
			if percent > 30.8 {
				t.Fatalf("TTS CPU cap exceeded over >=1 second: %.3f%%", percent)
			}
			lastCPU = stat["usage_usec"]
			lastAt = now
		}
	}
finished:
	after := cpuStats(group.path)
	elapsed := time.Since(started).Seconds()
	usage := after["usage_usec"] - before["usage_usec"]
	percent := float64(usage) / elapsed / 10000 / float64(group.cpus)
	if percent > 30.4 || percent < 25 {
		t.Fatalf("CPU quota did not saturate/enforce: %.3f%%", percent)
	}
	if after["nr_throttled"] <= before["nr_throttled"] {
		t.Fatal("CPU throttle counter did not advance")
	}
	files, _ := filepath.Glob(filepath.Join(dir, "pid-*.json"))
	if len(files) != 5 {
		t.Fatalf("expected parent and four descendants, got %d", len(files))
	}
	for _, file := range files {
		data, _ := os.ReadFile(file)
		var record M
		if e = json.Unmarshal(data, &record); e != nil {
			t.Fatal(e)
		}
		if !strings.Contains(Str(record, "cgroup"), "/tts/worker-") {
			t.Fatalf("descendant born outside TTS cgroup: %s", data)
		}
	}
	cpuEvidence(t, dir, "kernel-load.json", M{"passed": true, "percentOfHost": percent, "elapsedSeconds": elapsed, "usageUsec": usage, "cpuCount": group.cpus, "quotaUsec": group.quotaUsec, "periodUsec": group.periodUsec, "processesVerified": 5, "apiAndParentUncapped": true, "throttledPeriods": after["nr_throttled"] - before["nr_throttled"], "samples": samples})
}

func TestSpeechCPUPiperColdWarmIdleAndMaximumText(t *testing.T) {
	dir := cpuKernelOptIn(t)
	if os.Getenv("DORHAM_TTS_CPU_REAL_PIPER") != "1" {
		t.Skip("real Piper explicitly enabled only")
	}
	w := &mediaSpeechWorker{idle: 1, lastUsed: Now(), cpuPercent: 30, timeout: 300 * time.Second}
	defer w.close()
	texts := []string{"Hello. This is the English cold start under the speech CPU limit.", "Hello again. Warm speech still works.", "سلام، این یک آزمایش فارسی با محدودیت پردازنده است.", strings.Repeat("Clear speech remains available. ", 20)[:400], "سلام دوستان. Hello friends. خوش آمدید. Welcome."}
	var results []M
	for index, text := range texts {
		cold := false
		membership, e := os.ReadFile("/proc/self/cgroup")
		if e != nil {
			t.Fatal(e)
		}
		root, e := speechDelegatedRoot(string(membership))
		if e != nil {
			t.Fatal(e)
		}
		beforeCPU := cpuStats(filepath.Join(root, "tts"))["usage_usec"]
		start := time.Now()
		var mu sync.Mutex
		var samples []M
		stop := make(chan struct{})
		finished := make(chan struct{})
		go func() {
			defer close(finished)
			for {
				select {
				case <-stop:
					return
				case <-time.After(time.Second):
					w.mu.Lock()
					g := w.isolation
					w.mu.Unlock()
					if g != nil {
						mu.Lock()
						samples = append(samples, M{"atSeconds": time.Since(start).Seconds(), "stats": cpuStats(g.path)})
						mu.Unlock()
					}
				}
			}
		}()
		data, e := w.synthesize(text, func() { cold = true })
		close(stop)
		<-finished
		if e != nil {
			t.Fatalf("real Piper case %d failed: %v", index, e)
		}
		if len(data) < 1024 || !bytes.HasPrefix(data, []byte("RIFF")) {
			t.Fatal("invalid real speech WAV")
		}
		hash := sha256.Sum256(data)
		elapsed := time.Since(start).Seconds()
		usedCPU := cpuStats(w.isolation.path)["usage_usec"] - beforeCPU
		percent := float64(usedCPU) / elapsed / 10000 / float64(w.isolation.cpus)
		if elapsed >= 1 && percent > 30.8 {
			t.Fatalf("real Piper CPU exceeded quota including cold start: %.3f%%", percent)
		}
		results = append(results, M{"case": index, "characters": len([]rune(text)), "seconds": elapsed, "cpuUsec": usedCPU, "percentOfHost": percent, "cold": cold, "bytes": len(data), "sha256": hex.EncodeToString(hash[:]), "samples": samples})
		if index == 0 && !cold || index > 0 && cold {
			t.Fatalf("unexpected cold/warm state: case %d cold=%v", index, cold)
		}
		if index == 0 {
			membership, _ := os.ReadFile(fmt.Sprintf("/proc/%d/cgroup", w.cmd.Process.Pid))
			if !strings.Contains(string(membership), "/tts/worker-") {
				t.Fatal("real Python outside TTS cap")
			}
			cpuEvidence(t, dir, "python-membership.json", M{"pid": w.cmd.Process.Pid, "cgroup": string(membership)})
		}
	}
	w.mu.Lock()
	w.lastUsed = Now() - 2
	w.mu.Unlock()
	w.cleanup()
	if Bool(w.metrics(), "running") {
		t.Fatal("idle cleanup failed")
	}
	cold := false
	data, e := w.synthesize("سلام. Speech restarts after idle.", func() { cold = true })
	if e != nil || !cold || len(data) < 1024 {
		t.Fatalf("cold restart failed: %v", e)
	}
	cpuEvidence(t, dir, "real-piper.json", M{"passed": true, "results": results, "idleRetirementAndColdRestart": true, "timeoutSeconds": 300, "worker": w.metrics()})
}

func TestSpeechCPUKernelRetirementKillsDescendants(t *testing.T) {
	dir := filepath.Join(cpuKernelOptIn(t), "dorham-tts-cpu-retirement")
	if e := os.Mkdir(dir, 0700); e != nil {
		t.Fatal(e)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestSpeechCPUHelper$")
	cmd.Env = append(os.Environ(), "DORHAM_TTS_CPU_HELPER=1", "DORHAM_TTS_CPU_EVIDENCE="+dir)
	group, release, e := prepareSpeechCPU(cmd, 30)
	if e != nil {
		t.Fatal(e)
	}
	defer release()
	defer group.kill()
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	release()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	deadline := time.Now().Add(8 * time.Second)
	for {
		files, _ := filepath.Glob(filepath.Join(dir, "pid-*.json"))
		if len(files) == 5 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("retirement test descendants did not start")
		}
		time.Sleep(100 * time.Millisecond)
	}
	group.kill()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("busy parent survived cgroup retirement")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("TTS parent survived retirement")
	}
	deadline = time.Now().Add(3 * time.Second)
	for {
		events, err := os.ReadFile(filepath.Join(group.path, "cgroup.events"))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(events), "populated 0") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("TTS descendants survived retirement")
		}
		time.Sleep(50 * time.Millisecond)
	}
	cpuEvidence(t, filepath.Dir(dir), "retirement.json", M{"passed": true, "processesStarted": 5, "populatedAfterKill": 0})
}
