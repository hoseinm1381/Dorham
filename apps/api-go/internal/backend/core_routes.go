package backend

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

var coreRoles = []string{"owner", "administrator", "moderator", "member"}
var coreColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func corePick(body M, keys ...string) M {
	out := M{}
	for _, k := range keys {
		if v, ok := body[k]; ok {
			out[k] = v
		}
	}
	return out
}
func coreString(body M, key string, min, max int, trim bool, optional ...bool) string {
	if trim {
		if value, ok := body[key].(string); ok {
			body[key] = strings.TrimFunc(value, serviceJSSpace)
		}
	}
	return VString(body, key, min, max, false, optional...)
}
func coreID(body M, key string, optional ...bool) string {
	return coreString(body, key, 1, 80, false, optional...)
}
func coreOptionalUUID(body M, key string) {
	if _, ok := body[key]; ok {
		VUUID(coreString(body, key, 36, 36, false))
	}
}
func coreOptionalPermissions(body M) {
	if p, ok := body["permissions"]; ok {
		VPermissions(p)
	}
}
func coreOptionalColor(body M) {
	if _, ok := body["color"]; ok {
		Check(coreColor.MatchString(coreString(body, "color", 7, 7, false)), 400, "VALIDATION", "Invalid color")
	}
}
func coreStringArray(body M, key string, max int, uuid bool) []string {
	raw, ok := body[key].([]any)
	Check(ok && len(raw) <= max, 400, "VALIDATION", "Invalid "+key+" array")
	out := []string{}
	for _, v := range raw {
		item := M{"value": v}
		value := coreString(item, "value", 1, 80, false)
		if uuid {
			VUUID(value)
		}
		out = append(out, value)
	}
	return out
}
func coreQueryInt(r *Request, key string, min int64) *int64 {
	values, exists := r.R.URL.Query()[key]
	if !exists {
		return nil
	}
	Check(len(values) == 1, 400, "VALIDATION", "Invalid "+key)
	text := strings.TrimFunc(r.Query(key), serviceJSSpace)
	var n float64
	var err error
	if text != "" {
		if strings.HasPrefix(text, "0x") || strings.HasPrefix(text, "0X") || strings.HasPrefix(text, "0o") || strings.HasPrefix(text, "0O") || strings.HasPrefix(text, "0b") || strings.HasPrefix(text, "0B") {
			var integer uint64
			integer, err = strconv.ParseUint(text, 0, 64)
			n = float64(integer)
		} else {
			n, err = strconv.ParseFloat(text, 64)
		}
	}
	Check(err == nil && !math.IsNaN(n) && !math.IsInf(n, 0) && math.Trunc(n) == n && n >= float64(min) && n <= 9007199254740991, 400, "VALIDATION", "Invalid "+key)
	value := int64(n)
	return &value
}

