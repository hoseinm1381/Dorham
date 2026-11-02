package backend

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func flightRequest(f *revisionFlight, work func()) <-chan any {
	done := make(chan any, 1)
	go func() { defer func() { done <- recover() }(); f.run(work) }()
	return done
}
func flightQueued(t *testing.T, f *revisionFlight, want uint64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		got := f.requested
		f.mu.Unlock()
		if got >= want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("expected%d requests to join refresh flight", want)
}
func flightResult(t *testing.T, done <-chan any, want any) {
	t.Helper()
	select {
	case got := <-done:
		if got != want {
			t.Fatalf("refresh failure=%v want%v", got, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("refresh caller remained blocked after its revision completed")
	}
}
func flightPass(t *testing.T, started <-chan int, want int) {
	t.Helper()
	select {
	case got := <-started:
		if got != want {
			t.Fatalf("refresh pass%d want%d", got, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("refresh pass did not start")
	}
}

func TestIntegrationRevisionFlightCoalescesConcurrentBurst(t *testing.T) {
	var f revisionFlight
	var passes, active, peak atomic.Int32
	gate := make(chan struct{})
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(gate) }) })
	started := make(chan int, 64)
	work := func() {
		n := passes.Add(1)
		a := active.Add(1)
		for old := peak.Load(); a > old && !peak.CompareAndSwap(old, a); old = peak.Load() {
		}
		defer active.Add(-1)
		started <- int(n)
		if n == 1 {
			<-gate
		}
	}
	first := flightRequest(&f, work)
	flightPass(t, started, 1)
	const count = 32
	queued := make([]<-chan any, count)
	for i := range queued {
		queued[i] = flightRequest(&f, work)
	}
	flightQueued(t, &f, count+1)
	release.Do(func() { close(gate) })
	flightResult(t, first, nil)
	for _, done := range queued {
		flightResult(t, done, nil)
	}
	if passes.Load() != 2 {
		t.Fatalf("overlapping32request burst caused%d passes; want2", passes.Load())
	}
	if peak.Load() != 1 {
		t.Fatal("refresh passes overlapped")
	}
}

func TestIntegrationRevisionFlightOnlyWaitsForCallersOwnRevision(t *testing.T) {
	var f revisionFlight
	var passes atomic.Int32
	started := make(chan int, 8)
	gates := []chan struct{}{make(chan struct{}), make(chan struct{}), make(chan struct{})}
	var releases [3]sync.Once
	release := func(i int) { releases[i].Do(func() { close(gates[i]) }) }
	t.Cleanup(func() {
		for i := range gates {
			release(i)
		}
	})
	work := func() {
		n := int(passes.Add(1))
		started <- n
		if n <= len(gates) {
			<-gates[n-1]
		}
	}
	first := flightRequest(&f, work)
	flightPass(t, started, 1)
	second := flightRequest(&f, work)
	flightQueued(t, &f, 2)
	release(0)
	flightPass(t, started, 2)
	// Later edits must not indefinitely delay an already completed request's
	// HTTP response or Socket.IO ack. Node resolves that first waiter now.
	flightResult(t, first, nil)
	select {
	case <-second:
		t.Fatal("request made during first pass accepted stale snapshot")
	default:
	}
	third := flightRequest(&f, work)
	flightQueued(t, &f, 3)
	release(1)
	flightPass(t, started, 3)
	flightResult(t, second, nil)
	select {
	case <-third:
		t.Fatal("request made during second pass accepted stale snapshot")
	default:
	}
	release(2)
	flightResult(t, third, nil)
	if passes.Load() != 3 {
		t.Fatalf("want3 revision-fenced passes, got%d", passes.Load())
	}
}

func TestIntegrationRevisionFlightFailureRejectsWaitersAndRecovers(t *testing.T) {
	var f revisionFlight
	var passes atomic.Int32
	marker := errors.New("controlled refresh failure")
	gate := make(chan struct{})
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(gate) }) })
	started := make(chan int, 8)
	work := func() {
		n := passes.Add(1)
		started <- int(n)
		if n == 1 {
			<-gate
			panic(marker)
		}
	}
	first := flightRequest(&f, work)
	flightPass(t, started, 1)
	queued := make([]<-chan any, 16)
	for i := range queued {
		queued[i] = flightRequest(&f, work)
	}
	flightQueued(t, &f, 17)
	release.Do(func() { close(gate) })
	flightResult(t, first, marker)
	for _, done := range queued {
		flightResult(t, done, marker)
	}
	f.mu.Lock()
	active, pending := f.active, len(f.waiters)
	f.mu.Unlock()
	if active || pending != 0 {
		t.Fatal("failed refresh left stale active flight or waiters")
	}
	flightResult(t, flightRequest(&f, work), nil)
	if passes.Load() != 2 {
		t.Fatalf("next request failed to recover with one fresh pass: %d", passes.Load())
	}
}

func TestIntegrationHubCloseWaitsForRefreshAndRejectsNewWork(t *testing.T) {
	a, _ := integrationApp(t)
	a.DB.mu.Lock()
	var unlocked sync.Once
	release := func() { unlocked.Do(a.DB.mu.Unlock) }
	t.Cleanup(release)
	refreshDone := make(chan struct{})
	go func() { a.Hub.refreshVoice(); close(refreshDone) }()
	flightQueued(t, &a.Hub.voiceRefresh, 1)
	closed := make(chan struct{})
	go func() { a.Close(); close(closed) }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		a.Hub.mu.Lock()
		closing := a.Hub.closed
		a.Hub.mu.Unlock()
		if closing {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("hub did not begin closing")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case <-closed:
		t.Fatal("shutdown closed DB while an admitted refresh was blocked")
	default:
	}
	rejected := make(chan struct{})
	go func() { a.Hub.refreshVoice(); close(rejected) }()
	select {
	case <-rejected:
	case <-time.After(2 * time.Second):
		t.Fatal("new refresh blocked after shutdown admission closed")
	}
	release()
	select {
	case <-refreshDone:
	case <-time.After(2 * time.Second):
		t.Fatal("admitted refresh failed to finish during shutdown")
	}
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown failed to wait and drain refresh")
	}
}
