package backend

import "sync/atomic"

type dbStats struct {
	reads, writes, commits             atomic.Uint64
	waitNanos, queryNanos, commitNanos atomic.Uint64
	cacheMiB                           atomic.Int64
}

func (d *DB) Metrics() M {
	if d.stats == nil {
		return M{}
	}
	s := d.stats
	return M{"reads": s.reads.Load(), "writeStatements": s.writes.Load(), "commits": s.commits.Load(), "mutexWaitMs": float64(s.waitNanos.Load()) / 1e6, "queryMs": float64(s.queryNanos.Load()) / 1e6, "commitMs": float64(s.commitNanos.Load()) / 1e6, "runtimeVoiceInMemory": d.conn != nil, "pageCacheBudgetMiB": s.cacheMiB.Load()}
}
