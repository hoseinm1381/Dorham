package backend

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestNotificationsDurablePrivateDeliveryAndRevocation(t *testing.T) {
	f := newCoreFixture(t)
	a := &App{C: f.s.C, DB: f.db, Service: f.s, Mux: http.NewServeMux(), stop: make(chan struct{})}
	n := newNotifications(a)
	tokens := map[string]string{}
	sessions := map[string]string{}
	for _, who := range []string{"owner", "member", "second", "outside"} {
		token := Token()
		sid := ID()
		tokens[who] = token
		sessions[who] = sid
		f.db.Run("INSERT INTO sessions(id,user_id,access_hash,csrf,native,access_expires,expires_at,created_at) VALUES(?,?,?,?,1,?,?,?)", sid, f.users[who], Hash(token), Token(), Now()+60000, Now()+86400000, Now())
	}
	call := func(token, method, path string, body M) (int, M) {
		request := httptest.NewRequest(method, "/api/v1/notifications/"+path, bytes.NewBufferString(JSON(body)))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		a.Mux.ServeHTTP(response, request)
		var out M
		json.Unmarshal(response.Body.Bytes(), &out)
		return response.Code, out
	}
	register := func(who string) M {
		status, out := call(tokens[who], "POST", "devices", M{"installationId": ID()})
		if status != 200 {
			t.Fatalf("registration: %d %v", status, out)
		}
		return out
	}
	member := register("member")
	otherDevice := register("member")
	outsider := register("outside")
	ownerDevice := register("owner")
	poll := func(device M, ack ...any) M {
		status, out := call(Str(device, "credential"), "POST", "poll", M{"waitSeconds": 0, "ack": ack})
		if status != 200 {
			t.Fatalf("poll: %d %v", status, out)
		}
		return out
	}
	send := func(content string) M {
		event := f.s.Send(f.users["owner"], ID(), f.conversation, content, ServiceUndefined{}, nil, false)
		return Obj(event["payload"])
	}
	message := send("Private @member mention")
	// A message wakes only queued recipients, not every idle phone connection.
	selected, ignored := make(chan struct{}), make(chan struct{})
	n.polling[Str(member, "deviceId")] = selected
	n.polling[Str(outsider, "deviceId")] = ignored
	n.changed(M{"payload": message})
	select {
	case <-selected:
	default:
		t.Fatal("recipient was not woken")
	}
	select {
	case <-ignored:
		t.Fatal("unrelated notification connection was woken")
	default:
	}
	delete(n.polling, Str(member, "deviceId"))
	delete(n.polling, Str(outsider, "deviceId"))
	if len(Arr(poll(ownerDevice)["items"])) != 0 {
		t.Fatal("sender notified about own message")
	}
	items := Arr(poll(member)["items"])
	if len(items) != 1 || Str(Obj(items[0]), "id") != Str(message, "id") {
		t.Fatal("mention not queued", items)
	}
	if len(Obj(items[0])) != 2 {
		t.Fatal("private payload contains content or author data")
	}
	if len(Arr(poll(outsider)["items"])) != 0 {
		t.Fatal("outsider notified")
	}
	if len(Arr(poll(member)["items"])) != 1 {
		t.Fatal("unacknowledged delivery not retained")
	}
	if len(Arr(poll(member, message["id"])["items"])) != 0 {
		t.Fatal("acknowledgement did not clear delivery")
	}
	if len(Arr(poll(otherDevice)["items"])) != 1 {
		t.Fatal("cross-device acknowledgement")
	}
	// A reconnect can rotate the credential without losing pending delivery.
	installation := f.db.One("SELECT installation_id FROM notification_devices WHERE id=?", otherDevice["deviceId"])
	status, rotated := call(tokens["member"], "POST", "devices", M{"installationId": installation["installation_id"]})
	if status != 200 || rotated["deviceId"] != otherDevice["deviceId"] {
		t.Fatal("rotation replaced device")
	}
	if status, _ := call(Str(otherDevice, "credential"), "POST", "poll", M{"waitSeconds": 0}); status != 401 {
		t.Fatal("rotated credential still accepted")
	}
	otherDevice = rotated
	if len(Arr(poll(otherDevice)["items"])) != 1 {
		t.Fatal("rotation lost queued message")
	}
	if f.db.One("SELECT sequence FROM read_cursors WHERE user_id=? AND conversation_id=?", f.users["member"], f.conversation) != nil {
		t.Fatal("notification acknowledgement marked chat read")
	}
	if status, _ := call(Str(member, "credential"), "POST", "devices", M{"installationId": ID()}); status != 401 {
		t.Fatal("notification credential authenticated full API")
	}
	// Current permission and message state are rechecked, including queued alerts.
	f.db.Run("INSERT INTO user_blocks(user_id,blocked_id) VALUES(?,?)", f.users["member"], f.users["owner"])
	if len(Arr(poll(otherDevice)["items"])) != 0 {
		t.Fatal("blocked queued author delivered")
	}
	f.db.Run("DELETE FROM user_blocks")
	send("ordinary message")
	if len(Arr(poll(member)["items"])) != 0 {
		t.Fatal("non-mention channel message notified")
	}
	edited := send("@member original mention")
	f.s.ChangeMessage(f.users["owner"], ID(), Str(edited, "id"), M{"content": "mention removed"})
	if len(Arr(poll(member)["items"])) != 0 {
		t.Fatal("removed mention delivered")
	}
	deleted := send("@member deleted")
	f.db.Run("UPDATE messages SET deleted=1 WHERE id=?", deleted["id"])
	if len(Arr(poll(member)["items"])) != 0 {
		t.Fatal("deleted message delivered")
	}
	read := send("@member already read")
	f.db.Run("INSERT INTO read_cursors(user_id,conversation_id,sequence) VALUES(?,?,?)", f.users["member"], f.conversation, read["sequence"])
	if len(Arr(poll(member)["items"])) != 0 {
		t.Fatal("already-read message delivered")
	}
	pending := send("@member permission revoked")
	f.db.Run("DELETE FROM members WHERE server_id=? AND user_id=?", f.server, f.users["member"])
	if len(Arr(poll(member)["items"])) != 0 {
		t.Fatal("removed member notified", pending)
	}
	// Native refresh rotates access tokens, but retains the same session binding.
	f.db.Run("UPDATE sessions SET access_hash=?,access_expires=? WHERE id=?", Hash(Token()), Now()-1, sessions["member"])
	if status, _ := call(Str(member, "credential"), "POST", "poll", M{"waitSeconds": 0}); status != 200 {
		t.Fatal("notification delivery requires expired access token")
	}
	f.db.Run("DELETE FROM sessions WHERE id=?", sessions["member"])
	if status, _ := call(Str(member, "credential"), "POST", "poll", M{"waitSeconds": 0}); status != 401 {
		t.Fatal("revoked session still delivered")
	}
	if f.db.One("SELECT id FROM notification_devices WHERE id=?", member["deviceId"]) != nil {
		t.Fatal("session did not cascade")
	}
	// Direct messages require no explicit mention.
	dm := f.s.DM(f.users["owner"], ID(), f.users["outside"])
	event := f.s.Send(f.users["owner"], ID(), Str(dm, "id"), "DM secret", ServiceUndefined{}, nil, false)
	if len(Arr(poll(outsider)["items"])) != 1 {
		t.Fatal("direct message missing", event)
	}
	// Queue contents are durable across recreating the delivery manager.
	fresh := &Notifications{a: a, polling: map[string]chan struct{}{}}
	if len(fresh.pending(f.db, M{"id": outsider["deviceId"], "user_id": f.users["outside"]})) != 1 {
		t.Fatal("delivery depends on in-memory socket")
	}
	// Idle long-poll wakes on a new committed notification.
	poll(outsider, Obj(event["payload"])["id"])
	waiting := make(chan M, 1)
	go func() {
		_, out := call(Str(outsider, "credential"), "POST", "poll", M{"waitSeconds": 2})
		waiting <- out
	}()
	deadline := time.Now().Add(time.Second)
	for {
		n.mu.Lock()
		active := n.polling[Str(outsider, "deviceId")] != nil
		n.mu.Unlock()
		if active {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("poll did not start")
		}
		time.Sleep(time.Millisecond)
	}
	f.s.Send(f.users["owner"], ID(), Str(dm, "id"), "Wake", ServiceUndefined{}, nil, false)
	n.signal(Str(outsider, "deviceId"))
	select {
	case out := <-waiting:
		if len(Arr(out["items"])) != 1 {
			t.Fatal("waiter missed committed message")
		}
	case <-time.After(time.Second):
		t.Fatal("delivery did not wake")
	}
}

