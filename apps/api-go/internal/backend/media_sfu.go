package backend

import (
	"net/url"
	"strings"
	"sync/atomic"
)

func (m *Media) sources(vm, ch M) []string {
	p := Obj(ch["permissions"])
	sources := []string{}
	if Bool(p, "speak") && !Bool(vm, "server_muted") && !Bool(vm, "server_deafened") {
		sources = append(sources, "microphone")
	}
	lease := m.a.DB.One("SELECT id,include_audio FROM share_leases WHERE user_id=? AND expires_at>=?", Str(vm, "user_id"), Now())
	if Bool(p, "share") && lease != nil {
		sources = append(sources, "screen_share")
		if Bool(lease, "include_audio") {
			sources = append(sources, "screen_share_audio")
		}
	}
	return sources
}
func (m *Media) Credentials(uid string, args ...string) M {
	Check(m.a.C.MediaTransport == "livekit", 409, "SFU_DISABLED", "This instance uses peer-to-peer media.")
	Check(len(args) == 2, 403, "FORBIDDEN", "An active voice session is required.")
	socket, channel := args[0], args[1]
	vm := m.a.DB.One("SELECT * FROM voice_members WHERE user_id=? AND socket_id=? AND channel_id=? AND heartbeat>=?", uid, socket, channel, Now()-30000)
	Check(vm != nil, 403, "FORBIDDEN", "An active voice session is required.")
	ch := m.a.Service.Channel(m.a.DB, uid, channel)
	sources := m.sources(vm, ch)
	identity := uid + ":" + Str(vm, "epoch")
	return M{"nativeScreenAudio": true, "url": m.a.C.LivekitURL, "identity": identity, "token": mediaJWT(m.a.C.LivekitKey, m.a.C.LivekitSecret, identity, M{"roomJoin": true, "room": channel, "canSubscribe": !Bool(vm, "server_deafened"), "canPublish": len(sources) > 0, "canPublishSources": sources, "canPublishData": false, "canUpdateOwnMetadata": false}, 60)}
}

