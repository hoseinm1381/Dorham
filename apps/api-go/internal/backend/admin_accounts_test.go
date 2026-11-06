package backend

import (
	"bytes"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAdminAccountLifecycle(t *testing.T) {
	a, server := integrationApp(t)
	admin, _, adminToken, _ := integrationSession(a, true)
	target, targetSession, targetToken, _ := integrationSession(a, true)
	_, _, peerToken, _ := integrationSession(a, true)
	a.DB.Run("UPDATE users SET instance_admin=1 WHERE id=?", admin)
	a.DB.Run("UPDATE users SET username='old_member',display_name='Old Name',bio='Old profile',password_hash=? WHERE id=?", PasswordHash("original-secret"), target)
	a.DB.Run("UPDATE sessions SET refresh_hash=? WHERE id=?", Hash("original-refresh-token-fixture"), targetSession)
	a.DB.Run("INSERT INTO recovery_codes(user_id,code_hash,created_at) VALUES(?,?,?)", target, Hash("recovery-fixture"), Now())
	a.DB.Run("INSERT INTO recovery_questions(user_id,question,answer_hash) VALUES(?,?,?)", target, "Fixture question", "fixture-answer")
	a.DB.Run("INSERT INTO notification_devices(id,user_id,session_id,installation_id,token_hash,created_at) VALUES(?,?,?,?,?,?)", ID(), target, targetSession, ID(), Hash(Token()), Now())
	socket, ok := integrationSocket(t, server.URL, "", "", M{"token": targetToken})
	if !ok {
		t.Fatal("target socket rejected")
	}

	call := func(token, method, path string, body M, want int) M {
		t.Helper()
		r := httptest.NewRequest(method, "/api/v1"+path, bytes.NewBufferString(JSON(body)))
		r.Header.Set("X-Dorham-Native", "1")
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		if body != nil {
			r.Header.Set("Content-Type", "application/json")
		}
		w := httptest.NewRecorder()
		a.HTTP.Handler.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s returned %d, want %d: %s", method, path, w.Code, want, w.Body.String())
		}
		return Obj(Parse(w.Body.String()))
	}
	post := func(token, path string, body M, want int) M {
		t.Helper()
		return call(token, "POST", path, Merge(M{"requestId": ID()}, body), want)
	}
	action := "/admin/users/" + target
	call("", "GET", "/admin/capabilities", nil, 401)
	call(peerToken, "GET", "/admin/capabilities", nil, 403)
	caps := call(adminToken, "GET", "/admin/capabilities", nil, 200)
	if Num(caps, "version") != 1 || Str(caps, "deletionMode") != "anonymizeKeepMessages" || !Bool(caps, "usersPagination") {
		t.Fatalf("wrong capabilities: %v", caps)
	}
	post(peerToken, action, M{"action": "setPassword", "password": "unauthorized"}, 403)
	post(adminToken, "/admin/users/"+admin, M{"action": "delete"}, 403)
	post(adminToken, action, M{"action": "setPassword", "password": "short"}, 400)
	passwordRequest := M{"action": "setPassword", "password": "temporary-chosen-سلام", "requestId": ID()}
	result := post(adminToken, action, passwordRequest, 200)
	if result["temporaryPassword"] != nil || !Bool(result, "success") {
		t.Fatalf("chosen password echoed or missing success: %v", result)
	}
	post(adminToken, action, passwordRequest, 409)
	call(targetToken, "GET", "/auth/me", nil, 401)
	post("", "/auth/refresh", M{"refreshToken": "original-refresh-token-fixture"}, 401)
	post("", "/auth/recover", M{"username": "old_member", "code": "recovery-fixture", "password": "obsolete-recovery"}, 401)
	if a.DB.One("SELECT user_id FROM notification_devices WHERE user_id=?", target) != nil ||
		a.DB.One("SELECT user_id FROM recovery_questions WHERE user_id=?", target) != nil {
		t.Fatal("notification registration or recovery question survived reset")
	}
	socket.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		if _, _, err := socket.ReadMessage(); err != nil {
			break
		}
	}
	if _, ok := integrationSocket(t, server.URL, "", "", M{"token": targetToken}); ok {
		t.Fatal("revoked socket token reconnected")
	}
	login := func(password string, status int) M {
		t.Helper()
		return post("", "/auth/login", M{"username": "old_member", "password": password}, status)
	}
	login("original-secret", 401)
	temporary := login(Str(passwordRequest, "password"), 200)
	token := Str(temporary, "accessToken")
	call(token, "GET", "/bootstrap", nil, 403)
	post(token, "/auth/password", M{"password": "replacement-password"}, 200)
	post(adminToken, action, M{"action": "ban"}, 200)
	call(token, "GET", "/auth/me", nil, 401)
	login("replacement-password", 401)
	post(adminToken, action, M{"action": "unban"}, 200)
	call(token, "GET", "/auth/me", nil, 401)
	active := login("replacement-password", 200)
	token = Str(active, "accessToken")

	serverID := Str(post(token, "/servers", M{"name": "Keep this community"}, 200), "id")
	textChannel := a.DB.One("SELECT conversation_id FROM channels WHERE server_id=? AND kind='text'", serverID)
	channel := Str(textChannel, "conversation_id")
	post(token, "/messages", M{"conversationId": channel, "content": "Keep this channel message"}, 200)
	dm := Str(post(peerToken, "/dms", M{"userId": target}, 200), "id")
	message := post(token, "/messages", M{"conversationId": dm, "content": "Keep this direct message"}, 200)
	messageID := Str(Obj(message["payload"]), "id")
	replyRequest := M{"conversationId": dm, "content": "Keep this reply", "replyTo": messageID, "requestId": ID()}
	post(peerToken, "/messages", replyRequest, 200)
	post(adminToken, action, M{"action": "delete", "confirmUsername": "Old_member"}, 400)
	call(token, "GET", "/auth/me", nil, 200)
	deleteRequest := M{"action": "delete", "confirmUsername": "old_member", "requestId": ID()}
	post(adminToken, action, deleteRequest, 200)
	post(adminToken, action, deleteRequest, 409)
	post(adminToken, action, M{"action": "unban"}, 409)
	call(token, "GET", "/auth/me", nil, 401)
	login("replacement-password", 401)
	if Str(a.DB.One("SELECT owner_id FROM servers WHERE id=?", serverID), "owner_id") != admin ||
		a.DB.One("SELECT user_id FROM members WHERE user_id=?", target) != nil {
		t.Fatal("server ownership or membership cleanup is incorrect")
	}
	for _, path := range []string{"/conversations/" + dm + "/messages", "/conversations/" + dm + "/messages?after=0"} {
		data := call(peerToken, "GET", path, nil, 200)
		raw := JSON(data)
		if !strings.Contains(raw, "Keep this direct message") || !strings.Contains(raw, "Keep this reply") ||
			!strings.Contains(raw, deletedAccountName) || strings.Contains(raw, "Old Name") || strings.Contains(raw, "Old profile") || strings.Contains(raw, "old_member") {
			t.Fatalf("history lost or exposes retired identity: %s", raw)
		}
	}
	post(peerToken, "/messages", M{"conversationId": dm, "content": "Read only"}, 403)
	post(peerToken, "/dms", M{"userId": target}, 403)
	snapshot := call(peerToken, "GET", "/bootstrap", nil, 200)
	for _, raw := range Arr(snapshot["users"]) {
		if Str(Obj(raw), "id") == target {
			t.Fatal("deleted account is still discoverable")
		}
	}
	if !strings.Contains(JSON(snapshot["dms"]), deletedAccountName) {
		t.Fatal("remaining participant lost their DM")
	}
	if strings.Contains(JSON(a.DB.All("SELECT * FROM audit_log")), Str(passwordRequest, "password")) ||
		strings.Contains(JSON(a.DB.All("SELECT * FROM mutations")), Str(passwordRequest, "password")) {
		t.Fatal("administrator password leaked into the audit or receipt")
	}
	// Existing installations can grow beyond one admin page. Identical
	// timestamps intentionally exercise the stable ID tie breaker.
	a.DB.Tx(func(tx *DB) any {
		for i := 0; i < 250; i++ {
			tx.Run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,'unused',1)", ID(), fmt.Sprintf("page_user_%03d", i), "Page fixture")
		}
		return nil
	})
	first := Arr(call(adminToken, "GET", "/admin/users", nil, 200)["users"])
	second := Arr(call(adminToken, "GET", "/admin/users?offset=250", nil, 200)["users"])
	call(adminToken, "GET", "/admin/users?offset=-1", nil, 400)
	if len(first) != 250 || len(second) != 2 {
		t.Fatalf("wrong page sizes %d/%d", len(first), len(second))
	}
	seen := map[string]bool{}
	for _, user := range append(first, second...) {
		id := Str(Obj(user), "id")
		if id == target || seen[id] {
			t.Fatal("duplicate or deleted account in list")
		}
		seen[id] = true
	}
}
