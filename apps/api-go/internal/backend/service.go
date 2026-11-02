package backend

import (
	"regexp"
	"strings"
)

// Service is the application domain layer. Every mutation and authorization
// decision uses the caller's serialized database transaction; nothing here
// caches membership, permissions or notification audiences across commits.
type Service struct {
	DB             *DB
	C              Config
	Notify         func(string, any)
	OnTTS          func(string, M)
	cloudflareTurn *CloudflareTurn
}

func NewService(db *DB, c Config) *Service {
	s := &Service{DB: db, C: c, Notify: func(string, any) {}}
	if c.CloudflareTurnKeyID != "" {
		s.cloudflareTurn = NewCloudflareTurn(c.CloudflareTurnKeyID, c.CloudflareTurnAPIToken)
	}
	return s
}
func PublicUser(u M) M {
	p := M{"id": u["id"], "username": u["username"], "displayName": u["display_name"], "bio": u["bio"], "avatar": u["avatar"], "status": u["status"], "instanceAdmin": B(u["instance_admin"]), "guest": B(u["guest"]), "banned": B(u["banned"]), "mustChangePassword": B(u["must_change_password"])}
	if lang := S(u["language"]); lang == "fa-IR" || lang == "en-US" {
		p["language"] = lang
	}
	return p
}

var requestUUID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func (s *Service) Mutate(uid, rid, operation string, payload any, fn func(*DB) any) any {
	Check(requestUUID.MatchString(rid), 400, "VALIDATION", "Invalid request identifier.")
	// Store the existing Node wire hash so a Go-created receipt also survives a
	// rollback to the preserved TypeScript runtime. Accept early Go hashes too.
	fingerprint := Hash(serviceLegacyJSON(operation, payload))
	return s.DB.Tx(func(tx *DB) any {
		Check(tx.One("SELECT id FROM users WHERE id=? AND banned=0", uid) != nil, 403, "FORBIDDEN", "Account access is unavailable.")
		if old := tx.One("SELECT * FROM mutations WHERE user_id=? AND request_id=?", uid, rid); old != nil {
			compatible := S(old["fingerprint"]) == fingerprint || S(old["fingerprint"]) == Hash(JSON(payload))
			Check(S(old["operation"]) == operation && compatible, 409, "IDEMPOTENCY_CONFLICT", "Request identifier was already used with different input.")
			return Parse(S(old["response"]))
		}
		result := fn(tx)
		tx.Run("INSERT INTO mutations(user_id,request_id,operation,fingerprint,response,created_at) VALUES(?,?,?,?,?,?)", uid, rid, operation, fingerprint, JSON(result), Now())
		return result
	})
}

var permissionNames = []string{"view", "write", "speak", "share", "manageChannels", "manageMembers", "moderate", "createInvites"}
var roleRank = map[string]int{"member": 0, "moderator": 1, "administrator": 2, "owner": 3}

