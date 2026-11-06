package backend

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestFeatureCatalogAndVoicePolicies(t *testing.T) {
	a, server := integrationApp(t)
	admin, _, adminToken, _ := integrationSession(a, true)
	user, _, token, _ := integrationSession(a, true)
	_, _, other, _ := integrationSession(a, true)
	a.DB.Run("UPDATE users SET instance_admin=1 WHERE id=?", admin)
	call := func(token, method, path string, body M, want int) M {
		t.Helper()
		w := integrationHTTP(a, method, "/api/v1"+path, "", token, "", "", body)
		if w.Code != want {
			t.Fatalf("%s %s: %d, want %d: %s", method, path, w.Code, want, w.Body.String())
		}
		return Obj(Parse(w.Body.String()))
	}
	grant := func(feature string, enabled bool) {
		t.Helper()
		call(adminToken, "PUT", "/admin/features/users/"+user, M{"feature": feature, "enabled": enabled, "requestId": ID()}, 200)
	}
	config := func(token string) M { return call(token, "GET", "/features?platform=web&version=1.2.0", nil, 200) }
	if Str(config(token), "screen") != "hidden" {
		t.Fatal("1080p visible by default")
	}
	call(token, "GET", "/admin/features", nil, 403)
	call(adminToken, "PUT", "/admin/features/users/"+user, M{"rank": "ultra"}, 200)
	if Str(Obj(call(token, "GET", "/auth/me", nil, 200)["user"]), "rankBadge") != "ultra" {
		t.Fatal("rank not visible")
	}
	grant("screen1080", true)
	if Str(config(token), "screen") != "hidden" {
		t.Fatal("grant bypassed global hidden policy")
	}

	space := Str(a.Service.CreateServer(user, ID(), "Feature test"), "id")
	channel := Str(a.DB.One("SELECT id FROM channels WHERE server_id=? AND kind='voice'", space), "id")
	conversation := Str(a.DB.One("SELECT conversation_id FROM channels WHERE server_id=? AND kind='text'", space), "conversation_id")
	socket, ok := integrationSocket(t, server.URL, "capacitor://localhost", "", M{"token": token})
	if !ok {
		t.Fatal("voice socket refused")
	}
	action := func(name string, body M, want bool) M {
		t.Helper()
		result := voiceSocketAction(t, socket, name, body)
		if Bool(result, "ok") != want {
			t.Fatalf("%s: %v", name, result)
		}
		return Obj(result["data"])
	}
	action("voice:join", M{"channelId": channel, "eligible": true}, true)
	action("share:start", M{"protocolVersion": 2, "height": 1080, "includeAudio": false}, false)
	call(adminToken, "PUT", "/admin/features/settings/screen", M{"visibility": "selected", "bitrate": 1400000}, 200)
	if Str(config(token), "screen") != "selected" || Str(config(other), "screen") != "hidden" {
		t.Fatal("selected policy leaked")
	}
	lease := Obj(action("share:start", M{"protocolVersion": 2, "height": 1080, "includeAudio": false}, true)["lease"])
	if N(lease["maxHeight"]) != 1080 || N(lease["maxBitrate"]) != 1400000 || N(lease["maxFrameRate"]) != 15 {
		t.Fatalf("incorrect HD lease: %v", lease)
	}
	grant("screen1080", false)
	if row := a.DB.One("SELECT quality_height FROM share_leases WHERE user_id=?", user); N(row["quality_height"]) != 720 {
		t.Fatal("revocation did not downgrade active share")
	}
	call(adminToken, "PUT", "/admin/features/settings/screen", M{"visibility": "locked", "bitrate": 1400000}, 200)
	locked := config(token)
	if Str(locked, "screen") != "locked" || Obj(locked["grants"])["screen1080"] != nil {
		t.Fatal("locked policy granted access")
	}

	upload := func(kind, access, slot string, data []byte) string {
		t.Helper()
		var body bytes.Buffer
		multi := multipart.NewWriter(&body)
		for k, v := range map[string]string{"kind": kind, "label": "Fixture " + kind, "access": access, "freeSlot": slot} {
			if err := multi.WriteField(k, v); err != nil {
				t.Fatal(err)
			}
		}
		file, err := multi.CreateFormFile("file", "fixture.bin")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = file.Write(data); err != nil {
			t.Fatal(err)
		}
		if err = multi.Close(); err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/features/catalog", &body)
		req.Header.Set("Authorization", "Bearer "+adminToken)
		req.Header.Set("Content-Type", multi.FormDataContentType())
		w := httptest.NewRecorder()
		a.HTTP.Handler.ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatalf("upload: %d %s", w.Code, w.Body.String())
		}
		return Str(Obj(Parse(w.Body.String())), "id")
	}
	var imageData bytes.Buffer
	img := image.NewNRGBA(image.Rect(0, 0, 4, 4))
	img.Set(1, 1, color.White)
	if err := png.Encode(&imageData, img); err != nil {
		t.Fatal(err)
	}
	id := upload("emoji", "emojiPlus", "", imageData.Bytes())
	item := a.DB.One("SELECT * FROM feature_catalog WHERE id=?", id)
	getAsset := func(etag string, status int) {
		req := httptest.NewRequest(http.MethodGet, catalogURL(item), nil)
		if etag != "" {
			req.Header.Set("If-None-Match", etag)
		}
		w := httptest.NewRecorder()
		a.HTTP.Handler.ServeHTTP(w, req)
		if w.Code != status {
			t.Fatalf("asset: got %d, want %d", w.Code, status)
		}
		if status == 200 && (!strings.Contains(w.Header().Get("Cache-Control"), "immutable") || len(w.Body.Bytes()) == 0) {
			t.Fatal("asset cache contract")
		}
	}
	getAsset("", 404)
	call(adminToken, "GET", "/admin/features/catalog/"+id, nil, 200)
	call(adminToken, "PUT", "/admin/features/catalog/"+id, M{"active": true}, 200)
	getAsset("", 200)
	getAsset(`"`+Str(item, "digest")+`"`, 304)
	message := M{"conversationId": conversation, "requestId": ID(), "content": ":dx-" + id + ":"}
	call(token, "POST", "/messages", message, 403)
	grant("emojiPlus", true)
	sent := call(token, "POST", "/messages", message, 200)
	messageID := Str(Obj(sent["payload"]), "id")
	call(token, "PATCH", "/messages/"+messageID, M{"requestId": ID(), "emoji": message["content"]}, 200)
	grant("emojiPlus", false)
	call(token, "PATCH", "/messages/"+messageID, M{"requestId": ID(), "emoji": message["content"], "removeReaction": true}, 200)
	call(adminToken, "PUT", "/admin/features/catalog/"+id, M{"active": false}, 200)
	getAsset("", 200)

	// A silent WAV header is sufficient for validating the test-only catalog path.
	data := featureWAVFixture()
	sound := upload("sound", "free", "1", data)
	call(adminToken, "PUT", "/admin/features/catalog/"+sound, M{"active": true}, 200)
	action("soundboard:play", M{"id": sound}, true)
	action("soundboard:play", M{"id": sound}, false)
	call(token, "PUT", "/features/soundboard/"+channel, M{"enabled": false}, 200)
	call(adminToken, "PUT", "/admin/features/settings/speech", M{"enabled": true, "endpoint": "http://127.0.0.1/speech", "model": "bad", "voice": "bad", "label": "Bad", "timeoutSeconds": 5, "monthlyCharacters": 400, "globalMonthlyCharacters": 400}, 400)

	call(adminToken, "POST", "/admin/features/announcements", M{"en": "Maintenance", "fa": "", "platform": "web", "version": "1.2.0", "startsAt": Now() - 100, "endsAt": Now() + 60000}, 200)
	if len(Arr(config(token)["announcements"])) != 1 {
		t.Fatal("notice not delivered to target")
	}
	if len(Arr(call(token, "GET", "/features?platform=android&version=1.2.0", nil, 200)["announcements"])) != 0 {
		t.Fatal("notice leaked to untargeted platform")
	}
	call(adminToken, "PUT", "/admin/features/users/"+user, M{"feature": "profilePlus", "enabled": true, "expiresAt": Now() + int64(time.Minute/time.Millisecond)}, 200)
	if !featureGranted(a.DB, user, "profilePlus") {
		t.Fatal("temporary grant missing")
	}
	a.DB.Run("UPDATE account_features SET expires_at=? WHERE user_id=? AND feature='profilePlus'", Now()-1, user)
	if featureGranted(a.DB, user, "profilePlus") {
		t.Fatal("expired grant still authorizes")
	}
}

