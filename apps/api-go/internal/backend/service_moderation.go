package backend

func serviceAuthorizationError(err any) bool {
	switch e := err.(type) {
	case APIError:
		return e.Status == 403 || e.Status == 404
	case *APIError:
		return e.Status == 403 || e.Status == 404
	}
	return false
}
func (s *Service) moderationPowers(tx *DB, actorID, server, targetID string) (M, string, M) {
	actor := s.Member(tx, actorID, server)
	target := s.Member(tx, targetID, server)
	actorRole, targetRole := s.Authority(tx, actor), s.Authority(tx, target)
	p := s.MemberPermissions(tx, S(actor["role"]), actorID, server)
	account := tx.One("SELECT instance_admin FROM users WHERE id=?", targetID)
	protected := actorID == targetID || (!B(actor["globalAdmin"]) && B(account["instance_admin"]))
	higher := !protected && CanManage(actorRole, targetRole)
	return target, targetRole, M{"voice": B(p["moderate"]) && higher, "move": B(p["moderate"]) && !protected && CanMoveMember(actorRole, targetRole), "timeout": B(p["moderate"]) && higher, "kick": B(p["manageMembers"]) && higher, "ban": B(p["manageMembers"]) && higher}
}
func (s *Service) ModerationInfo(actor, server, targetID string) M {
	return serviceResult(s.DB.Tx(func(tx *DB) any {
		target, role, actions := s.moderationPowers(tx, actor, server, targetID)
		vm := tx.One("SELECT v.* FROM voice_members v JOIN channels c ON c.id=v.channel_id WHERE v.user_id=? AND c.server_id=?", targetID, server)
		var voice any
		if vm != nil {
			restriction := tx.One("SELECT sharing_allowed FROM voice_restrictions WHERE user_id=? AND channel_id=?", targetID, vm["channel_id"])
			voice = M{"channelId": vm["channel_id"], "serverMuted": B(vm["server_muted"]), "serverDeafened": B(vm["server_deafened"]), "sharingAllowed": restriction == nil || N(restriction["sharing_allowed"]) != 0}
		}
		return M{"userId": targetID, "role": role, "timeoutUntil": N(target["timeout_until"]), "actions": actions, "voice": voice}
	}))
}
func (s *Service) ModerateMember(actor, rid, server, targetID string, body M) M {
	result := s.Mutate(actor, rid, "member.moderate", servicePayload(M{"serverId": server, "targetId": targetID}, body), func(tx *DB) any {
		action := S(body["action"])
		if action == "unban" {
			m := s.Member(tx, actor, server, "manageMembers")
			ban := tx.One("SELECT * FROM server_bans WHERE server_id=? AND user_id=?", server, targetID)
			Check(ban != nil, 404, "NOT_BANNED", "This user is not banned from this server.")
			Check(CanManage(s.Authority(tx, m), S(ban["target_role"])), 403, "HIERARCHY", "You cannot manage this role.")
			tx.Run("DELETE FROM server_bans WHERE server_id=? AND user_id=?", server, targetID)
		} else {
			_, role, actions := s.moderationPowers(tx, actor, server, targetID)
			power := action
			if action == "untimeout" {
				power = "timeout"
			}
			Check(B(actions[power]), 403, "HIERARCHY", "You cannot moderate this member.")
			if action == "timeout" || action == "untimeout" {
				if action == "timeout" {
					seconds := N(body["seconds"])
					Check(seconds == 60 || seconds == 600 || seconds == 3600 || seconds == 86400 || seconds == 604800, 400, "INVALID_TIMEOUT", "Choose a timeout duration.")
					tx.Run("INSERT INTO server_timeouts(server_id,user_id,actor_id,expires_at,reason) VALUES(?,?,?,?,?) ON CONFLICT(server_id,user_id) DO UPDATE SET actor_id=excluded.actor_id,expires_at=excluded.expires_at,reason=excluded.reason", server, targetID, actor, Now()+seconds*1000, S(body["reason"]))
				} else {
					tx.Run("DELETE FROM server_timeouts WHERE server_id=? AND user_id=?", server, targetID)
				}
			} else {
				if action == "ban" {
					tx.Run("INSERT INTO server_bans(server_id,user_id,actor_id,target_role,reason,created_at) VALUES(?,?,?,?,?,?)", server, targetID, actor, role, S(body["reason"]), Now())
				}
				tx.Run("DELETE FROM user_tags WHERE user_id=? AND tag_id IN (SELECT id FROM tags WHERE server_id=?)", targetID, server)
				tx.Run("DELETE FROM members WHERE server_id=? AND user_id=?", server, targetID)
			}
			if action != "untimeout" {
				tx.Run("DELETE FROM voice_members WHERE user_id=? AND channel_id IN (SELECT id FROM channels WHERE server_id=?)", targetID, server)
			}
		}
		payload := M{"serverId": server}
		for _, k := range []string{"seconds", "reason"} {
			if v, ok := body[k]; ok {
				payload[k] = v
			}
		}
		Audit(tx, actor, "member."+action, targetID, payload)
		return M{"success": true}
	})
	s.Notify("state:changed", M{})
	s.Notify("voice:changed", M{})
	return serviceResult(result)
}
func (s *Service) ServerBans(actor, server string) M {
	return serviceResult(s.DB.Tx(func(tx *DB) any {
		m := s.Member(tx, actor, server, "manageMembers")
		role := s.Authority(tx, m)
		bans := []M{}
		for _, b := range tx.All("SELECT b.user_id,b.reason,b.created_at,b.target_role,u.display_name FROM server_bans b JOIN users u ON u.id=b.user_id WHERE b.server_id=? ORDER BY b.created_at DESC", server) {
			bans = append(bans, M{"userId": b["user_id"], "displayName": b["display_name"], "reason": b["reason"], "createdAt": N(b["created_at"]), "canUnban": CanManage(role, S(b["target_role"]))})
		}
		return M{"bans": bans}
	}))
}
func (s *Service) Tags(uid, server string) []M {
	s.Member(s.DB, uid, server)
	tags := []M{}
	for _, t := range s.DB.All("SELECT * FROM tags WHERE server_id=? ORDER BY name", server) {
		tags = append(tags, M{"id": t["id"], "serverId": t["server_id"], "name": t["name"], "color": t["color"]})
	}
	return tags
}
func (s *Service) ChangeTag(actorID, rid, server string, body M) M {
	result := s.Mutate(actorID, rid, "tag.change", servicePayload(M{"serverId": server}, body), func(tx *DB) any {
		actor := s.Member(tx, actorID, server, "manageChannels")
		id := S(body["tagId"])
		if id != "" {
			Check(tx.One("SELECT id FROM tags WHERE id=? AND server_id=?", id, server) != nil, 404, "NOT_FOUND", "Tag not found.")
		} else {
			id = ID()
		}
		if targetID := S(body["userId"]); targetID != "" {
			target := s.Member(tx, targetID, server)
			Check(actorID == targetID || B(actor["globalAdmin"]) || CanManage(S(actor["role"]), S(target["role"])), 403, "HIERARCHY", "Cannot assign tags to this role.")
			Check(S(body["tagId"]) != "", 400, "INVALID_TAG", "Choose a tag.")
			if B(body["assigned"]) {
				tx.Run("INSERT INTO user_tags(user_id,tag_id) VALUES(?,?) ON CONFLICT DO NOTHING", targetID, id)
			} else {
				tx.Run("DELETE FROM user_tags WHERE user_id=? AND tag_id=?", targetID, id)
			}
		} else if B(body["delete"]) {
			tx.Run("DELETE FROM tags WHERE id=?", id)
		} else if S(body["tagId"]) == "" {
			Check(N(tx.One("SELECT COUNT(*) AS count FROM tags WHERE server_id=?", server)["count"]) < 32, 409, "LIMIT", "This server has reached its tag limit.")
			Check(S(body["name"]) != "", 400, "VALIDATION", "Enter a tag name.")
			color := S(body["color"])
			if color == "" {
				color = "#a99bff"
			}
			tx.Run("INSERT INTO tags(id,server_id,name,color) VALUES(?,?,?,?)", id, server, body["name"], color)
		} else {
			if S(body["name"]) != "" {
				tx.Run("UPDATE tags SET name=? WHERE id=?", body["name"], id)
			}
			if S(body["color"]) != "" {
				tx.Run("UPDATE tags SET color=? WHERE id=?", body["color"], id)
			}
		}
		s.RevalidateVoice(tx, server)
		audit := M{"serverId": server}
		for _, k := range []string{"userId", "assigned", "delete"} {
			if v, ok := body[k]; ok {
				audit[k] = v
			}
		}
		Audit(tx, actorID, "tag.change", id, audit)
		return M{"id": id}
	})
	s.Notify("state:changed", M{})
	s.Notify("voice:changed", M{})
	return serviceResult(result)
}
