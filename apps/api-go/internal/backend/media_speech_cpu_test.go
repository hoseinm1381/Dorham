package backend

import "testing"

func TestSpeechCPUQuotaUsesTotalHostCapacity(t *testing.T) {
	for _, c := range []struct {
		percent, cpus int
		quota, period int64
	}{
		{30, 1, 3000, 10000}, {30, 2, 6000, 10000}, {30, 4, 12000, 10000}, {1, 1, 1000, 100000}, {100, 1, 10000, 10000},
	} {
		q, p, e := speechCPUQuota(c.percent, c.cpus)
		if e != nil || q != c.quota || p != c.period {
			t.Fatalf("%+v: got %d %d %v", c, q, p, e)
		}
	}
	for _, c := range [][2]int{{0, 1}, {101, 1}, {30, 0}, {30, 1048577}} {
		if _, _, e := speechCPUQuota(c[0], c[1]); e == nil {
			t.Fatalf("accepted invalid capacity %v", c)
		}
	}
}

func TestSpeechOnlineCPUList(t *testing.T) {
	for input, want := range map[string]int{"0": 1, "0-3": 4, "0-1,4,7-8\n": 5} {
		got, e := speechOnlineCPUs(input)
		if e != nil || got != want {
			t.Fatalf("%q: %d %v", input, got, e)
		}
	}
	for _, input := range []string{"", "-1", "3-1", "0,0", "0-2,2-3", "0,,2", "0-1-2", "0-99999999"} {
		if _, e := speechOnlineCPUs(input); e == nil {
			t.Fatalf("accepted invalid online CPUs %q", input)
		}
	}
}
