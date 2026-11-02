package backend

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// cpu.max is an aggregate quota, measured in microseconds per period. A value
// of 30% means 30% of all online host CPUs, not 30% of just one CPU.
func speechCPUQuota(percent, cpus int) (quota, period int64, err error) {
	if percent < 1 || percent > 100 || cpus < 1 || cpus > 1048576 {
		return 0, 0, errors.New("invalid TTS CPU capacity")
	}
	capacity := int64(percent) * int64(cpus)
	period = 10000
	if capacity*period/100 < 1000 {
		period = (100000 + capacity - 1) / capacity
	}
	return capacity * period / 100, period, nil
}

func speechOnlineCPUs(value string) (int, error) {
	seen := map[int]bool{}
	for _, part := range strings.Split(strings.TrimSpace(value), ",") {
		bounds := strings.Split(part, "-")
		if len(bounds) < 1 || len(bounds) > 2 {
			return 0, errors.New("invalid online CPU list")
		}
		start, err := strconv.Atoi(bounds[0])
		if err != nil || start < 0 || start > 1048575 {
			return 0, errors.New("invalid online CPU list")
		}
		end := start
		if len(bounds) == 2 {
			end, err = strconv.Atoi(bounds[1])
			if err != nil || end < start || end > 1048575 {
				return 0, errors.New("invalid online CPU range")
			}
		}
		for n := start; n <= end; n++ {
			if seen[n] {
				return 0, fmt.Errorf("overlapping online CPU range: %d", n)
			}
			seen[n] = true
		}
	}
	return len(seen), nil
}
