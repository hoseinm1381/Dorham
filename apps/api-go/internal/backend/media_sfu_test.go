package backend

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestMediaAdmissionRechecksSessionEpochAndCurrentPermissions(t *testing.T) {
	m, _, _ := mediaTestStore(t)
	a := m.a
	a.Mux = http.NewServeMux()
	a.Hub = &Hub{a: a, peers: map[string]*peer{"socket": {id: "socket", uid: "owner", session: "session"}}}
	a.C.MediaAdmissionSecret = "private-gate"
	a.C.LivekitKey = "key"
	a.C.LivekitSecret = "secret"
	a.DB.Run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('server','Server','owner',?)", Now())
	a.DB.Run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES('server','owner','owner',?)", Now())
	a.DB.Run("INSERT INTO channels(id,server_id,name,kind,created_at) VALUES('voice','server','Voice','voice',?)", Now())
	a.DB.Run("INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,heartbeat,joined_at) VALUES('owner','voice','socket','epoch',?,?)", Now(), Now())
	a.DB.Run("INSERT INTO sessions(id,user_id,access_hash,csrf,access_expires,expires_at,created_at) VALUES('session','owner',?,'csrf',?,?,?)", Hash("access"), Now()+60000, Now()+120000, Now())
	m.registerAdmission()
	grant := func(sources any, subscribe bool) M {
		return M{"roomJoin": true, "room": "voice", "canPublish": true, "canSubscribe": subscribe, "canPublishSources": sources, "canPublishData": false}
	}
	request := func(gate, path, token string) int {
		req := httptest.NewRequest("GET", "/internal/media/admission", nil)
		req.Header.Set("X-Dorham-Media-Gate", gate)
		req.Header.Set("X-Forwarded-Uri", path+"?access_token="+url.QueryEscape(token))
		rec := httptest.NewRecorder()
		a.Mux.ServeHTTP(rec, req)
		return rec.Code
	}
	token := mediaJWT("key", "secret", "owner:epoch", grant([]string{"microphone"}, true), 60)
	if request("wrong", "/rtc", token) != 404 || request("private-gate", "/rtc-other", token) != 403 || request("private-gate", "/rtc", token) != 200 {
		t.Fatal("admission gate/path")
	}
	for _, sources := range []any{[]any{"2"}, []any{2.9}, []any{"camera"}, []any{}} {
		bad := mediaJWT("key", "secret", "owner:epoch", grant(sources, true), 60)
		if request("private-gate", "/rtc/validate", bad) != 403 {
			t.Fatal("unsupported grant sources accepted", sources)
		}
	}
	a.DB.Run("UPDATE voice_members SET server_muted=1 WHERE user_id='owner'")
	if request("private-gate", "/rtc", token) != 403 {
		t.Fatal("server-muted microphone accepted")
	}
	a.DB.Run("UPDATE voice_members SET server_muted=0,server_deafened=1 WHERE user_id='owner'")
	receive := M{"roomJoin": true, "room": "voice", "canPublish": false, "canSubscribe": false, "canPublishData": false}
	receiveToken := mediaJWT("key", "secret", "owner:epoch", receive, 60)
	if request("private-gate", "/rtc", token) != 403 || request("private-gate", "/rtc", receiveToken) != 200 {
		t.Fatal("server-deafen receive grant")
	}
	a.DB.Run("UPDATE voice_members SET server_deafened=0 WHERE user_id='owner'")
	screenToken := mediaJWT("key", "secret", "owner:epoch", grant([]string{"screen_share", "screen_share_audio"}, true), 60)
	if request("private-gate", "/rtc", screenToken) != 403 {
		t.Fatal("unleased screen accepted")
	}
	a.DB.Run("INSERT INTO share_leases(id,user_id,channel_id,expires_at,include_audio) VALUES('lease','owner','voice',?,0)", Now()+60000)
	if request("private-gate", "/rtc", screenToken) != 403 {
		t.Fatal("unleased screen-audio accepted")
	}
	a.DB.Run("UPDATE share_leases SET include_audio=1")
	if request("private-gate", "/rtc", screenToken) != 200 {
		t.Fatal("valid screen lease rejected")
	}
	for _, field := range []string{"banned", "must_change_password"} {
		a.DB.Run("UPDATE users SET " + field + "=1 WHERE id='owner'")
		if request("private-gate", "/rtc", token) != 403 {
			t.Fatal("restricted account admitted", field)
		}
		a.DB.Run("UPDATE users SET " + field + "=0 WHERE id='owner'")
	}
	a.DB.Run("UPDATE sessions SET access_expires=0 WHERE id='session'")
	if request("private-gate", "/rtc", token) != 403 {
		t.Fatal("expired access admitted")
	}
	a.DB.Run("UPDATE sessions SET access_expires=? WHERE id='session'", Now()+60000)
	a.DB.Run("UPDATE voice_members SET epoch='new-epoch' WHERE user_id='owner'")
	if request("private-gate", "/rtc", token) != 403 {
		t.Fatal("cached old epoch admitted")
	}
}

