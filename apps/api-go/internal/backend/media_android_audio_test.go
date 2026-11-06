package backend

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

func TestAndroidScreenAudioCredentialsBoundToCurrentVoiceAndLease(t *testing.T) {
	m, _, _ := mediaTestStore(t)
	a := m.a
	a.C.MediaTransport = "livekit"
	a.C.LivekitKey = "key"
	a.C.LivekitSecret = "secret"
	a.C.LivekitURL = "wss://example.invalid"
	a.C.MediaAdmissionSecret = "private-gate"
	a.Mux = http.NewServeMux()
	a.Hub = &Hub{a: a, peers: map[string]*peer{"socket": {id: "socket", uid: "owner", session: "session"}}}
	a.DB.Run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('server','Server','owner',?)", Now())
	a.DB.Run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES('server','owner','owner',?)", Now())
	a.DB.Run("INSERT INTO channels(id,server_id,name,kind,created_at) VALUES('voice','server','Voice','voice',?)", Now())
	a.DB.Run("INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,heartbeat,joined_at) VALUES('owner','voice','socket','epoch',?,?)", Now(), Now())
	a.DB.Run("INSERT INTO sessions(id,user_id,access_hash,csrf,access_expires,expires_at,created_at) VALUES('session','owner',?,'csrf',?,?,?)", Hash("access"), Now()+60000, Now()+120000, Now())
	m.registerAdmission()
	denied := func(label, uid, socket, channel, lease string) {
		t.Helper()
		if mediaSafe(func() { m.ScreenAudioCredentials(uid, socket, channel, lease) }) {
			t.Fatal(label + " got a token")
		}
	}
	denied("no lease", "owner", "socket", "voice", "lease")
	a.DB.Run("INSERT INTO share_leases(id,user_id,channel_id,expires_at,include_audio) VALUES('lease','owner','voice',?,0)", Now()+60000)
	denied("video only", "owner", "socket", "voice", "lease")
	a.DB.Run("UPDATE share_leases SET include_audio=1")
	denied("other owner", "peer", "socket", "voice", "lease")
	denied("other socket", "owner", "different", "voice", "lease")
	denied("other lease", "owner", "socket", "voice", "other")
	result := m.ScreenAudioCredentials("owner", "socket", "voice", "lease")
	claims := mediaVerifyJWT(Str(result, "token"), "key", "secret")
	grant := Obj(claims["video"])
	if Str(claims, "sub") != "owner:epoch:screen:lease" || mediaSourceSet(grant["canPublishSources"]) != "4" || Bool(grant, "canSubscribe") || Bool(grant, "canPublishData") {
		t.Fatal("auxiliary grant leaked capabilities", grant)
	}
	admission := func(identity string, grant M) int {
		token := mediaJWT("key", "secret", identity, grant, 60)
		req := httptest.NewRequest("GET", "/internal/media/admission", nil)
		req.Header.Set("X-Dorham-Media-Gate", "private-gate")
		req.Header.Set("X-Forwarded-Uri", "/rtc?access_token="+url.QueryEscape(token))
		rec := httptest.NewRecorder()
		a.Mux.ServeHTTP(rec, req)
		return rec.Code
	}
	if admission("owner:epoch:screen:lease", grant) != 200 {
		t.Fatal("valid auxiliary publisher denied")
	}
	for _, identity := range []string{"owner:epoch:screen:other", "owner:old:screen:lease", "owner:epoch:other:lease", "owner:epoch:screen:lease:extra"} {
		if admission(identity, grant) != 403 {
			t.Fatal("invalid identity admitted", identity)
		}
	}
	grant["canSubscribe"] = true
	if admission("owner:epoch:screen:lease", grant) != 403 {
		t.Fatal("auxiliary subscriber admitted")
	}
	grant["canSubscribe"] = false
	grant["canPublishSources"] = []string{"microphone", "screen_share_audio"}
	if admission("owner:epoch:screen:lease", grant) != 403 {
		t.Fatal("auxiliary microphone admitted")
	}
	grant["canPublishSources"] = []string{"screen_share_audio"}
	a.DB.Run("DELETE FROM share_leases")
	if admission("owner:epoch:screen:lease", grant) != 403 {
		t.Fatal("ended lease reused")
	}
	a.DB.Run("INSERT INTO share_leases(id,user_id,channel_id,expires_at,include_audio) VALUES('lease','owner','voice',?,1)", Now()+60000)
	a.DB.Run("UPDATE voice_members SET heartbeat=0")
	denied("expired voice", "owner", "socket", "voice", "lease")
	if admission("owner:epoch:screen:lease", grant) != 403 {
		t.Fatal("expired voice admitted")
	}
}

func TestAndroidScreenAudioReconciliationRevokesEndedAndChangedLeases(t *testing.T) {
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
	var updates, removed atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body M
		json.NewDecoder(r.Body).Decode(&body)
		switch strings.TrimPrefix(r.URL.Path, "/twirp/livekit.RoomService/") {
		case "ListRooms":
			json.NewEncoder(w).Encode(M{"rooms": []M{{"name": "voice"}}})
		case "ListParticipants":
			json.NewEncoder(w).Encode(M{"participants": []M{{"identity": "owner:epoch:screen:lease", "permission": M{"canSubscribe": true, "canPublish": true, "canPublishSources": []int{2, 3, 4}}}}})
		case "UpdateParticipant":
			perm := Obj(body["permission"])
			if Bool(perm, "canSubscribe") || mediaSourceSet(perm["canPublishSources"]) != "4" {
				t.Error("auxiliary permissions broadened", perm)
			}
			updates.Add(1)
			json.NewEncoder(w).Encode(M{})
		case "RemoveParticipant":
			if Str(body, "identity") != "owner:epoch:screen:lease" {
				t.Error("wrong participant removed")
			}
			removed.Add(1)
			json.NewEncoder(w).Encode(M{})
		default:
			t.Error("unexpected SFU action", r.URL.Path)
			w.WriteHeader(400)
		}
	}))
	defer server.Close()
	a.C.LivekitAPIURL = server.URL
	m.Synchronize()
	if updates.Load() != 1 || removed.Load() != 0 {
		t.Fatal("active auxiliary identity was not narrowed")
	}
	a.DB.Run("UPDATE share_leases SET include_audio=0")
	m.Synchronize()
	if removed.Load() != 1 {
		t.Fatal("audio opt-out did not remove publisher")
	}
	a.DB.Run("DELETE FROM share_leases")
	a.DB.Run("INSERT INTO share_leases(id,user_id,channel_id,expires_at,include_audio) VALUES('new-lease','owner','voice',?,1)", Now()+60000)
	m.Synchronize()
	if removed.Load() != 2 {
		t.Fatal("new sharing session admitted an old publisher")
	}
	a.DB.Run("DELETE FROM voice_members")
	m.Synchronize()
	if removed.Load() != 3 {
		t.Fatal("leaving voice did not revoke publisher")
	}
}
