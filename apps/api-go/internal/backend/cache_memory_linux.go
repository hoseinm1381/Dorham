package backend

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Virtual kernel files only; includes inherited cgroup limits, not just the
// uncapped API child below the service. Failure selects the conservative cache.
func cacheMemoryHeadroom() (host, service int64, ok bool) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 && f[0] == "MemAvailable:" {
			host, _ = strconv.ParseInt(f[1], 10, 64)
			host *= 1024
		}
	}
	group, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return
	}
	service = 1 << 62
	for _, line := range strings.Split(string(group), "\n") {
		if !strings.HasPrefix(line, "0::/") {
			continue
		}
		root := "/sys/fs/cgroup"
		path := filepath.Join(root, strings.TrimPrefix(strings.TrimPrefix(line, "0::"), "/"))
		for path != root && strings.HasPrefix(path, root+"/") {
			max, e := os.ReadFile(filepath.Join(path, "memory.max"))
			if e == nil && strings.TrimSpace(string(max)) != "max" {
				limit, e1 := strconv.ParseInt(strings.TrimSpace(string(max)), 10, 64)
				current, e2 := os.ReadFile(filepath.Join(path, "memory.current"))
				used, e3 := strconv.ParseInt(strings.TrimSpace(string(current)), 10, 64)
				if e1 != nil || e2 != nil || e3 != nil {
					return host, 0, false
				}
				service = min(service, limit-used)
			}
			path = filepath.Dir(path)
		}
		return host, service, host > 0
	}
	return host, 0, false
}
