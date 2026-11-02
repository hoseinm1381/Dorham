package backend

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCoreHTTPContractsAndBackwardCompatibleBodies(t *testing.T) {
	f := newCoreFixture(t)
	a := &App{C: f.s.C, DB: f.db, Service: f.s, Mux: http.NewServeMux()}
	a.registerCore()
	tokens := map[string]string{}
	for _, name := range []string{"owner", "member", "outside"} {
		token := Token()
		tokens[name] = token
		f.db.Run("INSERT INTO sessions(id,user_id,access_hash,csrf,native,access_expires,expires_at,created_at) VALUES(?,?,?,?,1,?,?,?)", ID(), f.users[name], Hash(token), Token(), Now()+600000, Now()+600000, Now())
	}
	call := func(name, method, path string, body M) (int, M) {
		var data []byte
		if body != nil {
			data = []byte(JSON(body))
		}
		r := httptest.NewRequest(method, path, bytes.NewReader(data))
		r.Header.Set("Authorization", "Bearer "+tokens[name])
		if body != nil {
			r.Header.Set("Content-Type", "application/json")
		}
		w := httptest.NewRecorder()
		a.middleware(a.Mux).ServeHTTP(w, r)
		var parsed M
		if w.Body.Len() > 0 {
			parsed = Obj(Parse(w.Body.String()))
		}
		return w.Code, parsed
	}
	status, boot := call("owner", "GET", "/api/v1/bootstrap", nil)
	coreRequire(t, status == 200 && S(Obj(boot["me"])["id"]) == f.users["owner"], "bootstrap HTTP: %d %s", status, JSON(boot))
	rid := ID()
	status, first := call("owner", "POST", "/api/v1/servers", M{"name": "HTTP server", "requestId": rid, "ignored": "first"})
	coreRequire(t, status == 200, "server HTTP: %d %s", status, JSON(first))
	status, again := call("owner", "POST", "/api/v1/servers", M{"name": "HTTP server", "requestId": rid, "ignored": "changed"})
	coreRequire(t, status == 200 && S(first["id"]) == S(again["id"]), "unknown stripped fields must not alter fingerprint")
	status, result := call("owner", "POST", "/api/v1/servers/"+f.server+"/roles", M{"name": "Invalid", "color": "#123456", "permissions": M{}, "requestId": ID(), "unknown": true})
	coreRequire(t, status == 400 && S(Obj(result["error"])["code"]) == "VALIDATION", "strict role body")
	status, result = call("member", "POST", "/api/v1/messages", M{"conversationId": f.conversation, "content": "invalid reply type", "replyTo": 123, "requestId": ID()})
	coreRequire(t, status == 400, "numeric reply must be rejected")
	status, event := call("member", "POST", "/api/v1/messages", M{"conversationId": f.conversation, "content": "  سلام  ", "requestId": ID(), "ignored": "discard"})
	coreRequire(t, status == 200 && S(Obj(event["payload"])["content"]) == "سلام", "message trimmed contract: %d %s", status, JSON(event))
	message := S(Obj(event["payload"])["id"])
	status, _ = call("member", "PATCH", "/api/v1/messages/"+message, M{"emoji": ":emoji-duck:", "requestId": ID()})
	if coreReactionValues[":emoji-duck:"] {
		coreRequire(t, status == 200, "catalog reaction rejected")
	} else {
		coreRequire(t, status == 400, "unknown reaction accepted")
	}
	status, _ = call("member", "PATCH", "/api/v1/messages/"+message, M{"emoji": "👍", "requestId": ID()})
	coreRequire(t, status == 200, "legacy reaction key must remain accepted")
	status, _ = call("member", "PATCH", "/api/v1/messages/"+message, M{"emoji": "arbitrary-reaction", "requestId": ID()})
	coreRequire(t, status == 400, "uncatalogued reaction accepted")
	status, _ = call("member", "GET", "/api/v1/conversations/"+f.conversation+"/messages?after=", nil)
	coreRequire(t, status == 200, "coerced empty after should be zero")
	status, _ = call("outside", "GET", "/api/v1/conversations/"+f.conversation+"/messages", nil)
	coreRequire(t, status == 403, "unauthorized history")
	status, _ = call("owner", "POST", "/api/v1/servers/"+f.server+"/members/"+f.users["member"]+"/moderate", M{"action": "timeout", "seconds": 60, "requestId": ID()})
	coreRequire(t, status == 200, "timeout route")
	status, result = call("member", "POST", "/api/v1/messages", M{"conversationId": f.conversation, "content": "timed out", "requestId": ID()})
	coreRequire(t, status == 403 && S(Obj(result["error"])["code"]) == "TIMED_OUT", "timeout must block HTTP message")
}

