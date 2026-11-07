package backend

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestDirectCallAdmissionAndRevocation(t *testing.T) {
	var deletions atomic.Int32
	sfu := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/DeleteRoom") {
			deletions.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer sfu.Close()
	a, server := integrationApp(t, func(c *Config) {
		c.MediaTransport, c.LivekitURL, c.LivekitAPIURL = "livekit", "wss://voice.example", sfu.URL
		c.LivekitKey, c.LivekitSecret, c.MediaAdmissionSecret = "test-key", "test-secret", "test-gate"
	})
	caller, _, callerToken, _ := integrationSession(a, true)
	callee, _, calleeToken, _ := integrationSession(a, true)
	_, _, outsiderToken, _ := integrationSession(a, true)
	dm := Str(a.Service.DM(caller, ID(), callee), "id")
	connect := func(token string) *websocket.Conn {
		t.Helper()
		socket, ok := integrationSocket(t, server.URL, "capacitor://localhost", "", M{"token": token})
		if !ok {
			t.Fatal("socket rejected")
		}
		t.Cleanup(func() { socket.Close() })
		return socket
	}
	first, second, outsider, otherTab := connect(callerToken), connect(calleeToken), connect(outsiderToken), connect(calleeToken)
	action := func(socket *websocket.Conn, payload M, code string) M {
		t.Helper()
		result := voiceSocketAction(t, socket, "dm:call", payload)
		if (code == "" && !Bool(result, "ok")) || (code != "" && Str(Obj(result["error"]), "code") != code) {
			t.Fatalf("dm:call %v: %v", payload["action"], result)
		}
		return Obj(result["data"])
	}
	action(outsider, M{"action": "start", "conversationId": dm}, "FORBIDDEN")
	action(first, M{"action": "start", "conversationId": dm}, "")
	second.SetReadDeadline(time.Now().Add(3 * time.Second))
	var incoming M
	for incoming == nil {
		_, data, err := second.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasPrefix(string(data), `42["dm:call-state",`) {
			var event []any
			if err := json.Unmarshal(data[2:], &event); err != nil {
				t.Fatal(err)
			}
			incoming = Obj(event[1])
		}
	}
	id := Str(incoming, "id")
	if Str(incoming, "phase") != "incoming" || Str(incoming, "conversationId") != dm || id == "" {
		t.Fatal("invalid invitation", incoming)
	}
	action(first, M{"action": "credentials", "id": id}, "CALL_ENDED")
	action(outsider, M{"action": "accept", "id": id}, "CALL_ENDED")
	action(second, M{"action": "accept", "id": id}, "")
	action(otherTab, M{"action": "credentials", "id": id}, "CALL_ENDED")
	credentials := action(first, M{"action": "credentials", "id": id}, "")
	token := Str(credentials, "token")
	claims := mediaVerifyJWT(token, a.C.LivekitKey, a.C.LivekitSecret)
	video := Obj(claims["video"])
	if Str(claims, "sub") != caller+":"+id || Str(video, "room") != directCallPrefix+id || mediaSourceSet(video["canPublishSources"]) != "2" {
		t.Fatal("invalid or overbroad media grant")
	}
	admit := func(token string) int {
		r := httptest.NewRequest(http.MethodGet, "/internal/media/admission", nil)
		r.Header.Set("X-Dorham-Media-Gate", "test-gate")
		r.Header.Set("X-Forwarded-Uri", "/rtc?access_token="+url.QueryEscape(token))
		w := httptest.NewRecorder()
		a.HTTP.Handler.ServeHTTP(w, r)
		return w.Code
	}
	if admit(token) != 200 {
		t.Fatal("current call token was denied")
	}
	video["canPublishSources"] = []string{"camera"}
	if admit(mediaJWT(a.C.LivekitKey, a.C.LivekitSecret, caller+":"+id, video, 30)) != 403 {
		t.Fatal("camera grant was accepted")
	}
	action(second, M{"action": "end", "id": id}, "")
	if deletions.Load() != 1 || admit(token) != 403 || a.Hub.directCallActive("") {
		t.Fatal("hangup did not revoke the call and close the media room")
	}
	a.DB.Run("INSERT INTO user_blocks(user_id,blocked_id) VALUES(?,?)", callee, caller)
	action(first, M{"action": "start", "conversationId": dm}, "DM_BLOCKED")
}