// ScreenAudioCredentials is a publish-only auxiliary SDK session. Its identity
// binds the same authenticated voice epoch to one exact active audio lease.
func (m *Media) ScreenAudioCredentials(uid, socket, channel, leaseID string) M {
	Check(m.a.C.MediaTransport == "livekit", 409, "SFU_DISABLED", "This instance uses peer-to-peer media.")
	vm := m.a.DB.One("SELECT * FROM voice_members WHERE user_id=? AND socket_id=? AND channel_id=? AND heartbeat>=?", uid, socket, channel, Now()-30000)
	Check(vm != nil, 403, "FORBIDDEN", "An active voice session is required.")
	ch := m.a.Service.Channel(m.a.DB, uid, channel)
	lease := m.a.DB.One("SELECT id FROM share_leases WHERE id=? AND user_id=? AND channel_id=? AND expires_at>? AND include_audio=1", leaseID, uid, channel, Now())
	Check(Bool(Obj(ch["permissions"]), "share") && lease != nil, 403, "FORBIDDEN", "An active sound sharing lease is required.")
	identity := uid + ":" + Str(vm, "epoch") + ":screen:" + leaseID
	return M{"url": m.a.C.LivekitURL, "identity": identity, "token": mediaJWT(m.a.C.LivekitKey, m.a.C.LivekitSecret, identity, M{"roomJoin": true, "room": channel, "canSubscribe": false, "canPublish": true, "canPublishSources": []string{"screen_share_audio"}, "canPublishData": false, "canUpdateOwnMetadata": false}, 60)}
}
func (m *Media) Synchronize() {
	if m.a.C.MediaTransport != "livekit" {
		return
	}
	m.sfuMu.Lock()
	if m.sfuClosed {
		m.sfuMu.Unlock()
		return
	}
	m.sfuRequested++
	run := &mediaSFURun{done: make(chan struct{}), revision: m.sfuRequested}
	m.sfuWaiters = append(m.sfuWaiters, run)
	if m.sfuActive {
		m.sfuDirty = true
	} else {
		m.sfuActive = true
		go m.sfuDrain()
	}
	m.sfuMu.Unlock()
	<-run.done
	if run.failure != nil {
		panic(run.failure)
	}
}
func (m *Media) sfuDrain() {
	for {
		m.sfuMu.Lock()
		revision := m.sfuRequested
		m.sfuDirty = false
		m.sfuMu.Unlock()
		var failure any
		func() { defer func() { failure = recover() }(); m.synchronizePass() }()
		m.sfuMu.Lock()
		pending := m.sfuWaiters[:0]
		for _, waiter := range m.sfuWaiters {
			if failure != nil || waiter.revision <= revision {
				waiter.failure = failure
				close(waiter.done)
			} else {
				pending = append(pending, waiter)
			}
		}
		m.sfuWaiters = pending
		if len(pending) == 0 {
			m.sfuActive = false
			m.sfuDirty = false
			m.sfuMu.Unlock()
			return
		}
		m.sfuMu.Unlock()
	}
}
func (m *Media) synchronizePass() {
	atomic.AddInt64(&m.sfuPasses, 1)
	out, e := m.twirp("ListRooms", M{}, M{"roomList": true})
	mediaMust(e)
	for _, raw := range Arr(out["rooms"]) {
		room := Obj(raw)
		name := Str(room, "name")
		if m.a.DB.One("SELECT id FROM channels WHERE id=? AND kind='voice'", name) == nil {
			continue
		}
		out, e = m.twirp("ListParticipants", M{"room": name}, M{"roomAdmin": true, "room": name})
		if mediaMissing(e) {
			continue
		}
		mediaMust(e)
		actions := []func(){}
		m.a.DB.Tx(func(tx *DB) any {
			for _, raw := range Arr(out["participants"]) {
				p := Obj(raw)
				identity := Str(p, "identity")
				split := strings.Split(identity, ":")
				uid, epoch := "", ""
				auxiliary := len(split) == 4 && split[2] == "screen" && split[3] != ""
				if len(split) == 2 || auxiliary {
					uid, epoch = split[0], split[1]
				}
				remove := func() {
					actions = append(actions, func() {
						_, err := m.twirp("RemoveParticipant", M{"room": name, "identity": identity}, M{"roomAdmin": true, "room": name})
						if !mediaMissing(err) {
							mediaMust(err)
						}
						atomic.AddInt64(&m.sfuRemovals, 1)
					})
				}
				vm := tx.One("SELECT * FROM voice_members WHERE user_id=? AND epoch=? AND channel_id=? AND heartbeat>=?", uid, epoch, name, Now()-30000)
				if vm == nil {
					remove()
					continue
				}
				var ch M
				if !mediaSafe(func() { ch = m.a.Service.Channel(tx, uid, name) }) {
					remove()
					continue
				}
				// The snapshot and permission computation are local; SFU I/O is deferred.
				permissions := Obj(ch["permissions"])
				sources := []int{}
				if Bool(permissions, "speak") && !Bool(vm, "server_muted") && !Bool(vm, "server_deafened") {
					sources = append(sources, 2)
				}
				lease := tx.One("SELECT id,include_audio FROM share_leases WHERE user_id=? AND expires_at>=?", uid, Now())
				if Bool(permissions, "share") && lease != nil {
					sources = append(sources, 3)
					if Bool(lease, "include_audio") {
						sources = append(sources, 4)
					}
				}
				if auxiliary {
					if !Bool(permissions, "share") || lease == nil || !Bool(lease, "include_audio") || Str(lease, "id") != split[3] {
						remove()
						continue
					}
					sources = []int{4}
				}
				perm := M{"canSubscribe": !auxiliary && !Bool(vm, "server_deafened"), "canPublish": len(sources) > 0, "canPublishSources": sources, "canPublishData": false, "canUpdateMetadata": false}
				actual := Obj(p["permission"])
				same := actual != nil && Bool(actual, "canSubscribe") == Bool(perm, "canSubscribe") && Bool(actual, "canPublish") == Bool(perm, "canPublish") && !Bool(actual, "canPublishData") && !Bool(actual, "canUpdateMetadata") && mediaSourceSet(actual["canPublishSources"]) == mediaSourceSet(sources)
				if !same {
					actions = append(actions, func() {
						_, err := m.twirp("UpdateParticipant", M{"room": name, "identity": identity, "permission": perm}, M{"roomAdmin": true, "room": name})
						if !mediaMissing(err) {
							mediaMust(err)
						}
						atomic.AddInt64(&m.sfuUpdates, 1)
					})
				}
			}
			return nil
		})
		for _, action := range actions {
			action()
		}
	}
}
func mediaSourceSet(value any) string {
	set := map[int64]bool{}
	switch v := value.(type) {
	case []int:
		for _, n := range v {
			set[int64(n)] = true
		}
	default:
		for _, n := range Arr(value) {
			switch S(n) {
			case "MICROPHONE", "microphone":
				set[2] = true
			case "SCREEN_SHARE", "screen_share":
				set[3] = true
			case "SCREEN_SHARE_AUDIO", "screen_share_audio":
				set[4] = true
			default:
				set[N(n)] = true
			}
		}
	}
	out := ""
	for _, n := range []int64{0, 1, 2, 3, 4} {
		if set[n] {
			out += string(rune('0' + n))
		}
	}
	return out
}
func (m *Media) registerAdmission() {
	m.a.Route("GET", "/internal/media/admission", false, func(r *Request) any {
		secret := m.a.C.MediaAdmissionSecret
		Check(secret != "" && Equal(r.R.Header.Get("X-Dorham-Media-Gate"), secret), 404, "NOT_FOUND", "Not found.")
		denied := func() { Fail(403, "FORBIDDEN", "Media admission denied.") }
		uri, e := url.Parse(r.R.Header.Get("X-Forwarded-Uri"))
		if e != nil || !(uri.Path == "/rtc" || strings.HasPrefix(uri.Path, "/rtc/")) {
			denied()
		}
		raw := uri.Query().Get("access_token")
		if raw == "" {
			raw = strings.TrimPrefix(r.R.Header.Get("Authorization"), "Bearer ")
		}
		if raw == "" || len(raw) > 8192 {
			denied()
		}
		claims := mediaVerifyJWT(raw, m.a.C.LivekitKey, m.a.C.LivekitSecret)
		video := Obj(claims["video"])
		split := strings.Split(Str(claims, "sub"), ":")
		auxiliary := len(split) == 4 && split[2] == "screen" && split[3] != ""
		if !Bool(video, "roomJoin") || Str(video, "room") == "" || (len(split) != 2 && !auxiliary) || split[0] == "" || split[1] == "" {
			denied()
		}
		uid, epoch := split[0], split[1]
		vm := m.a.DB.One("SELECT v.* FROM voice_members v JOIN users u ON u.id=v.user_id WHERE v.user_id=? AND v.epoch=? AND v.channel_id=? AND v.heartbeat>=? AND u.banned=0 AND u.must_change_password=0", uid, epoch, Str(video, "room"), Now()-30000)
		session := ""
		if vm != nil {
			session = m.a.Hub.SessionForSocket(Str(vm, "socket_id"))
		}
		if vm == nil || session == "" || m.a.DB.One("SELECT id FROM sessions WHERE id=? AND user_id=? AND access_expires>=? AND expires_at>=?", session, uid, Now(), Now()) == nil {
			denied()
		}
		ch := m.a.Service.Channel(m.a.DB, uid, Str(vm, "channel_id"))
		p := Obj(ch["permissions"])
		if auxiliary {
			lease := m.a.DB.One("SELECT id FROM share_leases WHERE id=? AND user_id=? AND channel_id=? AND expires_at>? AND include_audio=1", split[3], uid, Str(vm, "channel_id"), Now())
			sources := Arr(video["canPublishSources"])
			if lease == nil || !Bool(p, "share") || video["canSubscribe"] != false || !Bool(video, "canPublish") || len(sources) != 1 || !mediaSourceIs(sources[0], "screen_share_audio", 4) {
				denied()
			}
		}
		if Bool(vm, "server_deafened") && video["canSubscribe"] != false {
			denied()
		}
		if Bool(video, "canPublishData") {
			denied()
		}
		if Bool(video, "canPublish") {
			sources := Arr(video["canPublishSources"])
			if len(sources) == 0 {
				denied()
			}
			for _, rawSource := range sources {
				if mediaSourceIs(rawSource, "microphone", 2) && Bool(p, "speak") && !Bool(vm, "server_muted") && !Bool(vm, "server_deafened") {
					continue
				}
				if mediaSourceIs(rawSource, "screen_share", 3) && Bool(p, "share") && m.a.DB.One("SELECT id FROM share_leases WHERE user_id=? AND channel_id=? AND expires_at>?", uid, Str(vm, "channel_id"), Now()) != nil {
					continue
				}
				if mediaSourceIs(rawSource, "screen_share_audio", 4) && Bool(p, "share") && m.a.DB.One("SELECT id FROM share_leases WHERE user_id=? AND channel_id=? AND expires_at>? AND include_audio=1", uid, Str(vm, "channel_id"), Now()) != nil {
					continue
				}
				denied()
			}
		}
		return M{"allowed": true}
	})
}
func mediaSourceIs(value any, name string, number int64) bool {
	if s, ok := value.(string); ok {
		return s == name
	}
	switch value.(type) {
	case jsonNumber, float64, int, int64:
		return F(value) == float64(number)
	}
	return false
}
