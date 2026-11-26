package backend

import "time"

var chatDeliveryBuckets = [...]int64{10, 25, 50, 100, 200, 350, 500, 750, 1000, 2000, 5000, 30000}

func (h *Hub) recordChatDelivery(elapsed int64) {
	h.metricMu.Lock()
	defer h.metricMu.Unlock()
	bucket := len(chatDeliveryBuckets) - 1
	for i, upper := range chatDeliveryBuckets {
		if elapsed <= upper {
			bucket = i
			break
		}
	}
	h.chatDelivery[bucket]++
}

func (h *Hub) recordConnectionQuality(voice, freezes int64) {
	h.metricMu.Lock()
	defer h.metricMu.Unlock()
	h.connectionSamples++
	h.concealmentTotal += voice
	h.freezeTotal += freezes
}

func (h *Hub) connectionMetricsLocked() M {
	var total int64
	for _, count := range h.chatDelivery {
		total += count
	}
	value := M{"chatSamples": total, "mediaSamples": h.connectionSamples, "streamFreezes": h.freezeTotal}
	if total > 0 {
		var cumulative int64
		for i, count := range h.chatDelivery {
			cumulative += count
			if cumulative*100 >= total*95 {
				value["chatP95UpperMs"] = chatDeliveryBuckets[i]
				break
			}
		}
	}
	if h.connectionSamples > 0 {
		value["concealmentPercent"] = float64(h.concealmentTotal) / (100 * float64(h.connectionSamples))
	}
	return value
}

func (h *Hub) recordAction(event string, elapsed time.Duration, failed bool) {
	h.metricMu.Lock()
	defer h.metricMu.Unlock()
	if h.actions == nil {
		h.actions = map[string]M{}
	}
	m := h.actions[event]
	if m == nil {
		m = M{"count": int64(0), "failures": int64(0), "totalMs": float64(0), "maxMs": float64(0), "slow": int64(0)}
		h.actions[event] = m
	}
	ms := float64(elapsed) / float64(time.Millisecond)
	m["count"] = Num(m, "count") + 1
	m["totalMs"] = F(m["totalMs"]) + ms
	if ms > F(m["maxMs"]) {
		m["maxMs"] = ms
	}
	if failed {
		m["failures"] = Num(m, "failures") + 1
	}
	if ms > 500 {
		m["slow"] = Num(m, "slow") + 1
	}
}
func (h *Hub) recordDisconnect(reason string) {
	h.metricMu.Lock()
	defer h.metricMu.Unlock()
	if h.disconnects == nil {
		h.disconnects = map[string]int64{}
	}
	h.disconnects[reason]++
}
func (h *Hub) recordMaintenance(elapsed, delay time.Duration) {
	h.metricMu.Lock()
	defer h.metricMu.Unlock()
	if h.maintenance == nil {
		h.maintenance = M{"passes": int64(0), "maxMs": float64(0), "maxTimerDelayMs": float64(0)}
	}
	m := h.maintenance
	m["passes"] = Num(m, "passes") + 1
	ms := float64(elapsed) / float64(time.Millisecond)
	if ms > F(m["maxMs"]) {
		m["maxMs"] = ms
	}
	d := float64(delay) / float64(time.Millisecond)
	if d > F(m["maxTimerDelayMs"]) {
		m["maxTimerDelayMs"] = d
	}
}
func (h *Hub) Metrics() M {
	h.metricMu.Lock()
	defer h.metricMu.Unlock()
	actions := M{}
	for k, m := range h.actions {
		actions[k] = Clone(m)
	}
	disconnects := M{}
	for k, n := range h.disconnects {
		disconnects[k] = n
	}
	maintenance := Clone(h.maintenance)
	if h.maintenance == nil {
		maintenance = M{"passes": 0, "maxMs": 0, "maxTimerDelayMs": 0}
	}
	return M{"actions": actions, "disconnects": disconnects, "maintenance": maintenance, "connectionQuality": h.connectionMetricsLocked()}
}
