package backend

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestMediaWorkerSubprocess(t *testing.T) {
	if os.Getenv("DORHAM_MEDIA_WORKER_FIXTURE") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var request map[string]string
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			os.Exit(2)
		}
		switch request["text"] {
		case "slow":
			time.Sleep(150 * time.Millisecond)
		case "invalid":
			fmt.Println(`{"audio":"not base64"}`)
			continue
		case "large":
			fmt.Println(`{"audio":"` + strings.Repeat("A", 4000001) + `"}`)
			continue
		}
		fmt.Println(`{"audio":"` + base64.StdEncoding.EncodeToString([]byte("RIFFfixture-wave-data")) + `"}`)
	}
	os.Exit(0)
}
func mediaFixtureWorker() *mediaSpeechWorker {
	return &mediaSpeechWorker{idle: 1, lastUsed: Now(), start: func() *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=^TestMediaWorkerSubprocess$")
		cmd.Env = append(os.Environ(), "DORHAM_MEDIA_WORKER_FIXTURE=1")
		return cmd
	}}
}
func TestMediaSpeechWorkerLifecycle(t *testing.T) {
	w := mediaFixtureWorker()
	defer w.close()
	cold := 0
	for i := 0; i < 2; i++ {
		data, e := w.synthesize("hello", func() { cold++ })
		if e != nil || string(data) != "RIFFfixture-wave-data" {
			t.Fatalf("synthesize=%q %v", data, e)
		}
	}
	if cold != 1 || Num(w.metrics(), "starts") != 1 {
		t.Fatal("cold start announcement/warm reuse")
	}
	time.Sleep(3 * time.Millisecond)
	w.cleanup()
	if Bool(w.metrics(), "running") || Num(w.metrics(), "idleStops") != 1 {
		t.Fatal("idle worker retained")
	}
	if _, e := w.synthesize("hello", func() { cold++ }); e != nil {
		t.Fatal(e)
	}
	if cold != 2 || Num(w.metrics(), "starts") != 2 {
		t.Fatal("cold restart")
	}
	w.close()
	if _, e := w.synthesize("hello", nil); e == nil {
		t.Fatal("closed worker accepted work")
	}
}
func TestMediaSpeechWorkerRejectsOverlapAndOversizedOutput(t *testing.T) {
	w := mediaFixtureWorker()
	defer w.close()
	done := make(chan error, 1)
	go func() { _, e := w.synthesize("slow", nil); done <- e }()
	deadline := time.Now().Add(3 * time.Second)
	for !Bool(w.metrics(), "busy") {
		if time.Now().After(deadline) {
			t.Fatal("worker did not start")
		}
		time.Sleep(time.Millisecond)
	}
	if _, e := w.synthesize("hello", nil); e == nil {
		t.Fatal("overlapping worker request admitted")
	}
	if e := <-done; e != nil {
		t.Fatal(e)
	}
	for _, text := range []string{"invalid", "large"} {
		if _, e := w.synthesize(text, nil); e == nil {
			t.Fatalf("%s response accepted", text)
		}
	}
	if _, e := w.synthesize("hello", nil); e != nil {
		t.Fatal("worker cannot recover after bad response", e)
	}
}
