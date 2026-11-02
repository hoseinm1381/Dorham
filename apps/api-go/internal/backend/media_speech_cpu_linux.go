//go:build linux

package backend

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type speechCPUGroup struct {
	path, leaf            string
	percent, cpus         int
	quotaUsec, periodUsec int64
}

func speechDelegatedRoot(membership string) (string, error) {
	for _, line := range strings.Split(membership, "\n") {
		if !strings.HasPrefix(line, "0::/") {
			continue
		}
		path := strings.TrimPrefix(line, "0::")
		if filepath.Clean(path) != path || filepath.Base(path) != "app" || path == "/app" {
			return "", errors.New("TTS CPU isolation requires Delegate=cpu and DelegateSubgroup=app")
		}
		return filepath.Join("/sys/fs/cgroup", strings.TrimPrefix(filepath.Dir(path), "/")), nil
	}
	return "", errors.New("TTS CPU isolation requires cgroup v2")
}

// CLONE_INTO_CGROUP creates the process inside the quota before exec, covering
// interpreter startup, module imports, model loading, threads and descendants.
// A configured cap never falls back to an uncapped process if setup fails.
func prepareSpeechCPU(cmd *exec.Cmd, percent int) (*speechCPUGroup, func(), error) {
	noop := func() {}
	if percent == 0 {
		return nil, noop, nil
	}
	membership, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return nil, noop, err
	}
	root, err := speechDelegatedRoot(string(membership))
	if err != nil {
		return nil, noop, err
	}
	online, err := os.ReadFile("/sys/devices/system/cpu/online")
	if err != nil {
		return nil, noop, err
	}
	cpus, err := speechOnlineCPUs(string(online))
	if err != nil {
		return nil, noop, err
	}
	quota, period, err := speechCPUQuota(percent, cpus)
	if err != nil {
		return nil, noop, err
	}
	controllers, err := os.ReadFile(filepath.Join(root, "cgroup.controllers"))
	if err != nil || !strings.Contains(" "+strings.TrimSpace(string(controllers))+" ", " cpu ") {
		return nil, noop, errors.New("TTS CPU controller is not delegated")
	}
	enabled, err := os.ReadFile(filepath.Join(root, "cgroup.subtree_control"))
	if err != nil {
		return nil, noop, err
	}
	if !strings.Contains(" "+strings.TrimSpace(string(enabled))+" ", " cpu ") {
		if err = os.WriteFile(filepath.Join(root, "cgroup.subtree_control"), []byte("+cpu"), 0); err != nil {
			return nil, noop, fmt.Errorf("enable TTS CPU controller: %w", err)
		}
	}
	group := &speechCPUGroup{path: filepath.Join(root, "tts"), percent: percent, cpus: cpus, quotaUsec: quota, periodUsec: period}
	if err = os.Mkdir(group.path, 0755); err != nil && !os.IsExist(err) {
		return nil, noop, err
	}
	maxFile := filepath.Join(group.path, "cpu.max")
	wanted := fmt.Sprintf("%d %d", quota, period)
	current, err := os.ReadFile(maxFile)
	if err != nil {
		return nil, noop, err
	}
	// Do not reset the bandwidth period on every cold start/restart.
	if strings.TrimSpace(string(current)) != wanted {
		if err = os.WriteFile(maxFile, []byte(wanted), 0); err != nil {
			return nil, noop, err
		}
	}
	burstFile := filepath.Join(group.path, "cpu.max.burst")
	if burst, e := os.ReadFile(burstFile); e == nil && strings.TrimSpace(string(burst)) != "0" {
		if err = os.WriteFile(burstFile, []byte("0"), 0); err != nil {
			return nil, noop, err
		}
	}
	// Keep the aggregate quota stable, but never clone into a killed leaf again.
	// Affected kernels retain kill_seq on cgroup.kill and spuriously SIGKILL
	// subsequent CLONE_INTO_CGROUP children. Fresh leaves avoid that bug without
	// resetting or bypassing the shared parent bandwidth budget.
	group.leaf, err = os.MkdirTemp(group.path, "worker-")
	if err != nil {
		return nil, noop, err
	}
	fd, err := os.Open(group.leaf)
	if err != nil {
		_ = os.Remove(group.leaf)
		return nil, noop, err
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.UseCgroupFD = true
	cmd.SysProcAttr.CgroupFD = int(fd.Fd())
	return group, func() { fd.Close() }, nil
}

func (g *speechCPUGroup) kill() {
	// Never act on the app, its delegated root or a different service. All
	// descendants of this TTS-only leaf are retired together, including forks.
	if filepath.Base(g.path) == "tts" && filepath.Dir(g.leaf) == g.path && strings.HasPrefix(filepath.Base(g.leaf), "worker-") {
		_ = os.WriteFile(filepath.Join(g.leaf, "cgroup.kill"), []byte("1"), 0)
		deadline := time.Now().Add(2 * time.Second)
		for {
			if err := os.Remove(g.leaf); err == nil || os.IsNotExist(err) {
				return
			}
			if time.Now().After(deadline) {
				return // Any surviving descendant remains under the same parent cap.
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
}

func (g *speechCPUGroup) metrics() M {
	out := M{"enabled": true, "percentOfHost": g.percent, "hostCPUs": g.cpus, "quotaUsec": g.quotaUsec, "periodUsec": g.periodUsec, "cgroup": g.path, "workerCgroup": g.leaf}
	if value, err := os.ReadFile(filepath.Join(g.path, "cpu.stat")); err == nil {
		stats := M{}
		for _, line := range strings.Split(string(value), "\n") {
			parts := strings.Fields(line)
			if len(parts) == 2 {
				if n, e := strconv.ParseInt(parts[1], 10, 64); e == nil {
					stats[parts[0]] = n
				}
			}
		}
		out["stats"] = stats
	}
	return out
}