// CoreMessageBody is shared by HTTP and Socket.IO. It strips unknown fields in
// the same way as messageSchema, while preserving omitted versus null replyTo.
func CoreMessageBody(raw M) M {
	b := corePick(raw, "conversationId", "content", "tts", "replyTo", "attachmentIds", "requestId")
	RID(b)
	coreID(b, "conversationId")
	coreString(b, "content", 0, 4000, true)
	VBool(b, "tts", true)
	if reply, ok := b["replyTo"]; ok && reply != nil {
		coreID(b, "replyTo")
	}
	if _, ok := b["attachmentIds"]; !ok {
		b["attachmentIds"] = []any{}
	}
	coreStringArray(b, "attachmentIds", 4, true)
	Check(S(b["content"]) != "" || len(Arr(b["attachmentIds"])) > 0, 400, "VALIDATION", "Write a message or attach a file.")
	return b
}
func coreMessageReply(body M) any {
	if reply, ok := body["replyTo"]; ok {
		return reply
	}
	return ServiceUndefined{}
}
func (a *App) registerCore() {
	s := a.Service
	a.Route("GET", "/api/v1/bootstrap", true, func(r *Request) any { return s.Bootstrap(r.UID()) })
	a.Route("PATCH", "/api/v1/profile", true, func(r *Request) any {
		b := corePick(r.Body, "displayName", "bio", "status", "language", "requestId")
		rid := RID(b)
		coreString(b, "displayName", 1, 48, true)
		coreString(b, "bio", 0, 500, false)
		VEnum(b, "status", []string{"online", "idle", "busy"})
		VEnum(b, "language", []string{"en-US", "fa-IR"}, true)
		result := s.Mutate(r.UID(), rid, "profile.change", b, func(tx *DB) any {
			lang := b["language"]
			if lang == nil {
				lang = r.User["language"]
			}
			tx.Run("UPDATE users SET display_name=?,bio=?,status=?,language=? WHERE id=?", b["displayName"], b["bio"], b["status"], lang, r.UID())
			return M{"success": true}
		})
		s.Notify("state:changed", M{})
		s.Notify("voice:changed", M{})
		return result
	})
	a.Route("GET", "/api/v1/channels/{id}", true, func(r *Request) any { return s.Channel(a.DB, r.UID(), r.Param("id")) })
	a.Route("GET", "/api/v1/channels/{id}/overrides", true, func(r *Request) any {
		b := M{"role": r.Query("role")}
		role := VEnum(b, "role", coreRoles)
		return s.ChannelOverrides(r.UID(), r.Param("id"), role)
	})
	a.Route("POST", "/api/v1/servers", true, func(r *Request) any {
		b := corePick(r.Body, "name", "requestId")
		rid := RID(b)
		return s.CreateServer(r.UID(), rid, coreString(b, "name", 1, 64, true))
	})
	a.Route("PATCH", "/api/v1/servers/{id}", true, func(r *Request) any {
		b := corePick(r.Body, "name", "delete", "allowGuests", "allowMemberInvites", "requestId")
		rid := RID(b)
		coreString(b, "name", 1, 64, true, true)
		VBool(b, "delete", true)
		VBool(b, "allowGuests", true)
		VBool(b, "allowMemberInvites", true)
		_, guests := b["allowGuests"]
		_, invites := b["allowMemberInvites"]
		Check(S(b["name"]) != "" || B(b["delete"]) || guests || invites, 400, "VALIDATION", "Choose a server change.")
		return s.ChangeServer(r.UID(), rid, r.Param("id"), b)
	})
	a.Route("POST", "/api/v1/servers/{id}/channels", true, func(r *Request) any {
		b := corePick(r.Body, "name", "kind", "requestId")
		rid := RID(b)
		name := coreString(b, "name", 1, 64, true)
		kind := VEnum(b, "kind", []string{"text", "voice"})
		return s.CreateChannel(r.UID(), rid, r.Param("id"), name, kind)
	})
	a.Route("PATCH", "/api/v1/channels/{id}", true, func(r *Request) any {
		b := corePick(r.Body, "name", "delete", "role", "permissions", "expectedRevision", "requestId")
		rid := RID(b)
		coreString(b, "name", 1, 64, true, true)
		VBool(b, "delete", true)
		VEnum(b, "role", coreRoles, true)
		coreOptionalPermissions(b)
		VInt(b, "expectedRevision", 0, 9007199254740991, true)
		Check(S(b["name"]) != "" || B(b["delete"]) || (S(b["role"]) != "" && b["permissions"] != nil), 400, "VALIDATION", "Choose a channel change.")
		return s.ChangeChannel(r.UID(), rid, r.Param("id"), b)
	})
	a.Route("POST", "/api/v1/servers/{id}/invites", true, func(r *Request) any {
		b := corePick(r.Body, "hours", "uses", "channelId", "requestId")
		rid := RID(b)
		if _, ok := b["hours"]; !ok {
			b["hours"] = 24
		}
		if _, ok := b["uses"]; !ok {
			b["uses"] = 10
		}
		hours := VInt(b, "hours", 1, 168)
		uses := VInt(b, "uses", 1, 100)
		ch := coreID(b, "channelId", true)
		return s.Invite(r.UID(), rid, r.Param("id"), Token(), int(hours), int(uses), ch)
	})
	a.Route("GET", "/api/v1/servers/{id}/invites", true, func(r *Request) any { return s.Invitations(r.UID(), r.Param("id")) })
	a.Route("DELETE", "/api/v1/servers/{id}/invites/{code}", true, func(r *Request) any {
		code := r.R.PathValue("code")
		coreString(M{"code": code}, "code", 10, 100, false)
		return s.RevokeInvitation(r.UID(), RID(r.Body), r.Param("id"), code)
	})
	a.Route("GET", "/api/v1/servers/{id}/roles", true, func(r *Request) any { return s.CustomRoles(r.UID(), r.Param("id")) })
	a.Route("POST", "/api/v1/servers/{id}/roles", true, func(r *Request) any {
		Strict(r.Body, "roleId", "name", "color", "permissions", "delete", "userId", "assigned", "requestId")
		b := corePick(r.Body, "roleId", "name", "color", "permissions", "delete", "userId", "assigned", "requestId")
		rid := RID(b)
		coreOptionalUUID(b, "roleId")
		coreString(b, "name", 1, 32, true, true)
		coreOptionalColor(b)
		coreOptionalPermissions(b)
		VBool(b, "delete", true)
		coreID(b, "userId", true)
		VBool(b, "assigned", true)
		return s.ChangeCustomRole(r.UID(), rid, r.Param("id"), b)
	})
	a.Route("POST", "/api/v1/invites/join", true, func(r *Request) any {
		b := corePick(r.Body, "code", "requestId")
		return s.JoinInvite(r.UID(), RID(b), coreString(b, "code", 10, 100, false))
	})
	a.Route("GET", "/api/v1/servers/{id}/members", true, func(r *Request) any { return s.Members(r.UID(), r.Param("id")) })
	a.Route("PATCH", "/api/v1/servers/{serverId}/members/{userId}", true, func(r *Request) any {
		b := corePick(r.Body, "role", "remove", "requestId")
		rid := RID(b)
		VEnum(b, "role", coreRoles, true)
		VBool(b, "remove", true)
		Check(S(b["role"]) != "" || B(b["remove"]), 400, "VALIDATION", "Choose a member change.")
		return s.ChangeMember(r.UID(), rid, r.Param("serverId"), r.Param("userId"), b)
	})
	a.Route("POST", "/api/v1/servers/{id}/leave", true, func(r *Request) any { return s.LeaveServer(r.UID(), RID(r.Body), r.Param("id")) })
	a.Route("POST", "/api/v1/dms/{id}/close", true, func(r *Request) any { return s.CloseDirectMessage(r.UID(), RID(r.Body), r.Param("id")) })
	a.Route("POST", "/api/v1/users/{id}/block", true, func(r *Request) any {
		b := corePick(r.Body, "blocked", "requestId")
		rid := RID(b)
		return s.BlockUser(r.UID(), rid, r.Param("id"), VBool(b, "blocked"))
	})
	a.Route("POST", "/api/v1/dms", true, func(r *Request) any {
		b := corePick(r.Body, "userId", "requestId")
		rid := RID(b)
		result := s.DM(r.UID(), rid, coreID(b, "userId"))
		s.Notify("state:changed", M{})
		return result
	})
	a.Route("GET", "/api/v1/conversations/{id}/messages", true, func(r *Request) any {
		return s.History(r.UID(), r.Param("id"), coreQueryInt(r, "before", 1), coreQueryInt(r, "after", 0))
	})
	a.Route("POST", "/api/v1/messages", true, func(r *Request) any {
		b := CoreMessageBody(r.Body)
		return s.Send(r.UID(), S(b["requestId"]), S(b["conversationId"]), S(b["content"]), coreMessageReply(b), serviceStrings(b["attachmentIds"]), B(b["tts"]))
	})
	a.Route("PATCH", "/api/v1/messages/{id}", true, func(r *Request) any {
		b := corePick(r.Body, "content", "delete", "emoji", "removeReaction", "requestId")
		rid := RID(b)
		coreString(b, "content", 1, 4000, true, true)
		VBool(b, "delete", true)
		if _, ok := b["emoji"]; ok {
			emoji := coreString(b, "emoji", 1, 100, false)
			Check(coreReactionValues[emoji], 400, "VALIDATION", "Invalid reaction emoji")
		}
		VBool(b, "removeReaction", true)
		Check(S(b["content"]) != "" || B(b["delete"]) || S(b["emoji"]) != "", 400, "VALIDATION", "Choose a message change.")
		return s.ChangeMessage(r.UID(), rid, r.Param("id"), b)
	})
	a.Route("POST", "/api/v1/conversations/{id}/read", true, func(r *Request) any {
		b := corePick(r.Body, "sequence", "requestId")
		return s.Read(r.UID(), RID(b), r.Param("id"), VInt(b, "sequence", 0, 9007199254740991))
	})
	a.Route("GET", "/api/v1/voice/{id}", true, func(r *Request) any { return s.Room(r.UID(), r.Param("id")) })
	a.Route("GET", "/api/v1/servers/{serverId}/members/{userId}/moderation", true, func(r *Request) any { return s.ModerationInfo(r.UID(), r.Param("serverId"), r.Param("userId")) })
	a.Route("POST", "/api/v1/servers/{serverId}/members/{userId}/moderate", true, func(r *Request) any {
		Strict(r.Body, "requestId", "action", "seconds", "reason")
		b := corePick(r.Body, "requestId", "action", "seconds", "reason")
		rid := RID(b)
		VEnum(b, "action", []string{"kick", "ban", "unban", "timeout", "untimeout"})
		if _, ok := b["seconds"]; ok {
			seconds := VInt(b, "seconds", 60, 604800)
			Check(seconds == 60 || seconds == 600 || seconds == 3600 || seconds == 86400 || seconds == 604800, 400, "VALIDATION", "Invalid timeout")
		}
		coreString(b, "reason", 0, 320, true, true)
		return s.ModerateMember(r.UID(), rid, r.Param("serverId"), r.Param("userId"), b)
	})
	a.Route("GET", "/api/v1/servers/{serverId}/bans", true, func(r *Request) any { return s.ServerBans(r.UID(), r.Param("serverId")) })
	a.Route("POST", "/api/v1/voice/{id}/moderate", true, func(r *Request) any {
		b := corePick(r.Body, "userId", "action", "requestId")
		rid := RID(b)
		target := coreID(b, "userId")
		action := VEnum(b, "action", []string{"mute", "unmute", "deafen", "undeafen", "denyShare", "allowShare", "kick", "stopShare"})
		return s.Moderate(r.UID(), rid, r.Param("id"), target, action)
	})
	a.Route("PATCH", "/api/v1/voice/{id}/policy", true, func(r *Request) any {
		b := corePick(r.Body, "locked", "userLimit", "tagMode", "requiredTags", "requestId")
		rid := RID(b)
		VBool(b, "locked")
		VInt(b, "userLimit", 1, int64(a.C.MaxVoice))
		VEnum(b, "tagMode", []string{"ANY", "ALL"})
		coreStringArray(b, "requiredTags", 32, true)
		return s.VoicePolicy(r.UID(), rid, r.Param("id"), b)
	})
	a.Route("POST", "/api/v1/voice/{id}/move", true, func(r *Request) any {
		b := corePick(r.Body, "userId", "channelId", "requestId")
		rid := RID(b)
		return s.MoveVoice(r.UID(), rid, r.Param("id"), coreID(b, "userId"), coreID(b, "channelId"))
	})
	a.Route("GET", "/api/v1/servers/{id}/tags", true, func(r *Request) any { return M{"tags": s.Tags(r.UID(), r.Param("id"))} })
	a.Route("POST", "/api/v1/servers/{id}/tags", true, func(r *Request) any {
		b := corePick(r.Body, "tagId", "name", "color", "delete", "userId", "assigned", "requestId")
		rid := RID(b)
		coreOptionalUUID(b, "tagId")
		coreString(b, "name", 1, 32, true, true)
		coreOptionalColor(b)
		VBool(b, "delete", true)
		coreID(b, "userId", true)
		VBool(b, "assigned", true)
		return s.ChangeTag(r.UID(), rid, r.Param("id"), b)
	})
}
