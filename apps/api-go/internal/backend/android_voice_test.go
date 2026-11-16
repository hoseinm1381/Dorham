package backend

import (
	"net/http"
	"testing"
	"time"
)

func TestAndroidNativeVoiceHeartbeat(t *testing.T) {
	a, server := integrationApp(t)
	uid, session, accessToken, _ := integrationSession(a, true)
	space := Str(a.Service.CreateServer(uid, ID(), "Android background voice"), "id")
	channel := Str(a.DB.One("SELECT id FROM channels WHERE server_id=? AND kind='voice'", space), "id")
	socket, ok := integrationSocket(t, server.URL, "capacitor://localhost", "", M{"token": accessToken})
	if !ok {
		t.Fatal("native socket rejected")
	}
	joined := voiceSocketAction(t, socket, "voice:join", M{"channelId": channel, "eligible": true, "recoverable": true, "nativeKeepalive": true})
	data := Obj(joined["data"])
	epoch, token := Str(data, "epoch"), Str(data, "nativeVoiceToken")
	if !B(joined["ok"]) || epoch == "" || token == "" {
		t.Fatal("join did not return a native heartbeat grant")
	}
	body := M{"userId": uid, "channelId": channel, "epoch": epoch, "token": token}
	post := func(payload M, status int) {
		t.Helper()
		result := integrationHTTP(a, "POST", "/api/v1/voice/native-heartbeat", "", "", "", "", payload)
		if result.Code != status {
			t.Fatalf("heartbeat status %d, expected %d: %s", result.Code, status, result.Body.String())
		}
	}
	post(Merge(body, M{"channelId": ID()}), http.StatusForbidden)
	defer socket.Close()
	a.DB.Run("UPDATE sessions SET access_expires=? WHERE id=?", Now()-1000, session)
	a.Hub.DisconnectInvalid()
	deadline := time.Now().Add(3 * time.Second)
	for a.Hub.Online(uid) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if a.Hub.Online(uid) {
		t.Fatal("WebView socket did not close")
	}

	// Two sub-timeout gaps simulate more than 30 seconds of service-only liveness.
	// The native grant continues after the short-lived WebView access token expires.
	for range 2 {
		old := Now() - 20000
		a.DB.Run("UPDATE voice_members SET heartbeat=? WHERE epoch=?", old, epoch)
		a.Hub.checkDetachedVoice()
		post(body, http.StatusOK)
		row := a.DB.One("SELECT heartbeat FROM voice_members WHERE epoch=?", epoch)
		if N(row["heartbeat"]) <= old {
			t.Fatal("native heartbeat did not renew the existing member")
		}
	}
	a.DB.Run("UPDATE sessions SET access_expires=? WHERE id=?", Now()+600000, session)
	reconnected, ok := integrationSocket(t, server.URL, "capacitor://localhost", "", M{"token": accessToken})
	if !ok {
		t.Fatal("WebView could not reconnect")
	}
	defer reconnected.Close()
	resumed := voiceSocketAction(t, reconnected, "voice:resume", M{"channelId": channel, "epoch": epoch, "resumeToken": data["resumeToken"], "nativeKeepalive": true})
	if !B(resumed["ok"]) || Str(Obj(resumed["data"]), "epoch") != epoch {
		t.Fatal("WebView could not resume the same voice membership")
	}
	a.DB.Run("UPDATE voice_members SET heartbeat=? WHERE epoch=?", Now()-31000, epoch)
	post(body, http.StatusConflict)
	a.DB.Run("UPDATE voice_members SET heartbeat=? WHERE epoch=?", Now(), epoch)
	a.DB.Run("DELETE FROM sessions WHERE id=?", session)
	post(body, http.StatusUnauthorized)
}