func BasePermissions(role string) M {
	return M{"view": true, "write": true, "speak": true, "share": true, "manageChannels": roleRank[role] >= 2, "manageMembers": roleRank[role] >= 1, "moderate": roleRank[role] >= 1, "createInvites": true}
}
func CanManage(actor, target string) bool { return roleRank[actor] > roleRank[target] }
func CanMoveMember(actor, target string) bool {
	return target != "owner" && (CanManage(actor, target) || (actor == target && (actor == "administrator" || actor == "moderator")))
}
func ResolveCustomPermissions(role string, assigned []M, channel ...M) M {
	p := BasePermissions(role)
	if role == "owner" {
		return p
	}
	for _, k := range permissionNames {
		allowed, denied := false, false
		for _, r := range assigned {
			if v, ok := r[k]; ok {
				if B(v) {
					allowed = true
				} else {
					denied = true
				}
			}
		}
		if denied {
			p[k] = false
		} else if allowed {
			p[k] = true
		}
	}
	if len(channel) > 0 {
		for k, v := range channel[0] {
			p[k] = v
		}
	}
	return p
}
func (s *Service) AssignedRoles(tx *DB, uid, server string) []M {
	out := []M{}
	for _, r := range tx.All("SELECT r.* FROM custom_roles r JOIN member_roles mr ON mr.role_id=r.id AND mr.server_id=r.server_id WHERE mr.user_id=? AND r.server_id=? ORDER BY r.name", uid, server) {
		out = append(out, M{"id": r["id"], "serverId": r["server_id"], "name": r["name"], "color": r["color"], "permissions": Parse(S(r["permissions"]))})
	}
	return out
}
func (s *Service) assignedPermissions(tx *DB, uid, server string) []M {
	out := []M{}
	for _, r := range s.AssignedRoles(tx, uid, server) {
		out = append(out, Obj(r["permissions"]))
	}
	return out
}
func (s *Service) MemberPermissions(tx *DB, role, uid, server string) M {
	p := ResolveCustomPermissions(role, s.assignedPermissions(tx, uid, server))
	if role != "owner" && !B(tx.One("SELECT allow_member_invites FROM servers WHERE id=?", server)["allow_member_invites"]) {
		p["createInvites"] = false
	}
	if B(tx.One("SELECT guest FROM users WHERE id=?", uid)["guest"]) {
		p["manageChannels"] = false
		p["manageMembers"] = false
		p["moderate"] = false
	}
	if role != "owner" && N(tx.One("SELECT expires_at AS timeout_until FROM server_timeouts WHERE server_id=? AND user_id=?", server, uid)["timeout_until"]) > Now() {
		for _, k := range permissionNames {
			if k != "view" {
				p[k] = false
			}
		}
	}
	return p
}
func (s *Service) Member(tx *DB, uid, server string, permission ...string) M {
	a := tx.One("SELECT * FROM users WHERE id=? AND banned=0", uid)
	Check(a != nil, 403, "FORBIDDEN", "Account access is unavailable.")
	Check(tx.One("SELECT user_id FROM server_bans WHERE server_id=? AND user_id=?", server, uid) == nil, 403, "SERVER_BANNED", "You are banned from this server.")
	if B(a["instance_admin"]) {
		Check(tx.One("SELECT id FROM servers WHERE id=?", server) != nil, 404, "NOT_FOUND", "Server not found.")
		return M{"server_id": server, "user_id": uid, "role": "owner", "globalAdmin": true}
	}
	p := ""
	if len(permission) > 0 {
		p = permission[0]
	}
	if B(a["guest"]) {
		Check(p != "manageChannels" && p != "manageMembers" && p != "moderate", 403, "GUEST_ACCOUNT", "Register before using administration controls.")
		Check(B(tx.One("SELECT allow_guests FROM servers WHERE id=?", server)["allow_guests"]), 403, "GUESTS_DISABLED", "This server does not allow guests.")
	}
	m := tx.One("SELECT m.*,(SELECT expires_at FROM server_timeouts t WHERE t.server_id=m.server_id AND t.user_id=m.user_id) AS timeout_until FROM members m WHERE m.server_id=? AND m.user_id=?", server, uid)
	Check(m != nil, 403, "FORBIDDEN", "You do not have permission.")
	if p != "" {
		Check(B(s.MemberPermissions(tx, S(m["role"]), uid, server)[p]), 403, "FORBIDDEN", "You do not have permission.")
	}
	return m
}
func (s *Service) Authority(tx *DB, m M) string {
	role := S(m["role"])
	if role != "member" {
		return role
	}
	p := ResolveCustomPermissions(role, s.assignedPermissions(tx, S(m["user_id"]), S(m["server_id"])))
	if B(p["moderate"]) || B(p["manageMembers"]) {
		return "moderator"
	}
	return "member"
}

