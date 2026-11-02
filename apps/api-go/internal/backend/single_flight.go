package backend

import "sync"

type revisionWaiter struct {
	revision uint64
	done     chan struct{}
	failure  any
}

// revisionFlight combines overlapping refreshes. A request made during a pass
// waits for a later pass, so an earlier snapshot cannot acknowledge a new edit.
type revisionFlight struct {
	mu        sync.Mutex
	requested uint64
	active    bool
	waiters   []*revisionWaiter
}

func (f *revisionFlight) run(work func()) {
	f.mu.Lock()
	f.requested++
	w := &revisionWaiter{revision: f.requested, done: make(chan struct{})}
	f.waiters = append(f.waiters, w)
	leader := !f.active
	f.active = true
	f.mu.Unlock()
	if leader {
		go f.drain(work)
	}
	<-w.done
	if w.failure != nil {
		panic(w.failure)
	}
}

func (f *revisionFlight) drain(work func()) {
	for {
		f.mu.Lock()
		revision := f.requested
		f.mu.Unlock()
		var failure any
		func() { defer func() { failure = recover() }(); work() }()
		f.mu.Lock()
		old := f.waiters
		pending := old[:0]
		for _, w := range f.waiters {
			if failure != nil || w.revision <= revision {
				w.failure = failure
				close(w.done)
			} else {
				pending = append(pending, w)
			}
		}
		clear(old[len(pending):])
		f.waiters = pending
		if len(pending) == 0 {
			f.waiters = nil
			f.active = false
			f.mu.Unlock()
			return
		}
		f.mu.Unlock()
	}
}
