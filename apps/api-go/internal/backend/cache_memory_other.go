//go:build !linux

package backend

func cacheMemoryHeadroom() (int64, int64, bool) { return 0, 0, false }