// Attempt catches authorization failures locally just as the reference service's
// try/catch does. SQL failures must still abort the surrounding transaction.
func serviceAttempt(fn func()) (err any) { defer func() { err = recover() }(); fn(); return nil }
func (s *Service) Channel(tx *DB, uid, id string, permission ...string) M {
	p := "view"
	if len(permission) > 0 {
		p = permission[0]
	}
	ch := tx.One("SELECT * FROM channels WHERE id=?", id)
	Check(ch != nil, 404, "NOT_FOUND", "Channel not found.")
	server := S(ch["server_id"])
	m := s.Member(tx, uid, server)
	role := S(m["role"])
	override := tx.One("SELECT permissions FROM channel_overrides WHERE channel_id=? AND role=?", id, role)
	ov := M{}
	if override != nil {
		ov = Obj(Parse(S(override["permissions"])))
	}
	permissions := ResolveCustomPermissions(role, s.assignedPermissions(tx, uid, server), ov)
	if B(tx.One("SELECT guest FROM users WHERE id=?", uid)["guest"]) {
		permissions["manageChannels"] = false
		permissions["manageMembers"] = false
		permissions["moderate"] = false
	}
	if role != "owner" && !B(tx.One("SELECT allow_member_invites FROM servers WHERE id=?", server)["allow_member_invites"]) {
		permissions["createInvites"] = false
	}
	if r := tx.One("SELECT sharing_allowed FROM voice_restrictions WHERE channel_id=? AND user_id=?", id, uid); r != nil && !B(r["sharing_allowed"]) {
		permissions["share"] = false
	}
	if S(ch["kind"]) == "voice" && role != "owner" {
		required := tx.All("SELECT tag_id FROM channel_tags WHERE channel_id=?", id)
		if len(required) > 0 {
			assigned := map[string]bool{}
			for _, r := range tx.All("SELECT tag_id FROM user_tags WHERE user_id=?", uid) {
				assigned[S(r["tag_id"])] = true
			}
			allowed := S(ch["tag_mode"]) == "ALL"
			for _, r := range required {
				has := assigned[S(r["tag_id"])]
				if S(ch["tag_mode"]) == "ALL" {
					allowed = allowed && has
				} else {
					allowed = allowed || has
				}
			}
			Check(allowed, 403, "TAG_REQUIRED", "This voice channel requires an assigned tag.")
		}
	}
	timeout := N(m["timeout_until"])
	if timeout > Now() {
		Check(p == "view", 403, "TIMED_OUT", "You are timed out in this server.")
		for _, k := range permissionNames {
			if k != "view" {
				permissions[k] = false
			}
		}
	}
	Check(B(permissions["view"]) && B(permissions[p]), 403, "FORBIDDEN", "Channel permission denied.")
	return Merge(ch, M{"role": role, "permissions": permissions, "timeoutUntil": timeout})
}
func (s *Service) AllowDirectMessage(tx *DB, uid, other string) {
	Check(tx.One("SELECT user_id FROM user_blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)", uid, other, other, uid) == nil, 403, "DM_BLOCKED", "Direct messaging is blocked between these accounts.")
}
func (s *Service) Conversation(tx *DB, uid, id string, write ...bool) M {
	cv := tx.One("SELECT * FROM conversations WHERE id=?", id)
	Check(cv != nil, 404, "NOT_FOUND", "Conversation not found.")
	w := len(write) > 0 && write[0]
	if S(cv["kind"]) == "dm" {
		Check(tx.One("SELECT user_id FROM dm_members WHERE conversation_id=? AND user_id=?", id, uid) != nil, 403, "FORBIDDEN", "Private conversation.")
		if w {
			if other := tx.One("SELECT user_id FROM dm_members WHERE conversation_id=? AND user_id<>?", id, uid); other != nil {
				s.AllowDirectMessage(tx, uid, S(other["user_id"]))
			}
		}
	} else {
		ch := tx.One("SELECT id FROM channels WHERE conversation_id=?", id)
		Check(ch != nil, 404, "NOT_FOUND", "Channel not found.")
		p := "view"
		if w {
			p = "write"
		}
		s.Channel(tx, uid, S(ch["id"]), p)
	}
	return cv
}
func (s *Service) ConversationAudience(viewers []M, id string, writer ...string) []string {
	return s.DB.Tx(func(tx *DB) any {
		tx = tx.Snapshot()
		if len(writer) > 0 && writer[0] != "" {
			s.Conversation(tx, writer[0], id, true)
		}
		allowed := map[string]bool{}
		out := []string{}
		for _, v := range viewers {
			uid := S(v["userId"])
			if _, ok := allowed[uid]; !ok {
				allowed[uid] = serviceAttempt(func() {
					u := tx.One("SELECT * FROM users WHERE id=? AND banned=0", uid)
					Check(u != nil && !B(u["must_change_password"]), 403, "FORBIDDEN", "Account access is unavailable.")
					s.Conversation(tx, uid, id)
				}) == nil
			}
			if allowed[uid] {
				out = append(out, S(v["socketId"]))
			}
		}
		return out
	}).([]string)
}

func serviceResult(v any) M           { return Obj(v) }
func servicePayload(base M, body M) M { return Merge(base, body) }
func serviceBoolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
func serviceNullString(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func serviceStrings(v any) []string {
	out := []string{}
	switch a := v.(type) {
	case []string:
		return a
	case []any:
		for _, x := range a {
			out = append(out, S(x))
		}
	}
	return out
}
func serviceUnique(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, v := range values {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}
func serviceIn(value string, values ...string) bool {
	for _, v := range values {
		if value == v {
			return true
		}
	}
	return false
}
func servicePlaceholders(n int) string {
	if n == 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}