func TestMediaSFUEnforcesPermissionsOutsideTransactionAndCoalesces(t *testing.T) {
	m, _, _ := mediaTestStore(t)
	a := m.a
	a.C.MediaTransport = "livekit"
	a.C.LivekitKey = "key"
	a.C.LivekitSecret = "secret"
	a.DB.Run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('server','Server','owner',?)", Now())
	a.DB.Run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES('server','owner','owner',?)", Now())
	a.DB.Run("INSERT INTO channels(id,server_id,name,kind,created_at) VALUES('voice','server','Voice','voice',?)", Now())
	a.DB.Run("INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,heartbeat,joined_at) VALUES('owner','voice','socket','epoch',?,?)", Now(), Now())
	a.DB.Run("INSERT INTO share_leases(id,user_id,channel_id,expires_at,include_audio) VALUES('lease','owner','voice',?,1)", Now()+60000)
	var rooms, updates, removals atomic.Int64
	first := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		claims := mediaVerifyJWT(token, "key", "secret")
		if claims == nil {
			t.Error("SFU auth invalid")
			w.WriteHeader(401)
			return
		}
		var body M
		json.NewDecoder(r.Body).Decode(&body)
		method := strings.TrimPrefix(r.URL.Path, "/twirp/livekit.RoomService/")
		switch method {
		case "ListRooms":
			if rooms.Add(1) == 1 {
				once.Do(func() { close(first) })
				<-release
			}
			json.NewEncoder(w).Encode(M{"rooms": []M{{"name": "voice"}, {"name": "external-room"}}})
		case "ListParticipants":
			if Str(body, "room") != "voice" {
				t.Error("touched unowned room")
			}
			json.NewEncoder(w).Encode(M{"participants": []M{{"identity": "owner:epoch", "permission": M{"canPublish": false, "canSubscribe": false}}, {"identity": "outsider:gone"}}})
		case "UpdateParticipant":
			updates.Add(1)
			if mediaSourceSet(Obj(body["permission"])["canPublishSources"]) != "234" {
				t.Error("wrong publish sources")
			}
			if a.DB.One("SELECT id FROM users WHERE id='owner'") == nil {
				t.Error("DB unavailable during network action")
			}
			json.NewEncoder(w).Encode(M{})
		case "RemoveParticipant":
			removals.Add(1)
			if Str(body, "identity") != "outsider:gone" {
				t.Error("wrong participant removal")
			}
			w.WriteHeader(404)
			json.NewEncoder(w).Encode(M{"code": "not_found"})
		default:
			t.Error("unexpected method", method)
			w.WriteHeader(400)
		}
	}))
	defer server.Close()
	a.C.LivekitAPIURL = server.URL
	m.client.Timeout = 2 * time.Second
	done := make(chan any, 2)
	run := func() { defer func() { done <- recover() }(); m.Synchronize() }
	go run()
	<-first
	go run()
	deadline := time.Now().Add(time.Second)
	for {
		m.sfuMu.Lock()
		dirty := m.sfuDirty
		m.sfuMu.Unlock()
		if dirty {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("second synchronization not coalesced")
		}
		time.Sleep(time.Millisecond)
	}
	close(release)
	for i := 0; i < 2; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if rooms.Load() != 2 || updates.Load() != 2 || removals.Load() != 2 {
		t.Fatalf("passes=%d updates=%d removals=%d", rooms.Load(), updates.Load(), removals.Load())
	}
	metrics := Obj(m.Metrics()["sfuControl"])
	if Num(metrics, "passes") != 2 || Num(metrics, "permissionUpdates") != 2 || Num(metrics, "removals") != 2 {
		t.Fatal(metrics)
	}
}
