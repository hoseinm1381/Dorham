package backend

import "sort"

const audienceExpiry = 12000

// Watching is an ephemeral, authenticated subscription to a current voice-room share.
// Only the socket publishing a share receives its viewer IDs.
func (h *Hub) shareAudience(p *peer, body M) M {
	Strict(body, "requestId", "watching")
	var picked []string
	if raw, exists := body["watching"]; exists {
		items, ok := raw.([]any)
		Check(ok && len(items) <= 3, 400, "VALIDATION", "Invalid watched screens.")
		for _, item := range items {
			id, ok := item.(string)
			Check(ok && len(id) > 0 && len(id) <= 80, 400, "VALIDATION", "Invalid watched screen.")
			picked = append(picked, id)
		}
	}
	now := Now()
	db := h.a.DB
	membership := db.One("SELECT channel_id,epoch FROM voice_members WHERE user_id=? AND socket_id=? AND heartbeat>=?", p.uid, p.id, now-30000)
	channel := Str(membership, "channel_id")
	valid := make(map[string]bool)
	var own string
	if channel != "" {
		for _, share := range db.All("SELECT id,user_id FROM share_leases WHERE channel_id=? AND expires_at>=?", channel, now) {
			id := Str(share, "id")
			if Str(share, "user_id") == p.uid {
				own = id
				continue
			}
			for _, requested := range picked {
				if requested == id {
					valid[id] = true
				}
			}
		}
	}
	p.mu.Lock()
	p.screenWatching, p.screenWatchingUntil = valid, now+audienceExpiry
	p.screenWatchingEpoch = Str(membership, "epoch")
	p.mu.Unlock()
	viewers := []string{}
	if own != "" {
		members := db.All("SELECT user_id,socket_id,epoch FROM voice_members WHERE channel_id=? AND heartbeat>=?", channel, now-30000)
		for _, member := range members {
			h.mu.RLock()
			viewer := h.peers[Str(member, "socket_id")]
			h.mu.RUnlock()
			if viewer == nil || viewer.uid == p.uid || viewer.uid != Str(member, "user_id") {
				continue
			}
			viewer.mu.Lock()
			watching := viewer.screenWatchingUntil >= now && viewer.screenWatchingEpoch == Str(member, "epoch") && viewer.screenWatching[own]
			viewer.mu.Unlock()
			if watching {
				viewers = append(viewers, viewer.uid)
			}
		}
		sort.Strings(viewers)
	}
	return M{"shareId": own, "viewers": viewers}
}