type coreFixture struct {
	s                                 *Service
	db                                *DB
	users                             map[string]string
	server, text, voice, conversation string
}

func newCoreFixture(t *testing.T) *coreFixture {
	t.Helper()
	c := Config{DataDir: t.TempDir(), PublicURL: "https://dorham.example", MaxDatabaseMiB: 32, MaxUsers: 100, MaxOnline: 20, MaxVoice: 16, StandardShareSlots: 3, ScreenMaxFrameRate: 30, ScreenMaxBitrate: 1500000, RetentionDays: 90, MaxMessages: 50000, MediaTransport: "mesh", RegistrationOpen: true, GuestsEnabled: true}
	db := OpenDB(c)
	t.Cleanup(db.Close)
	s := NewService(db, c)
	f := &coreFixture{s: s, db: db, users: map[string]string{}}
	for _, name := range []string{"owner", "admin", "admin2", "mod", "member", "second", "guest", "outside"} {
		id := ID()
		f.users[name] = id
		db.Run("INSERT INTO users(id,username,display_name,password_hash,created_at,guest) VALUES(?,?,?,?,?,?)", id, name, name, "fixture-only", Now(), serviceBoolInt(name == "guest"))
	}
	f.server = S(s.CreateServer(f.users["owner"], ID(), "Fixture")["id"])
	for _, name := range []string{"admin", "admin2", "mod", "member", "second", "guest"} {
		role := "member"
		if name == "admin" || name == "admin2" {
			role = "administrator"
		} else if name == "mod" {
			role = "moderator"
		}
		db.Run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES(?,?,?,?)", f.server, f.users[name], role, Now())
	}
	for _, ch := range db.All("SELECT * FROM channels WHERE server_id=?", f.server) {
		if S(ch["kind"]) == "text" {
			f.text = S(ch["id"])
			f.conversation = S(ch["conversation_id"])
		} else {
			f.voice = S(ch["id"])
		}
	}
	return f
}
func coreWantError(t *testing.T, code string, fn func()) {
	t.Helper()
	var caught any
	func() { defer func() { caught = recover() }(); fn() }()
	if caught == nil {
		t.Fatalf("expected %s error", code)
	}
	e := RecoverError(caught)
	if e.Code != code {
		t.Fatalf("wanted %s got %#v (raw %v)", code, e, caught)
	}
}
func coreRequire(t *testing.T, ok bool, message string, args ...any) {
	t.Helper()
	if !ok {
		t.Fatalf(message, args...)
	}
}

