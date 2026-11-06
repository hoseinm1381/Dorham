package backend

import "sync"

type soundboardState struct {
	mu             sync.Mutex
	rooms, senders map[string]int64
}

func (s *soundboardState) reserve(uid, channel string, now int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rooms == nil {
		s.rooms, s.senders = map[string]int64{}, map[string]int64{}
	}
	for _, deadlines := range []map[string]int64{s.rooms, s.senders} {
		if len(deadlines) >= 256 {
			for id, expiry := range deadlines {
				if expiry <= now {
					delete(deadlines, id)
				}
			}
		}
		Check(len(deadlines) < 2048, 429, "SOUNDBOARD_BUSY", "The soundboard is busy.")
	}
	Check(s.rooms[channel] <= now && s.senders[uid] <= now, 429, "SOUNDBOARD_COOLDOWN", "Wait a moment before playing another sound.")
	s.rooms[channel], s.senders[uid] = now+3000, now+5000
}

func (a *App) registerSoundboard() {
	a.Route("GET", "/api/v1/features/soundboard/{id}", true, func(r *Request) any {
		channel := r.Param("id")
		return a.DB.Tx(func(tx *DB) any {
			a.Service.Channel(tx, r.UID(), channel, "view")
			return M{"enabled": featureSetting(tx, "soundboard:"+channel)["enabled"] != false}
		})
	})
	a.Route("PUT", "/api/v1/features/soundboard/{id}", true, func(r *Request) any {
		Strict(r.Body, "enabled", "requestId")
		channel, enabled := r.Param("id"), VBool(r.Body, "enabled")
		result := a.DB.Tx(func(tx *DB) any {
			requireLiveSession(tx, r)
			a.Service.Channel(tx, r.UID(), channel, "moderate")
			writeFeatureSetting(tx, "soundboard:"+channel, M{"enabled": enabled})
			Audit(tx, r.UID(), "feature.soundboard.room", channel, M{"enabled": enabled})
			return M{"success": true}
		})
		for _, voice := range a.DB.All("SELECT socket_id FROM voice_members WHERE channel_id=?", channel) {
			a.Hub.EmitSocket(Str(voice, "socket_id"), "soundboard:changed", M{"channelId": channel, "enabled": enabled})
		}
		return result
	})
}

func (a *App) playSound(uid, socket, session string, b M) M {
	Strict(b, "id", "requestId")
	id := VID(VString(b, "id", 1, 80, false))
	now := Now()
	var listeners []M
	var clip M
	a.DB.Tx(func(tx *DB) any {
		Check(voiceSessionActive(tx, session, now), 401, "UNAUTHORIZED", "Sign in again.")
		vm := tx.One("SELECT * FROM voice_members WHERE user_id=? AND socket_id=? AND heartbeat>?", uid, socket, now-30000)
		Check(vm != nil, 409, "NOT_IN_VOICE", "Join voice before playing a sound.")
		channel := Str(vm, "channel_id")
		ch := a.Service.Channel(tx, uid, channel, "speak")
		Check(!Bool(vm, "server_muted"), 403, "FORBIDDEN", "You are muted by a moderator.")
		Check(featureSetting(tx, "features")["soundboard"] != false && featureSetting(tx, "soundboard:"+channel)["enabled"] != false, 403, "FORBIDDEN", "Soundboard is disabled.")
		item := tx.One("SELECT * FROM feature_catalog WHERE id=? AND kind='sound'", id)
		Check(catalogUsable(tx, uid, item, Str(ch, "server_id")), 403, "FEATURE_REQUIRED", "This sound is unavailable.")
		a.soundboard.reserve(uid, channel, now)
		clip = M{"id": id, "url": catalogURL(item), "channelId": channel, "senderId": uid, "expiresAt": now + 3500}
		listeners = tx.All("SELECT socket_id,epoch FROM voice_members WHERE channel_id=? AND heartbeat>? AND deafened=0 AND server_deafened=0", channel, now-30000)
		return nil
	})
	for _, listener := range listeners {
		a.Hub.EmitSocket(Str(listener, "socket_id"), "soundboard:play", Merge(clip, M{"epoch": listener["epoch"]}))
	}
	return M{"success": true}
}
