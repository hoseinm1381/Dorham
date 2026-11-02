package backend

import "sort"

func (s *Service) Bootstrap(uid string) M {
	return serviceResult(s.DB.Tx(func(tx *DB) any {
		tx = tx.Snapshot()
		me := tx.One("SELECT * FROM users WHERE id=?", uid)
		Check(me != nil, 403, "FORBIDDEN", "Account access is unavailable.")
		admin := me["instance_admin"]
		servers := []M{}
		for _, r := range tx.All("SELECT s.*,m.role FROM servers s LEFT JOIN members m ON m.server_id=s.id AND m.user_id=? WHERE m.user_id IS NOT NULL OR ?=1 ORDER BY s.created_at", uid, admin) {
			role := S(r["role"])
			if B(admin) {
				role = "owner"
			}
			servers = append(servers, M{"id": r["id"], "name": r["name"], "ownerId": r["owner_id"], "icon": r["icon"], "role": role, "allowGuests": B(r["allow_guests"]), "allowMemberInvites": B(r["allow_member_invites"]), "permissions": s.MemberPermissions(tx, role, uid, S(r["id"]))})
		}
		channels := []M{}
		for _, r := range tx.All("SELECT c.* FROM channels c LEFT JOIN members m ON c.server_id=m.server_id AND m.user_id=? WHERE m.user_id IS NOT NULL OR ?=1 ORDER BY c.created_at", uid, admin) {
			serviceAttempt(func() {
				access := s.Channel(tx, uid, S(r["id"]))
				tags := []string{}
				for _, t := range tx.All("SELECT tag_id FROM channel_tags WHERE channel_id=?", r["id"]) {
					tags = append(tags, S(t["tag_id"]))
				}
				channels = append(channels, M{"id": r["id"], "serverId": r["server_id"], "name": r["name"], "kind": r["kind"], "conversationId": r["conversation_id"], "permissions": access["permissions"], "locked": B(r["locked"]), "userLimit": min(N(r["user_limit"]), int64(s.C.MaxVoice)), "tagMode": r["tag_mode"], "timeoutUntil": access["timeoutUntil"], "requiredTags": tags})
			})
		}
		blocked := []M{}
		blockedByMe := map[string]bool{}
		for _, r := range tx.All("SELECT u.* FROM users u JOIN user_blocks b ON b.blocked_id=u.id WHERE b.user_id=?", uid) {
			blocked = append(blocked, PublicUser(r))
			blockedByMe[S(r["id"])] = true
		}
		peers := map[string]bool{}
		for _, b := range tx.All("SELECT user_id,blocked_id FROM user_blocks WHERE user_id=? OR blocked_id=?", uid, uid) {
			other := S(b["user_id"])
			if other == uid {
				other = S(b["blocked_id"])
			}
			peers[other] = true
		}
		dms := []M{}
		conversations := []string{}
		for _, ch := range channels {
			if id := S(ch["conversationId"]); id != "" {
				conversations = append(conversations, id)
			}
		}
		for _, d := range tx.All("SELECT d.conversation_id,u.id,u.username,u.display_name,u.bio,u.avatar,u.status,u.instance_admin,(SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id=d.conversation_id) AS last_message_at FROM dm_members d JOIN dm_members other ON other.conversation_id=d.conversation_id AND other.user_id<>d.user_id JOIN users u ON u.id=other.user_id WHERE d.user_id=? AND d.hidden=0 ORDER BY last_message_at DESC,d.conversation_id", uid) {
			dms = append(dms, M{"id": d["conversation_id"], "lastMessageAt": N(d["last_message_at"]), "user": PublicUser(d), "blocked": peers[S(d["id"])], "blockedByMe": blockedByMe[S(d["id"])]})
			conversations = append(conversations, S(d["conversation_id"]))
		}
		unread := M{}
		for _, id := range conversations {
			unread[id] = M{"sequence": int64(0), "readSequence": int64(0)}
		}
		if len(conversations) > 0 {
			args := make([]any, len(conversations))
			for i, id := range conversations {
				args[i] = id
			}
			in := servicePlaceholders(len(args))
			for _, row := range tx.All("SELECT conversation_id,MAX(sequence) AS sequence FROM messages WHERE deleted=0 AND conversation_id IN ("+in+") GROUP BY conversation_id", args...) {
				Obj(unread[S(row["conversation_id"])])["sequence"] = N(row["sequence"])
			}
			for _, row := range tx.All("SELECT conversation_id,sequence FROM read_cursors WHERE conversation_id IN ("+in+") AND user_id=?", append(args, uid)...) {
				Obj(unread[S(row["conversation_id"])])["readSequence"] = N(row["sequence"])
			}
		}
		users := []M{}
		for _, u := range tx.All("SELECT * FROM users ORDER BY username LIMIT 250") {
			users = append(users, PublicUser(u))
		}
		return M{"me": PublicUser(me), "servers": servers, "channels": channels, "voicePresence": s.VoiceDirectory(uid, tx), "dms": dms, "blockedUsers": blocked, "users": users, "unread": unread, "mediaTransport": s.C.MediaTransport, "screenPolicy": M{"maxBitrate": s.C.ScreenMaxBitrate, "maxFrameRate": s.C.ScreenMaxFrameRate}, "limits": M{"users": s.C.MaxUsers, "online": s.C.MaxOnline, "voice": s.C.MaxVoice, "roomShares": s.C.RoomShares, "globalShares": s.C.GlobalShares}}
	}))
}
func (s *Service) InsertChannel(tx *DB, server, name, kind string) M {
	id := ID()
	var conversation any
	if kind == "text" {
		conversation = ID()
		tx.Run("INSERT INTO conversations(id,kind,created_at) VALUES(?,?,?)", conversation, "channel", Now())
	}
	tx.Run("INSERT INTO channels(id,server_id,name,kind,conversation_id,created_at) VALUES(?,?,?,?,?,?)", id, server, name, kind, conversation, Now())
	return M{"id": id}
}
func (s *Service) CreateServer(uid, rid, name string) M {
	r := s.Mutate(uid, rid, "server.create", M{"name": name}, func(tx *DB) any {
		Check(!B(tx.One("SELECT guest FROM users WHERE id=?", uid)["guest"]), 403, "GUEST_ACCOUNT", "Register before creating a server.")
		Check(N(tx.One("SELECT COUNT(*) AS count FROM members WHERE user_id=?", uid)["count"]) < 20, 409, "LIMIT", "You may join at most 20 servers.")
		id := ID()
		now := Now()
		tx.Run("INSERT INTO servers(id,name,owner_id,created_at) VALUES(?,?,?,?)", id, name, uid, now)
		tx.Run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES(?,?,?,?)", id, uid, "owner", now)
		s.InsertChannel(tx, id, "general", "text")
		s.InsertChannel(tx, id, "Lounge", "voice")
		return M{"id": id}
	})
	s.Notify("state:changed", M{})
	return serviceResult(r)
}
func (s *Service) ChangeServer(uid, rid, id string, body M) M {
	r := s.Mutate(uid, rid, "server.change", servicePayload(M{"serverId": id}, body), func(tx *DB) any {
		m := s.Member(tx, uid, id, "manageChannels")
		if _, ok := body["allowMemberInvites"]; ok {
			Check(S(m["role"]) == "owner", 403, "FORBIDDEN", "Only the owner can change member invitations.")
		}
		if B(body["delete"]) {
			Check(S(m["role"]) == "owner", 403, "FORBIDDEN", "Only the owner can delete a server.")
			cvs := tx.All("SELECT conversation_id FROM channels WHERE server_id=?", id)
			tx.Run("DELETE FROM servers WHERE id=?", id)
			for _, cv := range cvs {
				if cv["conversation_id"] != nil {
					tx.Run("DELETE FROM conversations WHERE id=?", cv["conversation_id"])
				}
			}
		} else {
			if name := S(body["name"]); name != "" {
				tx.Run("UPDATE servers SET name=? WHERE id=?", name, id)
			}
			if v, ok := body["allowGuests"]; ok {
				tx.Run("UPDATE servers SET allow_guests=? WHERE id=?", serviceBoolInt(B(v)), id)
				s.RevalidateVoice(tx, id)
			}
			if v, ok := body["allowMemberInvites"]; ok {
				tx.Run("UPDATE servers SET allow_member_invites=? WHERE id=?", serviceBoolInt(B(v)), id)
			}
		}
		audit := M{"delete": B(body["delete"])}
		for _, k := range []string{"allowGuests", "allowMemberInvites"} {
			if v, ok := body[k]; ok {
				audit[k] = v
			}
		}
		Audit(tx, uid, "server.change", id, audit)
		return M{"success": true}
	})
	s.Notify("state:changed", M{})
	s.Notify("voice:changed", M{})
	return serviceResult(r)
}
func (s *Service) CreateChannel(uid, rid, server, name, kind string) M {
	r := s.Mutate(uid, rid, "channel.create", M{"serverId": server, "name": name, "kind": kind}, func(tx *DB) any {
		s.Member(tx, uid, server, "manageChannels")
		Check(N(tx.One("SELECT COUNT(*) AS count FROM channels WHERE server_id=?", server)["count"]) < 50, 409, "LIMIT", "Server channel limit reached.")
		return s.InsertChannel(tx, server, name, kind)
	})
	s.Notify("state:changed", M{})
	return serviceResult(r)
}
func (s *Service) ChannelOverrides(uid, id, role string) M {
	ch := s.Channel(s.DB, uid, id, "manageChannels")
	Check(CanManage(S(ch["role"]), role), 403, "HIERARCHY", "You cannot manage this role.")
	r := s.DB.One("SELECT permissions,revision FROM channel_overrides WHERE channel_id=? AND role=?", id, role)
	p := M{}
	if r != nil {
		p = Obj(Parse(S(r["permissions"])))
	}
	return M{"channelId": id, "role": role, "revision": N(r["revision"]), "permissions": p}
}
func (s *Service) ChangeChannel(uid, rid, id string, body M) M {
	r := s.Mutate(uid, rid, "channel.change", servicePayload(M{"channelId": id}, body), func(tx *DB) any {
		ch := s.Channel(tx, uid, id, "manageChannels")
		if role := S(body["role"]); role != "" {
			Check(CanManage(S(ch["role"]), role), 403, "HIERARCHY", "You cannot manage this role.")
		}
		if B(body["delete"]) {
			tx.Run("DELETE FROM channels WHERE id=?", id)
			if ch["conversation_id"] != nil {
				tx.Run("DELETE FROM conversations WHERE id=?", ch["conversation_id"])
			}
		} else {
			if name := S(body["name"]); name != "" {
				tx.Run("UPDATE channels SET name=? WHERE id=?", name, id)
			}
			if role := S(body["role"]); role != "" && body["permissions"] != nil {
				revision, ok := body["expectedRevision"]
				Check(ok, 428, "UPGRADE_REQUIRED", "Update Dorham before editing channel permissions.")
				old := tx.One("SELECT revision FROM channel_overrides WHERE channel_id=? AND role=?", id, role)
				Check(N(old["revision"]) == N(revision), 409, "STALE_PERMISSIONS", "Permissions changed. Reload them before saving.")
				tx.Run("INSERT INTO channel_overrides(channel_id,role,permissions,revision) VALUES(?,?,?,?) ON CONFLICT(channel_id,role) DO UPDATE SET permissions=excluded.permissions,revision=excluded.revision", id, role, JSON(body["permissions"]), N(revision)+1)
			}
			for _, vm := range tx.All("SELECT * FROM voice_members WHERE channel_id=?", id) {
				target := S(vm["user_id"])
				if serviceAttempt(func() { s.Channel(tx, target, id) }) != nil {
					tx.Run("DELETE FROM voice_members WHERE user_id=?", target)
					continue
				}
				if serviceAttempt(func() { s.Channel(tx, target, id, "speak") }) != nil {
					tx.Run("UPDATE voice_members SET server_muted=1 WHERE user_id=?", target)
				}
				if serviceAttempt(func() { s.Channel(tx, target, id, "share") }) != nil {
					tx.Run("DELETE FROM share_leases WHERE user_id=?", target)
				}
			}
		}
		return M{"success": true}
	})
	s.Notify("state:changed", M{})
	s.Notify("voice:changed", M{})
	return serviceResult(r)
}
func (s *Service) Invite(uid, rid, server, value string, hours, uses int, channel ...string) M {
	payload := M{"serverId": server, "expiresHours": hours, "uses": uses}
	ch := ""
	if len(channel) > 0 && channel[0] != "" {
		ch = channel[0]
		payload["channelId"] = ch
	}
	return serviceResult(s.Mutate(uid, rid, "invite.create", payload, func(tx *DB) any {
		s.Member(tx, uid, server, "createInvites")
		Check(N(tx.One("SELECT COUNT(*) AS count FROM invites WHERE server_id=? AND expires_at>? AND remaining>0", server, Now())["count"]) < 50, 409, "LIMIT", "Revoke an active invitation before creating another.")
		if ch != "" {
			access := s.Channel(tx, uid, ch)
			Check(S(access["server_id"]) == server, 400, "INVALID_CHANNEL", "Choose a channel in this server.")
		}
		tx.Run("INSERT INTO invites(hash,server_id,expires_at,remaining,created_by,code,channel_id) VALUES(?,?,?,?,?,?,?)", Hash(value), server, Now()+int64(hours)*3600000, uses, uid, value, serviceNullString(ch))
		return M{"code": value, "url": s.C.PublicURL + "/?invite=" + value}
	}))
}
func (s *Service) Invitations(uid, server string) M {
	return serviceResult(s.DB.Tx(func(tx *DB) any {
		m := s.Member(tx, uid, server, "createInvites")
		all := s.Authority(tx, m) != "member"
		query := "SELECT code,expires_at,remaining,channel_id FROM invites WHERE server_id=? AND expires_at>? AND remaining>0 AND code IS NOT NULL"
		args := []any{server, Now()}
		if !all {
			query += " AND created_by=?"
			args = append(args, uid)
		}
		query += " ORDER BY expires_at DESC"
		out := []M{}
		for _, r := range tx.All(query, args...) {
			out = append(out, M{"code": r["code"], "url": s.C.PublicURL + "/?invite=" + S(r["code"]), "expiresAt": N(r["expires_at"]), "remaining": r["remaining"], "channelId": r["channel_id"]})
		}
		return M{"invites": out}
	}))
}
func (s *Service) RevokeInvitation(uid, rid, server, code string) M {
	return serviceResult(s.Mutate(uid, rid, "invite.revoke", M{"serverId": server, "code": code}, func(tx *DB) any {
		m := s.Member(tx, uid, server, "createInvites")
		all := s.Authority(tx, m) != "member"
		r := tx.One("SELECT created_by FROM invites WHERE server_id=? AND hash=?", server, Hash(code))
		Check(r == nil || all || S(r["created_by"]) == uid, 403, "FORBIDDEN", "You can revoke only your own invitations.")
		tx.Run("DELETE FROM invites WHERE server_id=? AND hash=?", server, Hash(code))
		Audit(tx, uid, "invite.revoke", server, nil)
		return M{"success": true}
	}))
}
func (s *Service) JoinInvite(uid, rid, code string) M {
	r := s.Mutate(uid, rid, "invite.join", M{"code": code}, func(tx *DB) any {
		inv := tx.One("SELECT * FROM invites WHERE hash=?", Hash(code))
		Check(inv != nil && N(inv["expires_at"]) >= Now() && N(inv["remaining"]) >= 1, 404, "INVITE_EXPIRED", "Invite is invalid, expired, or exhausted.")
		server := S(inv["server_id"])
		Check(tx.One("SELECT user_id FROM server_bans WHERE server_id=? AND user_id=?", server, uid) == nil, 403, "SERVER_BANNED", "You are banned from this server.")
		if B(tx.One("SELECT guest FROM users WHERE id=?", uid)["guest"]) {
			Check(B(tx.One("SELECT allow_guests FROM servers WHERE id=?", server)["allow_guests"]), 403, "GUESTS_DISABLED", "This server does not allow guests.")
		}
		result := M{"id": server, "channelId": inv["channel_id"]}
		if tx.One("SELECT role FROM members WHERE user_id=? AND server_id=?", uid, server) != nil {
			return result
		}
		Check(N(tx.One("SELECT COUNT(*) AS count FROM members WHERE user_id=?", uid)["count"]) < 20, 409, "LIMIT", "Server membership limit reached.")
		tx.Run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES(?,?,?,?)", server, uid, "member", Now())
		tx.Run("UPDATE invites SET remaining=remaining-1 WHERE hash=?", Hash(code))
		return result
	})
	s.Notify("state:changed", M{})
	return serviceResult(r)
}
func (s *Service) Members(uid, server string) []M {
	s.Member(s.DB, uid, server)
	out := []M{}
	for _, u := range s.DB.All("SELECT u.*,m.role,COALESCE(t.expires_at,0) AS timeout_until FROM members m JOIN users u ON u.id=m.user_id LEFT JOIN server_timeouts t ON t.server_id=m.server_id AND t.user_id=m.user_id WHERE m.server_id=? ORDER BY m.joined_at", server) {
		tags := []M{}
		for _, t := range s.DB.All("SELECT t.* FROM tags t JOIN user_tags ut ON ut.tag_id=t.id WHERE ut.user_id=? AND t.server_id=?", u["id"], server) {
			tags = append(tags, M{"id": t["id"], "serverId": t["server_id"], "name": t["name"], "color": t["color"]})
		}
		authority := "owner"
		if !B(u["instance_admin"]) {
			authority = s.Authority(s.DB, M{"role": u["role"], "user_id": u["id"], "server_id": server})
		}
		out = append(out, M{"user": Merge(PublicUser(u), M{"tags": tags}), "role": u["role"], "timeoutUntil": N(u["timeout_until"]), "authority": authority, "customRoles": s.AssignedRoles(s.DB, S(u["id"]), server)})
	}
	return out
}
func (s *Service) CustomRoles(uid, server string) M {
	s.Member(s.DB, uid, server)
	roles := []M{}
	for _, r := range s.DB.All("SELECT * FROM custom_roles WHERE server_id=? ORDER BY name", server) {
		roles = append(roles, M{"id": r["id"], "serverId": server, "name": r["name"], "color": r["color"], "permissions": Parse(S(r["permissions"]))})
	}
	return M{"roles": roles}
}
func (s *Service) ChangeCustomRole(uid, rid, server string, body M) M {
	r := s.Mutate(uid, rid, "role.change", servicePayload(M{"serverId": server}, body), func(tx *DB) any {
		actor := s.Member(tx, uid, server)
		Check(serviceIn(S(actor["role"]), "owner", "administrator") && !B(tx.One("SELECT guest FROM users WHERE id=?", uid)["guest"]), 403, "FORBIDDEN", "Only owners and administrators can manage custom roles.")
		id := S(body["roleId"])
		var existing M
		if id != "" {
			existing = tx.One("SELECT * FROM custom_roles WHERE id=? AND server_id=?", id, server)
			Check(existing != nil, 404, "NOT_FOUND", "Role not found.")
		} else {
			id = ID()
		}
		if targetID := S(body["userId"]); targetID != "" {
			_, assignedSet := body["assigned"]
			Check(existing != nil && assignedSet, 400, "INVALID_ROLE", "Choose a role and assignment.")
			target := s.Member(tx, targetID, server)
			Check(tx.One("SELECT user_id FROM members WHERE server_id=? AND user_id=?", server, targetID) != nil, 404, "NOT_FOUND", "Member not found.")
			Check(S(actor["role"]) == "owner" || CanManage(S(actor["role"]), S(target["role"])), 403, "HIERARCHY", "You cannot manage this member.")
			Check(!B(tx.One("SELECT guest FROM users WHERE id=?", targetID)["guest"]), 403, "GUEST_ROLE", "Register the guest before assigning custom roles.")
			if B(body["assigned"]) {
				tx.Run("INSERT INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?) ON CONFLICT DO NOTHING", server, targetID, id)
			} else {
				tx.Run("DELETE FROM member_roles WHERE server_id=? AND user_id=? AND role_id=?", server, targetID, id)
			}
		} else if B(body["delete"]) {
			Check(existing != nil, 404, "NOT_FOUND", "Role not found.")
			tx.Run("DELETE FROM custom_roles WHERE id=?", id)
		} else {
			Check(S(body["name"]) != "" && S(body["color"]) != "" && body["permissions"] != nil, 400, "INVALID_ROLE", "Set a name, color and permissions.")
			Check(tx.One("SELECT id FROM custom_roles WHERE server_id=? AND name=? AND id<>?", server, body["name"], id) == nil, 409, "ROLE_NAME", "A role with this name already exists.")
			if existing == nil {
				Check(N(tx.One("SELECT COUNT(*) AS count FROM custom_roles WHERE server_id=?", server)["count"]) < 32, 409, "LIMIT", "A server can have up to 32 custom roles.")
			}
			tx.Run("INSERT INTO custom_roles(id,server_id,name,color,permissions) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,permissions=excluded.permissions", id, server, body["name"], body["color"], JSON(body["permissions"]))
		}
		s.RevalidateVoice(tx, server)
		Audit(tx, uid, "role.change", id, servicePayload(M{"serverId": server}, body))
		return M{"id": id}
	})
	s.Notify("state:changed", M{})
	s.Notify("voice:changed", M{})
	return serviceResult(r)
}
func (s *Service) ChangeMember(actorID, rid, server, targetID string, body M) M {
	r := s.Mutate(actorID, rid, "member.change", servicePayload(M{"serverId": server, "targetId": targetID}, body), func(tx *DB) any {
		actor := s.Member(tx, actorID, server, "manageMembers")
		target := s.Member(tx, targetID, server)
		role := S(body["role"])
		if role != "" && role != "member" {
			Check(!B(tx.One("SELECT guest FROM users WHERE id=?", targetID)["guest"]), 403, "GUEST_ROLE", "Register the guest before granting an administrative role.")
		}
		ar := s.Authority(tx, actor)
		Check((B(actor["globalAdmin"]) || !B(tx.One("SELECT instance_admin FROM users WHERE id=?", targetID)["instance_admin"])) && CanManage(ar, s.Authority(tx, target)) && (role == "" || (CanManage(ar, role) && role != "owner")), 403, "HIERARCHY", "You cannot manage this role.")
		if B(body["remove"]) {
			tx.Run("DELETE FROM members WHERE server_id=? AND user_id=?", server, targetID)
			tx.Run("DELETE FROM voice_members WHERE user_id=? AND channel_id IN (SELECT id FROM channels WHERE server_id=?)", targetID, server)
		} else {
			tx.Run("UPDATE members SET role=? WHERE server_id=? AND user_id=?", body["role"], server, targetID)
			if voice := tx.One("SELECT channel_id FROM voice_members WHERE user_id=? AND channel_id IN (SELECT id FROM channels WHERE server_id=?)", targetID, server); voice != nil {
				if serviceAttempt(func() {
					access := s.Channel(tx, targetID, S(voice["channel_id"]))
					p := Obj(access["permissions"])
					if !B(p["speak"]) {
						tx.Run("UPDATE voice_members SET server_muted=1 WHERE user_id=?", targetID)
					}
					if !B(p["share"]) {
						tx.Run("DELETE FROM share_leases WHERE user_id=?", targetID)
					}
				}) != nil {
					tx.Run("DELETE FROM voice_members WHERE user_id=?", targetID)
				}
			}
		}
		Audit(tx, actorID, "member.change", targetID, servicePayload(M{"serverId": server}, body))
		return M{"success": true}
	})
	s.Notify("state:changed", M{})
	s.Notify("voice:changed", M{})
	return serviceResult(r)
}
func (s *Service) LeaveServer(uid, rid, server string) M {
	r := s.Mutate(uid, rid, "server.leave", M{"serverId": server}, func(tx *DB) any {
		Check(S(tx.One("SELECT owner_id FROM servers WHERE id=?", server)["owner_id"]) != uid, 403, "OWNER_LEAVE", "Owners must delete their server before leaving.")
		Check(tx.One("SELECT user_id FROM members WHERE server_id=? AND user_id=?", server, uid) != nil, 404, "NOT_FOUND", "You are not a member of this server.")
		tx.Run("DELETE FROM voice_members WHERE user_id=? AND channel_id IN (SELECT id FROM channels WHERE server_id=?)", uid, server)
		tx.Run("DELETE FROM user_tags WHERE user_id=? AND tag_id IN (SELECT id FROM tags WHERE server_id=?)", uid, server)
		tx.Run("DELETE FROM members WHERE server_id=? AND user_id=?", server, uid)
		Audit(tx, uid, "server.leave", server, nil)
		return M{"success": true}
	})
	s.Notify("state:changed", M{})
	s.Notify("voice:changed", M{})
	return serviceResult(r)
}
func (s *Service) CloseDirectMessage(uid, rid, conversation string) M {
	r := s.Mutate(uid, rid, "dm.close", M{"conversationId": conversation}, func(tx *DB) any {
		cv := s.Conversation(tx, uid, conversation)
		Check(S(cv["kind"]) == "dm", 400, "NOT_DM", "Only a direct chat can be closed.")
		tx.Run("UPDATE dm_members SET hidden=1 WHERE conversation_id=? AND user_id=?", conversation, uid)
		tx.Run("INSERT INTO read_cursors(conversation_id,user_id,sequence) VALUES(?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET sequence=excluded.sequence", conversation, uid, cv["sequence"])
		return M{"success": true}
	})
	s.Notify("state:changed", M{})
	return serviceResult(r)
}
func (s *Service) BlockUser(uid, rid, target string, blocked bool) M {
	r := s.Mutate(uid, rid, "user.block", M{"targetId": target, "blocked": blocked}, func(tx *DB) any {
		Check(target != uid, 400, "SELF_BLOCK", "You cannot block yourself.")
		Check(tx.One("SELECT id FROM users WHERE id=?", target) != nil, 404, "NOT_FOUND", "Account not found.")
		if blocked {
			tx.Run("INSERT INTO user_blocks(user_id,blocked_id) VALUES(?,?) ON CONFLICT DO NOTHING", uid, target)
		} else {
			tx.Run("DELETE FROM user_blocks WHERE user_id=? AND blocked_id=?", uid, target)
		}
		return M{"success": true}
	})
	s.Notify("state:changed", M{})
	return serviceResult(r)
}
func (s *Service) DM(uid, rid, other string) M {
	return serviceResult(s.Mutate(uid, rid, "dm.create", M{"otherId": other}, func(tx *DB) any {
		Check(other != uid && tx.One("SELECT id FROM users WHERE id=?", other) != nil, 400, "INVALID_USER", "Select another registered user.")
		s.AllowDirectMessage(tx, uid, other)
		if N(tx.One("SELECT COUNT(*) AS count FROM users WHERE id IN (?,?) AND guest=1", uid, other)["count"]) > 0 {
			Check(tx.One("SELECT a.server_id FROM members a JOIN members b ON a.server_id=b.server_id JOIN servers s ON s.id=a.server_id WHERE a.user_id=? AND b.user_id=? AND s.allow_guests=1", uid, other) != nil, 403, "GUEST_DM", "Guests can message only people in a shared guest-enabled server.")
		}
		pair := []string{uid, other}
		sort.Strings(pair)
		key := pair[0] + ":" + pair[1]
		if old := tx.One("SELECT conversation_id FROM dm_pairs WHERE pair_key=?", key); old != nil {
			tx.Run("UPDATE dm_members SET hidden=0 WHERE conversation_id=? AND user_id=?", old["conversation_id"], uid)
			return M{"id": old["conversation_id"]}
		}
		id := ID()
		tx.Run("INSERT INTO conversations(id,kind,created_at) VALUES(?,?,?)", id, "dm", Now())
		for _, u := range []string{uid, other} {
			tx.Run("INSERT INTO dm_members(conversation_id,user_id) VALUES(?,?)", id, u)
		}
		tx.Run("INSERT INTO dm_pairs(pair_key,conversation_id) VALUES(?,?)", key, id)
		return M{"id": id}
	}))
}
