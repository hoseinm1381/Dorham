package backend

import (
	"net/http"
	"strings"
	"sync"
	"time"
)

// Notification credentials grant only generic DM/mention delivery and acknowledgement.
// They never authenticate normal API actions or carry message contents.
type Notifications struct {
	a       *App
	mu      sync.Mutex
	polling map[string]chan struct{}
}

func newNotifications(a *App) *Notifications {
	n := &Notifications{a: a, polling: map[string]chan struct{}{}}
	a.Service.OnMessage = n.enqueue
	n.register()
	return n
}
func (n *Notifications) signal(ids ...string) {
	n.mu.Lock()
	for _, id := range ids {
		if wake := n.polling[id]; wake != nil {
			close(wake)
			n.polling[id] = make(chan struct{})
		}
	}
	n.mu.Unlock()
}
func (n *Notifications) changed(event M) {
	id := Str(Obj(event["payload"]), "id")
	if id == "" {
		return
	}
	for _, row := range n.a.DB.All("SELECT device_id FROM notification_queue WHERE message_id=?", id) {
		n.signal(Str(row, "device_id"))
	}
}
func (n *Notifications) allowed(tx *DB, uid string, message M) bool {
	if message == nil || Bool(message, "deleted") || Str(message, "user_id") == uid {
		return false
	}
	user := tx.One("SELECT id,status FROM users WHERE id=? AND banned=0 AND must_change_password=0", uid)
	if user == nil || Str(user, "status") == "busy" {
		return false
	}
	author := Str(message, "user_id")
	conversation := Str(message, "conversation_id")
	if tx.One("SELECT user_id FROM user_blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)", uid, author, author, uid) != nil {
		return false
	}
	if read := tx.One("SELECT sequence FROM read_cursors WHERE user_id=? AND conversation_id=?", uid, conversation); N(read["sequence"]) >= N(message["sequence"]) {
		return false
	}
	var cv M
	if failure := serviceAttempt(func() { cv = n.a.Service.Conversation(tx, uid, conversation) }); failure != nil {
		if serviceAuthorizationError(failure) {
			return false
		}
		panic(failure)
	}
	return Str(cv, "kind") == "dm" || tx.One("SELECT user_id FROM message_mentions WHERE user_id=? AND message_id=?", uid, message["id"]) != nil
}
func (n *Notifications) enqueue(tx *DB, view M) {
	message := tx.One("SELECT * FROM messages WHERE id=?", view["id"])
	if message == nil {
		return
	}
	// Only registered recipients are considered; no fanout across all accounts.
	devices := tx.All("SELECT d.id,d.user_id FROM notification_devices d JOIN sessions s ON s.id=d.session_id WHERE s.expires_at>? AND (EXISTS(SELECT 1 FROM dm_members dm WHERE dm.conversation_id=? AND dm.user_id=d.user_id) OR EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.message_id=? AND mm.user_id=d.user_id))", Now(), message["conversation_id"], message["id"])
	checked := map[string]bool{}
	eligible := map[string]bool{}
	for _, device := range devices {
		uid := Str(device, "user_id")
		if !checked[uid] {
			eligible[uid] = n.allowed(tx, uid, message)
			checked[uid] = true
		}
		if !eligible[uid] {
			continue
		}
		tx.Run("DELETE FROM notification_queue WHERE device_id=? AND expires_at<?", device["id"], Now())
		tx.Run("INSERT INTO notification_queue(device_id,message_id,created_at,expires_at) VALUES(?,?,?,?) ON CONFLICT(device_id,message_id) DO NOTHING", device["id"], message["id"], Now(), Now()+7*86400000)
		tx.Run("DELETE FROM notification_queue WHERE device_id=? AND message_id IN (SELECT message_id FROM notification_queue WHERE device_id=? ORDER BY created_at DESC,message_id DESC LIMIT 100 OFFSET 64)", device["id"], device["id"])
	}
}
func (n *Notifications) device(tx *DB, req *http.Request) M {
	raw := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
	Check(len(raw) >= 32 && len(raw) <= 128, 401, "NOTIFICATION_CREDENTIAL_EXPIRED", "Enable notifications again in Dorham.")
	device := tx.One("SELECT d.id,d.user_id FROM notification_devices d JOIN sessions s ON s.id=d.session_id JOIN users u ON u.id=d.user_id WHERE d.token_hash=? AND s.native=1 AND s.user_id=d.user_id AND s.expires_at>? AND u.banned=0 AND u.must_change_password=0", Hash(raw), Now())
	Check(device != nil, 401, "NOTIFICATION_CREDENTIAL_EXPIRED", "Enable notifications again in Dorham.")
	return device
}
func (n *Notifications) pending(tx *DB, device M) []M {
	items := []M{}
	for _, row := range tx.All("SELECT m.*,q.expires_at FROM notification_queue q JOIN messages m ON m.id=q.message_id WHERE q.device_id=? ORDER BY q.created_at,q.message_id LIMIT 64", device["id"]) {
		if N(row["expires_at"]) <= Now() || !n.allowed(tx, Str(device, "user_id"), row) {
			tx.Run("DELETE FROM notification_queue WHERE device_id=? AND message_id=?", device["id"], row["id"])
			continue
		}
		items = append(items, M{"id": row["id"], "conversationId": row["conversation_id"]})
	}
	return items
}
func (n *Notifications) register() {
	a := n.a
	a.Route("GET", "/api/v1/notifications/config", false, func(r *Request) any { return M{"available": true, "transport": "dorham-direct", "firebase": false} })
	a.Route("POST", "/api/v1/notifications/devices", true, func(r *Request) any {
		Check(Bool(r.Session, "native"), 403, "NATIVE_REQUIRED", "Use the Android app.")
		installation := VString(r.Body, "installationId", 36, 36, false)
		Check(requestUUID.MatchString(installation), 400, "VALIDATION", "Invalid installation identifier.")
		token := Token()
		id := ID()
		a.DB.Tx(func(tx *DB) any {
			old := tx.One("SELECT id FROM notification_devices WHERE session_id=? AND installation_id=?", r.Session["id"], installation)
			if old != nil {
				id = Str(old, "id")
			} else {
				Check(N(tx.One("SELECT COUNT(*) AS n FROM notification_devices WHERE user_id=?", r.UID())["n"]) < 8, 409, "DEVICE_LIMIT", "Remove an old signed-in device first.")
			}
			tx.Run("INSERT INTO notification_devices(id,user_id,session_id,installation_id,token_hash,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(session_id,installation_id) DO UPDATE SET token_hash=excluded.token_hash", id, r.UID(), r.Session["id"], installation, Hash(token), Now())
			if Bool(r.Body, "resetQueue") {
				tx.Run("DELETE FROM notification_queue WHERE device_id=?", id)
			}
			return nil
		})
		n.signal(id)
		r.Header("Cache-Control", "no-store")
		return M{"deviceId": id, "credential": token}
	})
	a.Route("DELETE", "/api/v1/notifications/devices", true, func(r *Request) any {
		devices := a.DB.All("SELECT id FROM notification_devices WHERE session_id=?", r.Session["id"])
		a.DB.Run("DELETE FROM notification_devices WHERE session_id=?", r.Session["id"])
		for _, device := range devices {
			n.signal(Str(device, "id"))
		}
		return M{"success": true}
	})
	a.Route("POST", "/api/v1/notifications/poll", false, func(r *Request) any {
		device := n.device(a.DB, r.R)
		id := Str(device, "id")
		n.mu.Lock()
		busy := n.polling[id] != nil || len(n.polling) >= max(32, a.C.MaxOnline*2)
		if !busy {
			n.polling[id] = make(chan struct{})
		}
		n.mu.Unlock()
		Check(!busy, 429, "NOTIFICATION_BUSY", "Notification connection is already active.")
		defer func() { n.mu.Lock(); delete(n.polling, id); n.mu.Unlock() }()
		ack := Arr(r.Body["ack"])
		Check(len(ack) <= 64, 400, "VALIDATION", "Too many acknowledgements.")
		for _, value := range ack {
			Check(requestUUID.MatchString(S(value)), 400, "VALIDATION", "Invalid notification identifier.")
		}
		wait := VInt(r.Body, "waitSeconds", 0, 55)
		a.DB.Tx(func(tx *DB) any {
			n.device(tx, r.R)
			for _, value := range ack {
				tx.Run("DELETE FROM notification_queue WHERE device_id=? AND message_id=?", id, S(value))
			}
			return nil
		})
		deadline := time.NewTimer(time.Duration(wait) * time.Second)
		defer deadline.Stop()
		check := time.NewTicker(15 * time.Second)
		defer check.Stop()
		r.Header("Cache-Control", "no-store")
		for {
			n.mu.Lock()
			wake := n.polling[id]
			n.mu.Unlock()
			var items []M
			a.DB.Tx(func(tx *DB) any { device = n.device(tx, r.R); items = n.pending(tx, device); return nil })
			if len(items) > 0 || wait == 0 {
				return M{"items": items}
			}
			select {
			case <-wake:
			case <-check.C:
			case <-deadline.C:
				return M{"items": []M{}}
			case <-r.R.Context().Done():
				return nil
			case <-a.stop:
				return nil
			}
		}
	})
}