func TestCorePermissionsAndMentionTokens(t *testing.T) {
	p := ResolveCustomPermissions("member", []M{{"write": true, "moderate": true}, {"write": false}}, M{"share": false})
	coreRequire(t, !B(p["write"]) && B(p["moderate"]) && !B(p["share"]), "custom denies and channel overrides")
	p = ResolveCustomPermissions("owner", []M{{"view": false, "manageMembers": false}}, M{"share": false})
	coreRequire(t, B(p["view"]) && B(p["share"]) && B(p["manageMembers"]), "owners must retain permissions")
	coreRequire(t, !CanManage("administrator", "administrator") && CanMoveMember("administrator", "administrator") && !CanMoveMember("administrator", "owner"), "hierarchy: peer moves only")
	names := MentionNames("@First سلام @second @FIRST a@ignore https://example.org/@hidden `@code` /@slash \\@escape @short_1! @نام @abcنام @abcdefghijklmnopqrstuvwxyz0123456789 @ok_ ")
	coreRequire(t, strings.Join(names, ",") == "first,second,short_1,ok_", "mention token protection: %v", names)
	requested, text := TTSMessage(" /TTS  سلام ")
	coreRequire(t, requested && text == "سلام", "TTS stripping")
	requested, text = TTSMessage("/ttsomething")
	coreRequire(t, !requested && text == "/ttsomething", "ordinary slash text")
}
func TestCoreMutationReceiptsRollbackAndLegacyReplay(t *testing.T) {
	f := newCoreFixture(t)
	uid := f.users["owner"]
	rid := ID()
	one := f.s.CreateChannel(uid, rid, f.server, "Receipts", "text")
	two := f.s.CreateChannel(uid, rid, f.server, "Receipts", "text")
	coreRequire(t, S(one["id"]) == S(two["id"]), "same request replay must not duplicate")
	coreWantError(t, "IDEMPOTENCY_CONFLICT", func() { f.s.CreateChannel(uid, rid, f.server, "Changed", "text") })
	before := N(f.db.One("SELECT COUNT(*) AS count FROM channels")["count"])
	coreWantError(t, "ROLLBACK", func() {
		f.s.Mutate(uid, ID(), "test.rollback", M{}, func(tx *DB) any {
			f.s.InsertChannel(tx, f.server, "Rolled back", "text")
			Fail(409, "ROLLBACK", "fixture")
			return nil
		})
	})
	coreRequire(t, N(f.db.One("SELECT COUNT(*) AS count FROM channels")["count"]) == before, "failed mutation leaked writes")
	rid = ID()
	legacy := `{"serverId":"` + f.server + `","name":"Legacy","kind":"text"}`
	response := M{"id": ID()}
	f.db.Run("INSERT INTO mutations(user_id,request_id,operation,fingerprint,response,created_at) VALUES(?,?,?,?,?,?)", uid, rid, "channel.create", Hash(legacy), JSON(response), Now())
	replayed := f.s.CreateChannel(uid, rid, f.server, "Legacy", "text")
	coreRequire(t, S(replayed["id"]) == S(response["id"]), "legacy Node JSON order receipt not replayed")
	coreWantError(t, "IDEMPOTENCY_CONFLICT", func() { f.s.CreateChannel(uid, rid, f.server, "Legacy changed", "text") })
	body := M{"requestId": ID(), "name": "New", "permissions": M{"write": false, "view": true}}
	legacyJSON := serviceLegacyJSON("channel.change", Merge(M{"channelId": "c"}, body))
	coreRequire(t, legacyJSON == `{"channelId":"c","name":"New","permissions":{"view":true,"write":false},"requestId":"`+S(body["requestId"])+`"}`, "nested legacy schema order: %s", legacyJSON)
	coreRequire(t, serviceJSON("\u2028\\u2028") == "\"\u2028\\\\u2028\"", "legacy JSON must preserve literal backslash-u separately from line separators")
}
func TestCoreMessagesMentionsReactionsHistoryAndAuthorization(t *testing.T) {
	f := newCoreFixture(t)
	member := f.users["member"]
	event := f.s.Send(member, ID(), f.conversation, "سلام @second @outside `@owner`", ServiceUndefined{}, nil, false)
	msg := Obj(event["payload"])
	id := S(msg["id"])
	mentions := Arr(msg["mentions"])
	coreRequire(t, len(mentions) == 1 && S(Obj(mentions[0])["userId"]) == f.users["second"], "mentions must bind only accessible server recipients")
	event = f.s.ChangeMessage(f.users["second"], ID(), id, M{"emoji": "🦆"})
	coreRequire(t, len(Arr(Obj(event["payload"])["reactions"])) == 1, "reaction missing")
	f.s.ChangeMessage(f.users["second"], ID(), id, M{"emoji": "🦆", "removeReaction": true})
	coreRequire(t, len(Arr(f.s.MessageView(f.db, id)["reactions"])) == 0, "reaction did not clear")
	coreWantError(t, "FORBIDDEN", func() { f.s.ChangeMessage(f.users["second"], ID(), id, M{"content": "hijacked"}) })
	f.s.ChangeMessage(member, ID(), id, M{"content": "edited @owner"})
	coreRequire(t, S(Obj(Arr(f.s.MessageView(f.db, id)["mentions"])[0])["userId"]) == f.users["owner"], "edit must rebind mentions")
	history := f.s.History(member, f.conversation, nil, nil)
	coreRequire(t, len(Arr(history["messages"])) == 1 && N(history["sequence"]) == 4, "history sequence: %s", JSON(history))
	after := int64(0)
	events := f.s.History(member, f.conversation, nil, &after)
	coreRequire(t, !B(events["reset"]) && len(Arr(events["events"])) == 4, "event replay")
	f.s.Read(member, ID(), f.conversation, 999)
	f.s.Read(member, ID(), f.conversation, 0)
	coreRequire(t, N(f.db.One("SELECT sequence FROM read_cursors WHERE conversation_id=? AND user_id=?", f.conversation, member)["sequence"]) == 4, "read cursor must be monotonic and clamped")
	f.s.ChangeMessage(f.users["mod"], ID(), id, M{"delete": true})
	msg = f.s.MessageView(f.db, id)
	coreRequire(t, B(msg["deleted"]) && S(msg["content"]) == "" && len(Arr(msg["mentions"])) == 0, "moderator deletion tombstone")
	coreWantError(t, "DELETED", func() { f.s.ChangeMessage(member, ID(), id, M{"emoji": "👍"}) })
	coreWantError(t, "FORBIDDEN", func() { f.s.History(f.users["outside"], f.conversation, nil, nil) })
	f.db.Run("DELETE FROM events WHERE sequence<3")
	events = f.s.History(member, f.conversation, nil, &after)
	coreRequire(t, B(events["reset"]), "event gap must require reset")
}
func TestCoreDMPrivacyBlockingAndReopen(t *testing.T) {
	f := newCoreFixture(t)
	a, b := f.users["member"], f.users["second"]
	dm := S(f.s.DM(a, ID(), b)["id"])
	coreRequire(t, S(f.s.DM(b, ID(), a)["id"]) == dm, "DM pair must be unordered and unique")
	coreWantError(t, "FORBIDDEN", func() { f.s.History(f.users["outside"], dm, nil, nil) })
	f.s.CloseDirectMessage(b, ID(), dm)
	coreRequire(t, N(f.db.One("SELECT hidden FROM dm_members WHERE user_id=? AND conversation_id=?", b, dm)["hidden"]) == 1, "close must hide only own DM")
	f.s.Send(a, ID(), dm, "reopen", nil, nil, false)
	coreRequire(t, N(f.db.One("SELECT hidden FROM dm_members WHERE user_id=? AND conversation_id=?", b, dm)["hidden"]) == 0, "send must reopen counterpart DM")
	f.s.BlockUser(b, ID(), a, true)
	coreWantError(t, "DM_BLOCKED", func() { f.s.Send(a, ID(), dm, "blocked", nil, nil, false) })
	f.s.BlockUser(b, ID(), a, false)
	f.s.Send(a, ID(), dm, "allowed", nil, nil, false)
	coreWantError(t, "SELF_BLOCK", func() { f.s.BlockUser(a, ID(), a, true) })
	coreWantError(t, "GUEST_DM", func() { f.s.DM(f.users["guest"], ID(), f.users["outside"]) })
}
func TestCoreInvitesGuestPolicyAndRoleChanges(t *testing.T) {
	f := newCoreFixture(t)
	owner, member, outside := f.users["owner"], f.users["member"], f.users["outside"]
	code := Token()
	invite := f.s.Invite(owner, ID(), f.server, code, 1, 1, f.text)
	coreRequire(t, S(invite["url"]) == "https://dorham.example/?invite="+code, "invite URL")
	joined := f.s.JoinInvite(outside, ID(), code)
	coreRequire(t, S(joined["id"]) == f.server && S(joined["channelId"]) == f.text, "invite channel selection")
	coreWantError(t, "INVITE_EXPIRED", func() { f.s.JoinInvite(member, ID(), code) })
	f.s.ChangeServer(owner, ID(), f.server, M{"allowMemberInvites": false})
	coreWantError(t, "FORBIDDEN", func() { f.s.Invite(member, ID(), f.server, Token(), 1, 1) })
	coreWantError(t, "GUEST_ACCOUNT", func() { f.s.CreateServer(f.users["guest"], ID(), "No guest server") })
	coreWantError(t, "HIERARCHY", func() { f.s.ChangeMember(f.users["admin"], ID(), f.server, f.users["admin2"], M{"remove": true}) })
	coreWantError(t, "GUEST_ROLE", func() { f.s.ChangeMember(owner, ID(), f.server, f.users["guest"], M{"role": "moderator"}) })
	f.s.ChangeMember(owner, ID(), f.server, member, M{"role": "moderator"})
	coreRequire(t, S(f.db.One("SELECT role FROM members WHERE server_id=? AND user_id=?", f.server, member)["role"]) == "moderator", "owner promotion")
	coreWantError(t, "OWNER_LEAVE", func() { f.s.LeaveServer(owner, ID(), f.server) })
	f.s.LeaveServer(outside, ID(), f.server)
	coreWantError(t, "FORBIDDEN", func() { f.s.Member(f.db, outside, f.server) })
}
func TestCoreCustomRolesChannelRevisionsAndTimeout(t *testing.T) {
	f := newCoreFixture(t)
	owner, member := f.users["owner"], f.users["member"]
	id := S(f.s.ChangeCustomRole(owner, ID(), f.server, M{"name": "Helper", "color": "#123456", "permissions": M{"moderate": true, "write": false}})["id"])
	f.s.ChangeCustomRole(owner, ID(), f.server, M{"roleId": id, "userId": member, "assigned": true})
	m := f.s.Member(f.db, member, f.server)
	coreRequire(t, f.s.Authority(f.db, m) == "moderator" && !B(f.s.MemberPermissions(f.db, "member", member, f.server)["write"]), "custom role authority/deny")
	coreWantError(t, "FORBIDDEN", func() { f.s.Send(member, ID(), f.conversation, "denied", nil, nil, false) })
	f.s.ChangeChannel(owner, ID(), f.text, M{"role": "member", "permissions": M{"write": true}, "expectedRevision": 0})
	coreRequire(t, B(Obj(f.s.Channel(f.db, member, f.text)["permissions"])["write"]), "channel override applied last")
	coreWantError(t, "STALE_PERMISSIONS", func() {
		f.s.ChangeChannel(owner, ID(), f.text, M{"role": "member", "permissions": M{"write": false}, "expectedRevision": 0})
	})
	coreWantError(t, "UPGRADE_REQUIRED", func() { f.s.ChangeChannel(owner, ID(), f.text, M{"role": "member", "permissions": M{"write": false}}) })
	f.s.ModerateMember(owner, ID(), f.server, member, M{"action": "timeout", "seconds": 60})
	coreWantError(t, "TIMED_OUT", func() { f.s.Send(member, ID(), f.conversation, "timed out", nil, nil, false) })
	coreWantError(t, "TIMED_OUT", func() { f.s.JoinVoice(member, "socket", f.voice, true) })
	f.s.History(member, f.conversation, nil, nil)
	f.s.ModerateMember(owner, ID(), f.server, member, M{"action": "untimeout"})
	f.s.Send(member, ID(), f.conversation, "restored", nil, nil, false)
}
func TestCoreVoiceEpochsLivenessRestrictionsAndPeerMoves(t *testing.T) {
	f := newCoreFixture(t)
	member, admin, peer := f.users["member"], f.users["admin"], f.users["admin2"]
	first := f.s.JoinVoice(member, "one", f.voice, true)
	second := f.s.JoinVoice(member, "two", f.voice, true)
	coreRequire(t, S(first["epoch"]) != S(second["epoch"]), "socket takeover must rotate epoch")
	coreWantError(t, "NOT_IN_VOICE", func() { f.s.VoiceAction(member, "one", "heartbeat") })
	coreRequire(t, S(f.s.JoinVoice(member, "two", f.voice, true)["epoch"]) == S(second["epoch"]), "same socket join must preserve epoch")
	f.s.Moderate(admin, ID(), f.voice, member, "mute")
	room := f.s.Room(member, f.voice)
	coreRequire(t, B(Obj(Arr(room["members"])[0])["serverMuted"]), "server mute state")
	f.s.VoiceAction(member, "two", "state", M{"muted": false})
	coreRequire(t, B(f.db.One("SELECT server_muted FROM voice_members WHERE user_id=?", member)["server_muted"]), "client cannot bypass server mute")
	f.s.Moderate(admin, ID(), f.voice, member, "deafen")
	coreRequire(t, B(f.db.One("SELECT server_deafened FROM voice_members WHERE user_id=?", member)["server_deafened"]), "server deafen")
	f.s.JoinVoice(peer, "peer", f.voice, true)
	destination := S(f.s.CreateChannel(f.users["owner"], ID(), f.server, "Other voice", "voice")["id"])
	f.s.MoveVoice(admin, ID(), f.voice, peer, destination)
	coreRequire(t, f.db.One("SELECT user_id FROM voice_members WHERE user_id=?", peer) == nil, "peer move must end old session before directed rejoin")
	coreWantError(t, "HIERARCHY", func() { f.s.ModerateMember(admin, ID(), f.server, peer, M{"action": "ban"}) })
	f.db.Run("UPDATE voice_members SET heartbeat=? WHERE user_id=?", Now()-31000, member)
	f.s.Cleanup()
	coreRequire(t, f.db.One("SELECT user_id FROM voice_members WHERE user_id=?", member) == nil, "stale voice expiration")
}
func TestCoreVoiceTagLocksLimitsAndDirectoryPrivacy(t *testing.T) {
	f := newCoreFixture(t)
	owner, member, second := f.users["owner"], f.users["member"], f.users["second"]
	tag := S(f.s.ChangeTag(owner, ID(), f.server, M{"name": "Access"})["id"])
	f.s.VoicePolicy(owner, ID(), f.voice, M{"locked": false, "userLimit": 1, "tagMode": "ALL", "requiredTags": []string{tag}})
	coreWantError(t, "TAG_REQUIRED", func() { f.s.JoinVoice(member, "m", f.voice, true) })
	f.s.ChangeTag(owner, ID(), f.server, M{"tagId": tag, "userId": member, "assigned": true})
	f.s.JoinVoice(member, "m", f.voice, true)
	f.s.ChangeTag(owner, ID(), f.server, M{"tagId": tag, "userId": second, "assigned": true})
	coreWantError(t, "ROOM_FULL", func() { f.s.JoinVoice(second, "s", f.voice, true) })
	coreRequire(t, len(f.s.VoiceDirectory(f.users["outside"])) == 0, "directory must hide unauthorized room")
	f.s.ChangeTag(owner, ID(), f.server, M{"tagId": tag, "userId": member, "assigned": false})
	coreRequire(t, f.db.One("SELECT user_id FROM voice_members WHERE user_id=?", member) == nil, "tag revoke must evict voice immediately")
}
func TestCoreShareTierPromotionRevisionAndLeaseOwnership(t *testing.T) {
	f := newCoreFixture(t)
	f.s.C.StandardShareSlots = 1
	owner, member, second := f.users["owner"], f.users["member"], f.users["second"]
	other := S(f.s.CreateChannel(owner, ID(), f.server, "Second room", "voice")["id"])
	f.s.JoinVoice(member, "m", f.voice, true)
	f.s.JoinVoice(second, "s", other, true)
	one := Obj(f.s.Share(member, "m", ID(), false, true)["lease"])
	two := Obj(f.s.Share(second, "s", ID(), false, false)["lease"])
	coreRequire(t, S(one["tier"]) == "standard" && S(two["tier"]) == "fallback" && N(two["maxFrameRate"]) == 15, "standard/fallback allocation")
	coreWantError(t, "SHARE_TIER", func() {
		f.s.UpdateShare(second, "s", ID(), M{"leaseId": two["id"], "expectedRevision": 1, "frameRate": 30})
	})
	coreWantError(t, "SHARE_EXPIRED", func() {
		f.s.UpdateShare(member, "m", ID(), M{"leaseId": two["id"], "expectedRevision": 1, "frameRate": 15})
	})
	f.s.Share(member, "m", ID(), true, false)
	row := f.db.One("SELECT * FROM share_leases WHERE id=?", two["id"])
	coreRequire(t, S(row["tier"]) == "standard" && N(row["policy_revision"]) == 2, "oldest fallback must be promoted and fenced")
	coreWantError(t, "STALE_SHARE", func() {
		f.s.UpdateShare(second, "s", ID(), M{"leaseId": two["id"], "expectedRevision": 1, "frameRate": 30})
	})
	updated := Obj(f.s.UpdateShare(second, "s", ID(), M{"leaseId": two["id"], "expectedRevision": 2, "frameRate": 30, "includeAudio": false})["lease"])
	coreRequire(t, N(updated["requestedFrameRate"]) == 30 && N(updated["policyRevision"]) == 3 && !B(updated["includeAudio"]), "share revision update")
	f.s.VoiceAction(second, "s", "leave")
	coreRequire(t, f.db.One("SELECT id FROM share_leases WHERE id=?", two["id"]) == nil, "leaving voice must cascade lease")
}
func TestCoreModerationBanTimeoutAndGuestIsolation(t *testing.T) {
	f := newCoreFixture(t)
	owner, member, guest := f.users["owner"], f.users["member"], f.users["guest"]
	info := f.s.ModerationInfo(f.users["admin"], f.server, f.users["admin2"])
	coreRequire(t, !B(Obj(info["actions"])["ban"]) && B(Obj(info["actions"])["move"]), "peer moderation capabilities")
	info = f.s.ModerationInfo(owner, f.server, f.users["admin"])
	coreRequire(t, B(Obj(info["actions"])["ban"]), "owner highest priority")
	f.s.ModerateMember(owner, ID(), f.server, member, M{"action": "ban", "reason": "fixture"})
	coreWantError(t, "SERVER_BANNED", func() { f.s.Member(f.db, member, f.server) })
	coreRequire(t, len(Arr(f.s.ServerBans(owner, f.server)["bans"])) == 1, "ban listing")
	f.s.ModerateMember(owner, ID(), f.server, member, M{"action": "unban"})
	coreRequire(t, len(Arr(f.s.ServerBans(owner, f.server)["bans"])) == 0, "unban")
	f.s.ChangeServer(owner, ID(), f.server, M{"allowGuests": false})
	coreWantError(t, "GUESTS_DISABLED", func() { f.s.Member(f.db, guest, f.server) })
}
func TestCoreSnapshotAudienceAndTTSDeliveryBoundary(t *testing.T) {
	f := newCoreFixture(t)
	member := f.users["member"]
	viewers := []M{{"socketId": "member", "userId": member}, {"socketId": "outside", "userId": f.users["outside"]}, {"socketId": "second", "userId": f.users["second"]}}
	audience := f.s.ConversationAudience(viewers, f.conversation)
	coreRequire(t, strings.Join(audience, ",") == "member,second", "authorized audience snapshot")
	var spoken int
	f.s.OnTTS = func(uid string, m M) {
		spoken++
		coreRequire(t, uid == member && S(m["content"]) == "سلام", "TTS receives stored message")
	}
	f.s.Send(member, ID(), f.conversation, "/tts سلام", nil, nil, false)
	coreRequire(t, spoken == 1, "TTS callback")
	f.s.Send(member, ID(), f.conversation, "ordinary", nil, nil, false)
	coreRequire(t, spoken == 1, "ordinary message triggered TTS")
	f.s.JoinVoice(member, "member", f.voice, true)
	snap := f.s.VoiceSnapshot([]M{{"socketId": "member", "userId": member, "channelId": f.voice}, {"socketId": "outside", "userId": f.users["outside"], "channelId": f.voice}})
	coreRequire(t, Obj(snap[0]["room"])["channelId"] == f.voice && snap[1]["room"] == nil, "voice snapshots must authorize each viewer")
}
func TestCoreCloudflareTURNBoundedSingleFlightAndSafeFailure(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Header.Get("Authorization") != "Bearer fixture-secret" {
			t.Error("missing provider authorization")
		}
		time.Sleep(5 * time.Millisecond)
		fmt.Fprint(w, `{"iceServers":[{"urls":["stun:stun.cloudflare.com:3478","turn:turn.cloudflare.com:3478?transport=udp","turn:attacker.example:3478"],"username":"fixture","credential":"secret"}]}`)
	}))
	defer server.Close()
	turn := NewCloudflareTurn("fixture", "fixture-secret")
	turn.baseURL = server.URL
	turn.client = server.Client()
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rows := turn.ForUser("u")
			if len(rows) != 1 || len(serviceStrings(rows[0]["urls"])) != 2 {
				t.Error("unexpected relay filtering")
			}
		}()
	}
	wg.Wait()
	coreRequire(t, requests.Load() == 1, "TURN should single-flight per user; got %d", requests.Load())
	rows := turn.ForUser("u")
	rows[0]["username"] = "changed"
	coreRequire(t, S(turn.ForUser("u")[0]["username"]) == "fixture", "TURN response shared mutable cache")
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"iceServers":[{"urls":"turn:turn.cloudflare.com:3478"}]}`)
	}))
	defer bad.Close()
	turn = NewCloudflareTurn("fixture", "super-secret")
	turn.baseURL = bad.URL
	turn.client = bad.Client()
	coreWantError(t, "TURN_UNAVAILABLE", func() { turn.ForUser("u") })
}
