package backend

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func voiceSocketAction(t *testing.T, socket *websocket.Conn, action string, payload M) M {
	t.Helper()
	socket.SetReadDeadline(time.Now().Add(5 * time.Second))
	payload["requestId"] = ID()
	if err := socket.WriteMessage(websocket.TextMessage, []byte("421"+JSON([]any{action, payload}))); err != nil {
		t.Fatal(err)
	}
	for {
		_, data, err := socket.ReadMessage()
		if err != nil {
			t.Fatalf("%s: %v", action, err)
		}
		packet := string(data)
		if packet == "2" {
			if err := socket.WriteMessage(websocket.TextMessage, []byte("3")); err != nil {
				t.Fatal(err)
			}
		}
		if strings.HasPrefix(packet, "431") {
			var result []M
			if err := json.Unmarshal(data[3:], &result); err != nil || len(result) != 1 {
				t.Fatalf("%s: invalid acknowledgement", action)
			}
			return result[0]
		}
	}
}

func TestVoiceRecoveryOverSocket(t *testing.T) {
	a, server := integrationApp(t)
	user, session, token, _ := integrationSession(a, true)
	space := Str(a.Service.CreateServer(user, ID(), "Voice recovery"), "id")
	channel := Str(a.DB.One("SELECT id FROM channels WHERE server_id=? AND kind='voice'", space), "id")
	connect := func(access string) *websocket.Conn {
		t.Helper()
		s, ok := integrationSocket(t, server.URL, "capacitor://localhost", "", M{"token": access})
		if !ok {
			t.Fatal("socket rejected")
		}
		return s
	}
	expectOK := func(s *websocket.Conn, event string, data M) M {
		t.Helper()
		result := voiceSocketAction(t, s, event, data)
		if !B(result["ok"]) {
			t.Fatalf("%s: %v", event, result["error"])
		}
		return Obj(result["data"])
	}
	expectEnded := func(s *websocket.Conn, ticket M) {
		t.Helper()
		result := voiceSocketAction(t, s, "voice:resume", ticket)
		if B(result["ok"]) || Str(Obj(result["error"]), "code") != "VOICE_SESSION_ENDED" {
			t.Fatal("stale or unauthorized voice resume was not rejected")
		}
	}
	join := func(s *websocket.Conn, recoverable bool) M {
		t.Helper()
		joined := expectOK(s, "voice:join", M{"channelId": channel, "eligible": true, "recoverable": recoverable})
		return M{"channelId": channel, "epoch": joined["epoch"], "resumeToken": joined["resumeToken"]}
	}
	drop := func(s *websocket.Conn) {
		t.Helper()
		if err := s.Close(); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(3 * time.Second)
		for a.Hub.Online(user) && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		if a.Hub.Online(user) {
			t.Fatal("old socket still online")
		}
	}

	first := connect(token)
	ticket := join(first, true)
	if len(Str(ticket, "resumeToken")) != 64 {
		t.Fatal("recoverable join omitted its resume token")
	}
	expectOK(first, "voice:state", M{"muted": true, "deafened": true})
	lease := Str(Obj(expectOK(first, "share:start", M{"protocolVersion": 2, "includeAudio": true})["lease"]), "id")
	oldSocket := Str(a.DB.One("SELECT socket_id FROM voice_members WHERE user_id=?", user), "socket_id")
	drop(first)
	if row := a.DB.One("SELECT epoch FROM voice_members WHERE user_id=?", user); Str(row, "epoch") != ticket["epoch"] {
		t.Fatal("transport loss destroyed the voice membership")
	}

	otherToken := Token()
	a.DB.Run("INSERT INTO sessions(id,user_id,access_hash,csrf,native,access_expires,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
		ID(), user, Hash(otherToken), Token(), 1, Now()+600000, Now()+3600000, Now())
	other := connect(otherToken)
	expectEnded(other, ticket)
	drop(other)

	second := connect(token)
	for range 2 {
		resumed := expectOK(second, "voice:resume", ticket)
		room := Obj(resumed["room"])
		shares := Arr(room["shares"])
		if resumed["epoch"] != ticket["epoch"] || len(shares) != 1 || Str(Obj(shares[0]), "id") != lease {
			t.Fatal("resume replaced the voice epoch or active share")
		}
		self := Obj(Arr(room["members"])[0])
		if !B(self["muted"]) || !B(self["deafened"]) {
			t.Fatal("resume cleared mute or deafen")
		}
	}
	row := a.DB.One("SELECT socket_id FROM voice_members WHERE user_id=?", user)
	if Str(row, "socket_id") == "" || Str(row, "socket_id") == oldSocket {
		t.Fatal("resume did not rebind to the fresh socket")
	}
	expectOK(second, "voice:heartbeat", M{"eligible": true})
	expectOK(second, "voice:leave", ticket)
	expectEnded(second, ticket)

	ticket = join(second, true)
	a.Service.Moderate(user, ID(), channel, user, "kick")
	expectEnded(second, ticket)

	ticket = join(second, true)
	a.DB.Run("UPDATE voice_members SET heartbeat=? WHERE user_id=?", Now()-31000, user)
	expectEnded(second, ticket)

	legacy := join(second, false)
	if legacy["resumeToken"] != nil {
		t.Fatal("legacy client opted in unexpectedly")
	}
	drop(second)
	deadline := time.Now().Add(3 * time.Second)
	for a.DB.One("SELECT epoch FROM voice_members WHERE user_id=?", user) != nil && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if a.DB.One("SELECT epoch FROM voice_members WHERE user_id=?", user) != nil {
		t.Fatal("legacy disconnect did not remove membership")
	}

	third := connect(token)
	join(third, true)
	drop(third)
	a.DB.Run("DELETE FROM sessions WHERE id=?", session)
	a.Hub.DisconnectSession(session)
	if a.DB.One("SELECT epoch FROM voice_members WHERE user_id=?", user) != nil {
		t.Fatal("revoked session retained its detached voice membership")
	}
}
