//go:build !windows

package backend

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

func processAlive(pid int) bool { e := syscall.Kill(pid, 0); return e == nil || e == syscall.EPERM }
func processCPU() M {
	var usage syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &usage) != nil {
		return M{"user": 0, "system": 0}
	}
	return M{"user": usage.Utime.Sec*1000000 + int64(usage.Utime.Usec), "system": usage.Stime.Sec*1000000 + int64(usage.Stime.Usec)}
}
func processRSS() uint64 {
	data, e := os.ReadFile("/proc/self/statm")
	if e != nil {
		return 0
	}
	parts := strings.Fields(string(data))
	if len(parts) < 2 {
		return 0
	}
	pages, _ := strconv.ParseUint(parts[1], 10, 64)
	return pages * uint64(os.Getpagesize())
}