func featureWAVFixture() []byte {
	data := make([]byte, 46)
	copy(data, []byte("RIFF"))
	copy(data[8:], []byte("WAVEfmt "))
	copy(data[36:], []byte("data"))
	for offset, value := range map[int]uint32{4: 38, 16: 16, 24: 8000, 28: 16000, 40: 2} {
		binary.LittleEndian.PutUint32(data[offset:], value)
	}
	for offset, value := range map[int]uint16{20: 1, 22: 1, 32: 2, 34: 16} {
		binary.LittleEndian.PutUint16(data[offset:], value)
	}
	return data
}

func TestSpeechPlusProviderAndQuota(t *testing.T) {
	a, _ := integrationApp(t)
	admin, _, token, _ := integrationSession(a, true)
	uid, _, userToken, _ := integrationSession(a, true)
	a.DB.Run("UPDATE users SET instance_admin=1 WHERE id=?", admin)
	var inputs = make(chan M, 4)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/speech" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer isolated-fixture-token" {
			http.Error(w, "invalid fixture request", 403)
			return
		}
		var body M
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
			http.Error(w, "invalid fixture request", 400)
			return
		}
		inputs <- body
		w.Header().Set("Content-Type", "audio/wav")
		w.Write(featureWAVFixture())
	}))
	defer server.Close()
	oldClient := speechPlusClient
	speechPlusClient = server.Client()
	defer func() { speechPlusClient = oldClient }()
	endpoint := server.URL + "/speech"
	t.Setenv("DORHAM_TTS_PLUS_ENDPOINTS", JSON(M{endpoint: "isolated-fixture-token"}))
	value := M{"enabled": true, "endpoint": endpoint, "model": "fixture-v2", "voice": "fa", "label": "Persian fixture", "timeoutSeconds": 4, "monthlyCharacters": 400, "globalMonthlyCharacters": 800}
	call := func(access, method, path string, body M) M {
		t.Helper()
		response := integrationHTTP(a, method, "/api/v1"+path, "", access, "", "", body)
		if response.Code != 200 {
			t.Fatalf("%s %s: %d %s", method, path, response.Code, response.Body.String())
		}
		return Obj(Parse(response.Body.String()))
	}
	preview := call(token, "POST", "/admin/features/speech/preview", M{"settings": value, "text": "سلام Dorham"})
	if Str(preview, "wav") == "" {
		t.Fatal("preview did not return audio")
	}
	select {
	case got := <-inputs:
		if Str(got, "model") != "fixture-v2" || Str(got, "input") != "سلام Dorham" || Str(got, "response_format") != "wav" {
			t.Fatalf("wrong request: %v", got)
		}
	default:
		t.Fatal("speech endpoint was not called")
	}
	accountPath := "/admin/features/users/" + uid
	grantAndSelect := M{"feature": "ttsPlus", "enabled": true, "selectTtsPlus": true}
	failed := integrationHTTP(a, "PUT", "/api/v1"+accountPath, "", token, "", "", grantAndSelect)
	if failed.Code != 409 || featureGranted(a.DB, uid, "ttsPlus") {
		t.Fatal("grant and voice selection must roll back together when the provider is disabled")
	}
	call(token, "PUT", "/admin/features/settings/speech", value)
	forbidden := integrationHTTP(a, "PUT", "/api/v1"+accountPath, "", userToken, "", "", grantAndSelect)
	if forbidden.Code != 403 || featureGranted(a.DB, uid, "ttsPlus") {
		t.Fatal("a non-admin granted TTS Plus")
	}
	if !Bool(call(token, "PUT", accountPath, grantAndSelect), "plusSelected") {
		t.Fatal("grant did not select the AI voice")
	}
	if !Bool(call(userToken, "GET", "/features", nil), "plusSelected") {
		t.Fatal("voice choice missing")
	}
	reserve := func(text string) bool {
		return a.DB.Tx(func(tx *DB) any { return len(reservePlusSpeech(tx, uid, text)) > 0 }) == true
	}
	if !reserve(strings.Repeat("ا", 380)) || reserve(strings.Repeat("a", 21)) || !reserve(strings.Repeat("b", 20)) {
		t.Fatal("speech quota was not enforced")
	}
	call(token, "PUT", accountPath, M{"feature": "ttsPlus", "enabled": false})
	if reserve("new clip") || Bool(call(userToken, "GET", "/features", nil), "plusSelected") {
		t.Fatal("revoked speech remained enabled")
	}
	if Bool(call(token, "PUT", accountPath, M{"feature": "ttsPlus", "enabled": true}), "plusSelected") {
		t.Fatal("the legacy grant should preserve the standard voice")
	}
	if !Bool(call(token, "PUT", accountPath, M{"selectTtsPlus": true}), "plusSelected") {
		t.Fatal("existing grants should support selecting the AI voice")
	}
}