func TestNotificationsQueueBoundRotationAndExpiry(t *testing.T) {
	f := newCoreFixture(t)
	a := &App{C: f.s.C, DB: f.db, Service: f.s, Mux: http.NewServeMux(), stop: make(chan struct{})}
	n := newNotifications(a)
	sid := ID()
	token := Token()
	f.db.Run("INSERT INTO sessions(id,user_id,access_hash,csrf,native,access_expires,expires_at,created_at) VALUES(?,?,?,?,1,?,?,?)", sid, f.users["member"], Hash(Token()), Token(), Now()+60000, Now()+60000, Now())
	id := ID()
	f.db.Run("INSERT INTO notification_devices(id,user_id,session_id,installation_id,token_hash,created_at) VALUES(?,?,?,?,?,?)", id, f.users["member"], sid, ID(), Hash(token), Now())
	for index := 0; index < 70; index++ {
		f.s.Send(f.users["owner"], ID(), f.conversation, "@member bounded", ServiceUndefined{}, nil, false)
	}
	if N(f.db.One("SELECT COUNT(*) AS n FROM notification_queue WHERE device_id=?", id)["n"]) != 64 {
		t.Fatal("unbounded notification queue")
	}
	f.db.Run("UPDATE notification_queue SET expires_at=?", Now()-1)
	if len(n.pending(f.db, M{"id": id, "user_id": f.users["member"]})) != 0 {
		t.Fatal("expired queue delivered")
	}
	req := httptest.NewRequest("POST", "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	f.db.Run("UPDATE sessions SET expires_at=? WHERE id=?", Now()-1, sid)
	coreWantError(t, "NOTIFICATION_CREDENTIAL_EXPIRED", func() { n.device(f.db, req) })
}
