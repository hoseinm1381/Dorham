package backend

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"strconv"
)

func ShareView(row M, c Config) M {
	fps := int64(15)
	if S(row["tier"]) == "standard" {
		fps = 30
	}
	result := M{"id": row["id"], "channelId": row["channel_id"], "userId": row["user_id"], "expiresAt": N(row["expires_at"]), "tier": row["tier"], "startedAt": N(row["started_at"]), "requestedFrameRate": N(row["requested_fps"]), "maxFrameRate": min(fps, int64(c.ScreenMaxFrameRate)), "includeAudio": B(row["include_audio"]), "policyRevision": N(row["policy_revision"])}
	if N(row["quality_height"]) == 1080 {
		result["maxHeight"], result["maxBitrate"], result["maxFrameRate"] = 1080, N(row["quality_bitrate"]), 15
	}
	return result
}
func ReconcileShares(tx *DB, c Config) {
	tx.Run("DELETE FROM share_leases WHERE expires_at<?", Now())
	reconcileHD(tx, c)
	available := max(0, int64(c.StandardShareSlots)-N(tx.One("SELECT COUNT(*) AS count FROM share_leases WHERE tier='standard'")["count"]))
	if available == 0 {
		return
	}
	for _, r := range tx.All("SELECT id FROM share_leases WHERE tier='fallback' ORDER BY started_at,id LIMIT ?", available) {
		tx.Run("UPDATE share_leases SET tier='standard',policy_revision=policy_revision+1 WHERE id=? AND tier='fallback'", r["id"])
	}
}
func (s *Service) ExpireVoice(tx *DB, now int64) {
	tx.Run("DELETE FROM voice_members WHERE heartbeat<?", now-30000)
	ReconcileShares(tx, s.C)
}
func (s *Service) MaintainRoom(tx *DB, id string, sweep ...bool) {
	now := Now()
	if len(sweep) == 0 || sweep[0] {
		s.ExpireVoice(tx, now)
	}
	current := tx.One("SELECT * FROM coordinators WHERE channel_id=?", id)
	var chosen M
	if S(current["user_id"]) != "" {
		chosen = tx.One("SELECT user_id,heartbeat FROM voice_members WHERE channel_id=? AND user_id=? AND eligible=1 AND heartbeat>=?", id, current["user_id"], now-15000)
	}
	if chosen == nil {
		chosen = tx.One("SELECT user_id,heartbeat FROM voice_members WHERE channel_id=? AND eligible=1 AND heartbeat>=? ORDER BY joined_at,user_id LIMIT 1", id, now-15000)
	}
	if current == nil && chosen == nil {
		return
	}
	changed := S(current["user_id"]) != S(chosen["user_id"]) || (current != nil && N(current["expires_at"]) < now && chosen != nil)
	epoch := N(current["epoch"])
	if changed || current == nil {
		epoch++
	}
	expiry := int64(0)
	if chosen != nil {
		expiry = N(chosen["heartbeat"]) + 15000
	}
	if current != nil && S(current["user_id"]) == S(chosen["user_id"]) && N(current["epoch"]) == epoch && N(current["expires_at"]) == expiry {
		return
	}
	tx.Run("INSERT INTO coordinators(channel_id,user_id,epoch,expires_at) VALUES(?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET user_id=excluded.user_id,epoch=excluded.epoch,expires_at=excluded.expires_at", id, serviceNullString(S(chosen["user_id"])), epoch, expiry)
}
func (s *Service) voiceDirectoryAt(uid string, tx *DB, now int64) []M {
	rooms := []M{}
	for _, ch := range tx.All("SELECT DISTINCT channel_id FROM voice_members WHERE heartbeat>=?", now-30000) {
		id := S(ch["channel_id"])
		if serviceAttempt(func() { s.Channel(tx, uid, id) }) != nil {
			continue
		}
		members := []M{}
		for _, vm := range tx.All("SELECT v.*,u.username,u.display_name,u.bio,u.avatar,u.status,u.rank_badge,u.profile_frame,u.profile_badge,u.profile_badge_award,u.catalog_avatar FROM voice_members v JOIN users u ON u.id=v.user_id WHERE v.channel_id=? AND v.heartbeat>=? ORDER BY v.joined_at", id, now-30000) {
			members = append(members, M{"user": PublicUser(Merge(vm, M{"id": vm["user_id"]})), "muted": B(vm["muted"]), "deafened": B(vm["deafened"]), "serverMuted": B(vm["server_muted"])})
		}
		shares := tx.One("SELECT COUNT(*) AS count FROM share_leases WHERE channel_id=? AND expires_at>=?", id, now)
		rooms = append(rooms, M{"channelId": id, "members": members, "shares": N(shares["count"])})
	}
	return rooms
}
func (s *Service) VoiceDirectory(uid string, connection ...*DB) []M {
	tx := s.DB
	if len(connection) > 0 {
		tx = connection[0]
	}
	return s.voiceDirectoryAt(uid, tx, Now())
}
func (s *Service) Room(uid, id string) M {
	return serviceResult(s.DB.Tx(func(tx *DB) any { s.Channel(tx, uid, id); s.MaintainRoom(tx, id); return s.RoomView(tx, id) }))
}
func (s *Service) RoomView(tx *DB, id string) M {
	members := []M{}
	for _, vm := range tx.All("SELECT v.*,u.username,u.display_name,u.bio,u.avatar,u.status,u.instance_admin,u.rank_badge,u.profile_frame,u.profile_badge,u.profile_badge_award,u.catalog_avatar FROM voice_members v JOIN users u ON u.id=v.user_id WHERE v.channel_id=? ORDER BY v.joined_at", id) {
		canShare := serviceAttempt(func() { s.Channel(tx, S(vm["user_id"]), id, "share") }) == nil
		members = append(members, M{"user": PublicUser(Merge(vm, M{"id": vm["user_id"]})), "muted": B(vm["muted"]), "deafened": B(vm["deafened"]), "serverMuted": B(vm["server_muted"]), "serverDeafened": B(vm["server_deafened"]), "canShare": canShare, "epoch": vm["epoch"], "eligible": B(vm["eligible"]), "joinedAt": N(vm["joined_at"])})
	}
	shares := []M{}
	for _, r := range tx.All("SELECT * FROM share_leases WHERE channel_id=? AND expires_at>=? ORDER BY started_at,id", id, Now()) {
		shares = append(shares, ShareView(r, s.C))
	}
	coordinator := tx.One("SELECT * FROM coordinators WHERE channel_id=?", id)
	return M{"channelId": id, "members": members, "shares": shares, "coordinatorId": serviceNullString(S(coordinator["user_id"])), "coordinatorEpoch": N(coordinator["epoch"]), "transport": s.C.MediaTransport}
}
func (s *Service) VoiceSnapshot(viewers []M) []M {
	return s.DB.Tx(func(tx *DB) any {
		tx = tx.Snapshot()
		ReconcileShares(tx, s.C)
		rooms := map[string]M{}
		now := Now()
		out := []M{}
		for _, v := range viewers {
			uid := S(v["userId"])
			entry := M{"socketId": v["socketId"], "directory": s.voiceDirectoryAt(uid, tx, now)}
			if S(v["channelId"]) != "" {
				entry["channelId"] = v["channelId"]
				entry["voiceEpoch"] = v["voiceEpoch"]
				entry["room"] = nil
				vm := tx.One("SELECT channel_id FROM voice_members WHERE user_id=? AND socket_id=?", uid, v["socketId"])
				if vm != nil {
					serviceAttempt(func() {
						id := S(vm["channel_id"])
						s.Channel(tx, uid, id)
						if rooms[id] == nil {
							rooms[id] = s.RoomView(tx, id)
						}
						entry["room"] = rooms[id]
					})
				}
			}
			out = append(out, entry)
		}
		return out
	}).([]M)
}
func (s *Service) IceServers(uid string) []M {
	out := []M{}
	if len(s.C.StunURLs) > 0 {
		out = append(out, M{"urls": s.C.StunURLs})
	}
	if len(s.C.TurnURLs) > 0 {
		username, credential := s.C.TurnUsername, s.C.TurnPassword
		if s.C.TurnSecret != "" {
			username = strconv.FormatInt(Now()/1000+3600, 10) + ":" + uid
			mac := hmac.New(sha1.New, []byte(s.C.TurnSecret))
			mac.Write([]byte(username))
			credential = base64.StdEncoding.EncodeToString(mac.Sum(nil))
		}
		out = append(out, M{"urls": s.C.TurnURLs, "username": username, "credential": credential})
	}
	return out
}
func (s *Service) JoinVoice(uid, socket, id string, eligible bool, session ...string) M {
	access := s.Channel(s.DB, uid, id)
	Check(S(access["kind"]) == "voice", 400, "NOT_VOICE", "Select a voice channel.")
	ice := s.IceServers(uid)
	if s.C.MediaTransport == "mesh" && s.cloudflareTurn != nil {
		ice = s.cloudflareTurn.ForUser(uid)
	}
	result := serviceResult(s.DB.Tx(func(tx *DB) any {
		Check(s.DirectCallBusy == nil || !s.DirectCallBusy(uid), 409, "CALL_BUSY", "End the direct call before joining voice.")
		if len(session) > 0 {
			Check(voiceSessionActive(tx, session[0], Now()), 401, "UNAUTHENTICATED", "Session expired.")
		}
		ch := s.Channel(tx, uid, id)
		Check(S(ch["kind"]) == "voice", 400, "NOT_VOICE", "Select a voice channel.")
		Check(N(ch["timeoutUntil"]) <= Now(), 403, "TIMED_OUT", "You are timed out in this server.")
		s.MaintainRoom(tx, id)
		previous := tx.One("SELECT * FROM voice_members WHERE user_id=?", uid)
		if previous != nil && S(previous["socket_id"]) == socket && S(previous["channel_id"]) == id {
			return M{"epoch": previous["epoch"], "room": s.RoomView(tx, id)}
		}
		count := N(tx.One("SELECT COUNT(*) AS count FROM voice_members WHERE channel_id=? AND user_id<>?", id, uid)["count"])
		Check(!B(ch["locked"]) || serviceIn(S(ch["role"]), "owner", "administrator"), 403, "VOICE_LOCKED", "This voice channel is locked.")
		Check(count < min(N(ch["user_limit"]), int64(s.C.MaxVoice)), 409, "ROOM_FULL", "Voice channel is full.")
		tx.Run("DELETE FROM voice_members WHERE user_id=?", uid)
		epoch := ID()
		now := Now()
		restriction := tx.One("SELECT * FROM voice_restrictions WHERE channel_id=? AND user_id=?", id, uid)
		serverMuted := !B(Obj(ch["permissions"])["speak"]) || B(restriction["muted"])
		tx.Run("INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,server_muted,server_deafened,eligible,heartbeat,joined_at) VALUES(?,?,?,?,?,?,?,?,?)", uid, id, socket, epoch, serviceBoolInt(serverMuted), serviceBoolInt(B(restriction["deafened"])), serviceBoolInt(eligible), now, now)
		if previous != nil && S(previous["channel_id"]) != id {
			s.MaintainRoom(tx, S(previous["channel_id"]))
		}
		s.MaintainRoom(tx, id)
		return M{"epoch": epoch, "room": s.RoomView(tx, id)}
	}))
	s.Notify("voice:changed", M{})
	result["iceServers"] = ice
	if s.cloudflareTurn != nil {
		result["iceServersExpiresAt"] = Now() + (CloudflareTurnTTL-60)*1000
	}
	return result
}
func (s *Service) VoiceAction(uid, socket, action string, body ...M) M {
	b := M{}
	if len(body) > 0 && body[0] != nil {
		b = body[0]
	}
	changed, removed := action == "leave", false
	result := serviceResult(s.DB.Tx(func(tx *DB) any {
		vm := tx.One("SELECT * FROM voice_members WHERE user_id=? AND socket_id=?", uid, socket)
		Check(vm != nil, 409, "NOT_IN_VOICE", "Voice session is no longer active.")
		if b["epoch"] != nil {
			Check(S(vm["epoch"]) == S(b["epoch"]), 409, "NOT_IN_VOICE", "Voice session is no longer active.")
		}
		id := S(vm["channel_id"])
		if action == "leave" {
			tx.Run("DELETE FROM voice_members WHERE user_id=?", uid)
		} else {
			if serviceAttempt(func() { s.Channel(tx, uid, id) }) != nil {
				tx.Run("DELETE FROM voice_members WHERE user_id=?", uid)
				removed = true
				return M{"removed": true}
			}
			state := M{}
			changed = false
			for _, k := range []string{"muted", "deafened", "eligible"} {
				state[k] = vm[k]
				if v, ok := b[k]; ok {
					state[k] = serviceBoolInt(B(v))
					if N(state[k]) != N(vm[k]) {
						changed = true
					}
				}
			}
			tx.Run("UPDATE voice_members SET heartbeat=?,muted=?,deafened=?,eligible=? WHERE user_id=?", Now(), state["muted"], state["deafened"], state["eligible"], uid)
			tx.Run("UPDATE share_leases SET expires_at=? WHERE user_id=? AND expires_at>=?", Now()+30000, uid, Now())
		}
		s.MaintainRoom(tx, id, s.C.MediaTransport != "livekit" || action == "leave")
		if action != "leave" && s.C.MediaTransport == "livekit" {
			return M{"alive": true}
		}
		return M{"room": s.RoomView(tx, id)}
	}))
	if removed || action == "leave" {
		s.Notify("voice:changed", M{})
	} else if action == "state" && changed {
		s.Notify("voice:state:changed", M{})
	}
	return result
}
func (s *Service) Share(uid, socket, rid string, stop, includeAudio bool, requestedHeight ...int64) M {
	operation := "share.start"
	if stop {
		operation = "share.stop"
	}
	audio := includeAudio && !stop
	height := int64(720)
	payload := M{"includeAudio": audio}
	if !stop && len(requestedHeight) > 0 && requestedHeight[0] == 1080 {
		height = 1080
		payload["height"] = height
	}
	result := s.Mutate(uid, rid, operation, payload, func(tx *DB) any {
		vm := tx.One("SELECT * FROM voice_members WHERE user_id=? AND socket_id=?", uid, socket)
		Check(vm != nil, 409, "NOT_IN_VOICE", "Join voice before sharing.")
		id := S(vm["channel_id"])
		if stop {
			tx.Run("DELETE FROM share_leases WHERE user_id=?", uid)
			ReconcileShares(tx, s.C)
			return M{"lease": nil}
		}
		s.Channel(tx, uid, id, "share")
		s.MaintainRoom(tx, id)
		if old := tx.One("SELECT * FROM share_leases WHERE user_id=?", uid); old != nil {
			return M{"lease": ShareView(old, s.C)}
		}
		global := N(tx.One("SELECT COUNT(*) AS count FROM share_leases")["count"])
		room := N(tx.One("SELECT COUNT(*) AS count FROM share_leases WHERE channel_id=?", id)["count"])
		Check((s.C.GlobalShares <= 0 || global < int64(s.C.GlobalShares)) && (s.C.RoomShares <= 0 || room < int64(s.C.RoomShares)), 409, "SHARE_LIMIT", "Screen-sharing capacity is full.")
		tier := "fallback"
		if N(tx.One("SELECT COUNT(*) AS count FROM share_leases WHERE tier='standard'")["count"]) < int64(s.C.StandardShareSlots) {
			tier = "standard"
		}
		Check(tier != "fallback" || room == 0, 409, "SHARE_LIMIT", "All three 30fps slots are occupied. This room already has a screen.")
		now := Now()
		lease := ID()
		bitrate := int64(0)
		if height == 1080 {
			bitrate = screenHDAdmission(tx, uid, s.C)
		}
		tx.Run("INSERT INTO share_leases(id,user_id,channel_id,expires_at,tier,started_at,requested_fps,include_audio,policy_revision,quality_height,quality_bitrate) VALUES(?,?,?,?,?,?,15,?,1,?,?)", lease, uid, id, now+30000, tier, now, serviceBoolInt(includeAudio), height, bitrate)
		return M{"lease": ShareView(tx.One("SELECT * FROM share_leases WHERE id=?", lease), s.C)}
	})
	s.Notify("voice:changed", M{})
	return serviceResult(result)
}
func (s *Service) UpdateShare(uid, socket, rid string, body M) M {
	result := s.Mutate(uid, rid, "share.update", body, func(tx *DB) any {
		ReconcileShares(tx, s.C)
		row := tx.One("SELECT s.* FROM share_leases s JOIN voice_members v ON v.user_id=s.user_id WHERE s.id=? AND s.user_id=? AND v.socket_id=? AND s.expires_at>=?", body["leaseId"], uid, socket, Now())
		Check(row != nil, 409, "SHARE_EXPIRED", "Screen sharing has stopped.")
		s.Channel(tx, uid, S(row["channel_id"]), "share")
		Check(N(row["policy_revision"]) == N(body["expectedRevision"]), 409, "STALE_SHARE", "Sharing limits changed. Try again.")
		height, bitrate := N(row["quality_height"]), N(row["quality_bitrate"])
		if requested := N(body["height"]); requested != 0 && requested != height {
			height, bitrate = requested, 0
			if height == 1080 {
				bitrate = screenHDAdmission(tx, uid, s.C)
			}
		}
		if N(body["frameRate"]) > 0 && height < 1080 {
			Check(N(body["frameRate"]) <= N(ShareView(Merge(row, M{"quality_height": height}), s.C)["maxFrameRate"]), 409, "SHARE_TIER", "30fps is not available for this share yet.")
		}
		fps := row["requested_fps"]
		if body["frameRate"] != nil {
			fps = body["frameRate"]
		}
		if height == 1080 {
			fps = 15
		}
		audio := row["include_audio"]
		if v, ok := body["includeAudio"]; ok && !B(v) {
			audio = 0
		}
		tx.Run("UPDATE share_leases SET requested_fps=?,include_audio=?,quality_height=?,quality_bitrate=?,policy_revision=policy_revision+1 WHERE id=?", fps, audio, height, bitrate, row["id"])
		return M{"lease": ShareView(tx.One("SELECT * FROM share_leases WHERE id=?", row["id"]), s.C)}
	})
	s.Notify("voice:changed", M{})
	return serviceResult(result)
}
func (s *Service) Moderate(uid, rid, id, targetID, action string) M {
	result := s.Mutate(uid, rid, "voice.moderate", M{"channelId": id, "targetId": targetID, "action": action}, func(tx *DB) any {
		ch := s.Channel(tx, uid, id, "moderate")
		target := s.Member(tx, targetID, S(ch["server_id"]))
		actor := tx.One("SELECT instance_admin FROM users WHERE id=?", uid)
		targetAccount := tx.One("SELECT instance_admin FROM users WHERE id=?", targetID)
		if !B(actor["instance_admin"]) {
			Check(!B(targetAccount["instance_admin"]) && (uid == targetID || CanManage(s.Authority(tx, M{"role": ch["role"], "user_id": uid, "server_id": ch["server_id"]}), s.Authority(tx, target))), 403, "HIERARCHY", "Cannot moderate this member.")
		}
		Check(tx.One("SELECT user_id FROM voice_members WHERE channel_id=? AND user_id=?", id, targetID) != nil, 409, "NOT_IN_VOICE", "The participant has left this channel.")
		if serviceIn(action, "mute", "unmute", "deafen", "undeafen", "denyShare", "allowShare") {
			tx.Run("INSERT INTO voice_restrictions(channel_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING", id, targetID)
			switch action {
			case "mute", "unmute":
				tx.Run("UPDATE voice_restrictions SET muted=? WHERE channel_id=? AND user_id=?", serviceBoolInt(action == "mute"), id, targetID)
			case "deafen", "undeafen":
				tx.Run("UPDATE voice_restrictions SET deafened=? WHERE channel_id=? AND user_id=?", serviceBoolInt(action == "deafen"), id, targetID)
			case "denyShare", "allowShare":
				tx.Run("UPDATE voice_restrictions SET sharing_allowed=? WHERE channel_id=? AND user_id=?", serviceBoolInt(action == "allowShare"), id, targetID)
			}
		}
		if action == "kick" {
			tx.Run("DELETE FROM voice_members WHERE channel_id=? AND user_id=?", id, targetID)
		}
		if action == "stopShare" || action == "denyShare" {
			tx.Run("DELETE FROM share_leases WHERE channel_id=? AND user_id=?", id, targetID)
		}
		if action == "mute" || action == "unmute" {
			if action == "unmute" {
				s.Channel(tx, targetID, id, "speak")
			}
			tx.Run("UPDATE voice_members SET server_muted=? WHERE channel_id=? AND user_id=?", serviceBoolInt(action == "mute"), id, targetID)
		}
		if action == "deafen" || action == "undeafen" {
			tx.Run("UPDATE voice_members SET server_deafened=? WHERE channel_id=? AND user_id=?", serviceBoolInt(action == "deafen"), id, targetID)
		}
		Audit(tx, uid, "voice."+action, targetID, M{"channelId": id})
		s.MaintainRoom(tx, id)
		return M{"success": true}
	})
	s.Notify("voice:changed", M{})
	return serviceResult(result)
}
func (s *Service) RevalidateVoice(tx *DB, server string) {
	for _, vm := range tx.All("SELECT v.* FROM voice_members v JOIN channels c ON c.id=v.channel_id WHERE c.server_id=?", server) {
		if serviceAttempt(func() {
			access := s.Channel(tx, S(vm["user_id"]), S(vm["channel_id"]))
			restriction := tx.One("SELECT muted FROM voice_restrictions WHERE channel_id=? AND user_id=?", vm["channel_id"], vm["user_id"])
			tx.Run("UPDATE voice_members SET server_muted=? WHERE user_id=?", serviceBoolInt(!B(Obj(access["permissions"])["speak"]) || B(restriction["muted"])), vm["user_id"])
			if !B(Obj(access["permissions"])["share"]) {
				tx.Run("DELETE FROM share_leases WHERE user_id=?", vm["user_id"])
			}
		}) != nil {
			tx.Run("DELETE FROM voice_members WHERE user_id=?", vm["user_id"])
		}
	}
}
func (s *Service) VoicePolicy(uid, rid, id string, body M) M {
	result := s.Mutate(uid, rid, "voice.policy", servicePayload(M{"channelId": id}, body), func(tx *DB) any {
		ch := s.Channel(tx, uid, id, "manageChannels")
		Check(S(ch["kind"]) == "voice", 400, "NOT_VOICE", "Select a voice channel.")
		tags := serviceStrings(body["requiredTags"])
		for _, tag := range tags {
			Check(tx.One("SELECT id FROM tags WHERE id=? AND server_id=?", tag, ch["server_id"]) != nil, 400, "INVALID_TAG", "Tags must belong to this server.")
		}
		tx.Run("UPDATE channels SET locked=?,user_limit=?,tag_mode=? WHERE id=?", serviceBoolInt(B(body["locked"])), min(N(body["userLimit"]), int64(s.C.MaxVoice)), body["tagMode"], id)
		tx.Run("DELETE FROM channel_tags WHERE channel_id=?", id)
		for _, tag := range serviceUnique(tags) {
			tx.Run("INSERT INTO channel_tags(channel_id,tag_id) VALUES(?,?)", id, tag)
		}
		s.RevalidateVoice(tx, S(ch["server_id"]))
		Audit(tx, uid, "voice.policy", id, body)
		return M{"success": true}
	})
	s.Notify("state:changed", M{})
	s.Notify("voice:changed", M{})
	return serviceResult(result)
}
func (s *Service) MoveVoice(uid, rid, from, targetID, to string) M {
	result := s.Mutate(uid, rid, "voice.move", M{"fromChannel": from, "targetId": targetID, "toChannel": to}, func(tx *DB) any {
		source := s.Channel(tx, uid, from, "moderate")
		destination := s.Channel(tx, uid, to, "moderate")
		target := s.Member(tx, targetID, S(source["server_id"]))
		actor := tx.One("SELECT instance_admin FROM users WHERE id=?", uid)
		Check(S(source["server_id"]) == S(destination["server_id"]) && S(destination["kind"]) == "voice" && from != to, 400, "INVALID_MOVE", "Choose another voice channel in this server.")
		if !B(actor["instance_admin"]) {
			Check(!B(tx.One("SELECT instance_admin FROM users WHERE id=?", targetID)["instance_admin"]) && CanMoveMember(s.Authority(tx, M{"role": source["role"], "user_id": uid, "server_id": source["server_id"]}), s.Authority(tx, target)), 403, "HIERARCHY", "Cannot move this member.")
		}
		access := s.Channel(tx, targetID, to)
		Check(N(access["timeoutUntil"]) <= Now(), 403, "TIMED_OUT", "This member is timed out.")
		Check(!B(access["locked"]) || serviceIn(S(access["role"]), "owner", "administrator"), 403, "VOICE_LOCKED", "The destination is locked.")
		s.MaintainRoom(tx, to)
		Check(N(tx.One("SELECT COUNT(*) AS count FROM voice_members WHERE channel_id=?", to)["count"]) < min(N(access["user_limit"]), int64(s.C.MaxVoice)), 409, "ROOM_FULL", "The destination is full.")
		vm := tx.One("SELECT * FROM voice_members WHERE user_id=? AND channel_id=?", targetID, from)
		Check(vm != nil, 409, "NOT_IN_VOICE", "The participant has left this channel.")
		tx.Run("DELETE FROM voice_members WHERE user_id=?", targetID)
		Audit(tx, uid, "voice.move", targetID, M{"fromChannel": from, "toChannel": to})
		return M{"socketId": vm["socket_id"], "channelId": to}
	})
	s.Notify("voice:move", result)
	s.Notify("voice:changed", M{})
	return M{"success": true}
}
func (s *Service) Cleanup(retention ...bool) {
	expired := false
	s.DB.Tx(func(tx *DB) any {
		now := Now()
		if tx.One("SELECT user_id FROM server_timeouts WHERE expires_at<=? LIMIT 1", now) != nil {
			tx.Run("DELETE FROM server_timeouts WHERE expires_at<=?", now)
			expired = true
		}
		if len(retention) == 0 || retention[0] {
			tx.Run("DELETE FROM recovery_attempts WHERE expires_at<?", now)
			tx.Run("DELETE FROM sessions WHERE expires_at<?", now)
			tx.Run("DELETE FROM used_refresh WHERE expires_at<?", now)
			tx.Run("DELETE FROM invites WHERE expires_at<? OR remaining<1", now)
			tx.Run("DELETE FROM mutations WHERE created_at<?", now-86400000)
			tx.Run("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE created_at<? ORDER BY created_at LIMIT 1000)", now-7*86400000)
			tx.Run("DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE created_at<? ORDER BY created_at LIMIT 500)", now-int64(s.C.RetentionDays)*86400000)
		}
		s.ExpireVoice(tx, now)
		for _, ch := range tx.All("SELECT channel_id AS id FROM voice_members UNION SELECT channel_id AS id FROM coordinators WHERE user_id IS NOT NULL") {
			s.MaintainRoom(tx, S(ch["id"]), false)
		}
		return nil
	})
	if expired {
		s.Notify("state:changed", M{})
	}
}
