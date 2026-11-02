package backend

import (
	"encoding/json"
	"sort"
	"strings"
)

// The Node release hashed JSON.stringify rather than canonical JSON. Retaining
// its schema/insertion field order permits an in-flight retry to recover its
// existing receipt after upgrading, without weakening conflict detection.
var serviceLegacyOrder = map[string][]string{
	"guest.upgrade":     {"username", "displayName", "password"},
	"session.revoke":    {"sessionId", "all", "requestId"},
	"recovery.question": {"question", "answer"},
	"password.change":   {"fingerprint"},
	"profile.change":    {"displayName", "bio", "status", "language", "requestId"},
	"avatar.change":     {"hash"}, "server.icon": {"serverId", "digest"}, "server.icon.remove": {"serverId"},
	"game.create":    {"requestId", "channelId", "kind", "settings"},
	"game.command":   {"id", "requestId", "revision", "kind", "action"},
	"chess.create":   {"requestId", "serverId", "channelId", "openSeat", "opponentId", "difficulty", "mode", "minutes", "increment"},
	"chess.command":  {"id", "requestId", "revision", "kind", "action"},
	"server.create":  {"name"},
	"server.change":  {"serverId", "name", "delete", "allowGuests", "allowMemberInvites", "requestId"},
	"channel.create": {"serverId", "name", "kind"},
	"channel.change": {"channelId", "name", "delete", "role", "permissions", "expectedRevision", "requestId"},
	"invite.create":  {"serverId", "expiresHours", "uses", "channelId"},
	"invite.revoke":  {"serverId", "code"}, "invite.join": {"code"},
	"role.change":     {"serverId", "roleId", "name", "color", "permissions", "delete", "userId", "assigned", "requestId"},
	"member.change":   {"serverId", "targetId", "role", "remove", "requestId"},
	"member.moderate": {"serverId", "targetId", "requestId", "action", "seconds", "reason"},
	"server.leave":    {"serverId"}, "dm.close": {"conversationId"}, "user.block": {"targetId", "blocked"}, "dm.create": {"otherId"},
	"message.send":      {"conversationId", "content", "replyTo", "attachmentIds", "tts"},
	"message.change":    {"messageId", "content", "delete", "emoji", "removeReaction", "requestId"},
	"conversation.read": {"conversationId", "sequence"},
	"share.start":       {"includeAudio"}, "share.stop": {"includeAudio"},
	"share.update":   {"requestId", "leaseId", "expectedRevision", "frameRate", "includeAudio"},
	"voice.moderate": {"channelId", "targetId", "action"},
	"voice.policy":   {"channelId", "locked", "userLimit", "tagMode", "requiredTags", "requestId"},
	"tag.change":     {"serverId", "tagId", "name", "color", "delete", "userId", "assigned", "requestId"},
	"voice.move":     {"fromChannel", "targetId", "toChannel"},
}

func serviceOrderedJSON(value any, order []string, operation ...string) string {
	m, ok := value.(map[string]any)
	if !ok {
		return serviceJSON(value)
	}
	op := ""
	if len(operation) > 0 {
		op = operation[0]
	}
	parts := []string{}
	seen := map[string]bool{}
	appendKey := func(key string) {
		v, exists := m[key]
		if !exists || seen[key] {
			return
		}
		seen[key] = true
		encoded := serviceJSON(v)
		switch key {
		case "permissions":
			encoded = serviceOrderedJSON(v, permissionNames, op)
		case "settings":
			encoded = serviceOrderedJSON(v, []string{"maxPlayers", "seconds", "rounds", "language", "domino", "chips", "blind"}, op)
		case "action":
			order := []string{"type", "token", "piece", "column", "tile", "end", "to", "index", "count", "text", "stroke"}
			if strings.HasPrefix(op, "chess.") {
				order = []string{"from", "to", "buy", "promotion"}
			}
			encoded = serviceOrderedJSON(v, order, op)
		case "stroke":
			encoded = serviceOrderedJSON(v, []string{"color", "width", "points"}, op)
		}
		parts = append(parts, serviceJSON(key)+":"+encoded)
	}
	for _, key := range order {
		appendKey(key)
	}
	extra := []string{}
	for key := range m {
		if !seen[key] {
			extra = append(extra, key)
		}
	}
	sort.Strings(extra)
	for _, key := range extra {
		appendKey(key)
	}
	return "{" + strings.Join(parts, ",") + "}"
}
func serviceJSON(v any) string {
	raw := JSON(serviceJSONNumbers(v))
	var out strings.Builder
	for i := 0; i < len(raw); {
		if raw[i] == '\\' && i+1 < len(raw) {
			if i+6 <= len(raw) && raw[i:i+6] == `\u2028` {
				out.WriteRune('\u2028')
				i += 6
				continue
			}
			if i+6 <= len(raw) && raw[i:i+6] == `\u2029` {
				out.WriteRune('\u2029')
				i += 6
				continue
			}
			out.WriteString(raw[i : i+2])
			i += 2
			continue
		}
		out.WriteByte(raw[i])
		i++
	}
	return out.String()
}

func serviceJSONNumbers(v any) any {
	switch x := v.(type) {
	case json.Number:
		f, e := x.Float64()
		if e != nil {
			panic(e)
		}
		if f == 0 {
			return float64(0)
		}
		return f
	case map[string]any:
		m := M{}
		for k, value := range x {
			m[k] = serviceJSONNumbers(value)
		}
		return m
	case []any:
		out := make([]any, len(x))
		for i, value := range x {
			out[i] = serviceJSONNumbers(value)
		}
		return out
	default:
		return v
	}
}
func serviceLegacyJSON(operation string, payload any) string {
	return serviceOrderedJSON(payload, serviceLegacyOrder[operation], operation)
}
