package backend

import (
	"bytes"
	"net/http/httptest"
	"testing"
)

func TestRecoverNativeRefreshAfterLostResponse(t *testing.T) {
	a, _ := integrationApp(t)
	_, sid, _, _ := integrationSession(a, true)
	refresh := Token()
	a.DB.Run("UPDATE sessions SET refresh_hash=? WHERE id=?", Hash(refresh), sid)
	body := M{"refreshToken": refresh, "requestId": ID(), "retryProof": Token()}
	call := func(body M, want int) M {
		t.Helper()
		r := integrationHTTP(a, "POST", "/api/v1/auth/refresh-safe", "", "", "", "capacitor://localhost", body)
		if r.Code != want {
			t.Fatalf("refresh HTTP %d: %s", r.Code, r.Body)
		}
		return Obj(Parse(r.Body.String()))
	}
	first, recovered := call(body, 200), call(body, 200)
	if recovered["accessToken"] != first["accessToken"] || recovered["refreshToken"] != first["refreshToken"] {
		t.Fatal("retry changed the rotated credentials")
	}
	if user, _ := a.resolveSession(Str(recovered, "accessToken")); user == nil {
		t.Fatal("recovered session failed")
	}
	call(M{"refreshToken": refresh, "requestId": ID(), "retryProof": Token()}, 401)
	if user, _ := a.resolveSession(Str(recovered, "accessToken")); user != nil {
		t.Fatal("unexpected replay did not revoke session")
	}
}

func TestAttachmentResumesAcrossRequests(t *testing.T) {
	a, _ := integrationApp(t, func(c *Config) {
		c.UploadConcurrency, c.UploadSoftMiB, c.UploadHardMiB, c.AttachmentBudgetMiB = 2, 100, 150, 300
	})
	_, _, token, _ := integrationSession(a, true)
	call := func(method, route string, body M, want int) M {
		t.Helper()
		r := integrationHTTP(a, method, "/api/v1"+route, "", token, "", "", body)
		if r.Code != want {
			t.Fatalf("%s %s HTTP %d: %s", method, route, r.Code, r.Body)
		}
		return Obj(Parse(r.Body.String()))
	}
	server := call("POST", "/servers", M{"name": "Transfer fixture", "requestId": ID()}, 200)
	channel := a.DB.One("SELECT conversation_id FROM channels WHERE server_id=? AND kind='text' LIMIT 1", server["id"])
	cid := Str(channel, "conversation_id")
	reserve := M{"name": "hello.txt", "size": 11, "conversationId": cid, "resumable": true, "requestId": ID()}
	id := Str(call("POST", "/attachments", reserve, 200), "id")
	if id == "" || Str(call("POST", "/attachments", reserve, 200), "id") != id {
		t.Fatal("lost reservation response caused a second upload")
	}
	route := "/attachments/" + id
	chunk := func(offset, data string, want int) M {
		t.Helper()
		r := httptest.NewRequest("PATCH", "/api/v1"+route+"/content?offset="+offset, bytes.NewBufferString(data))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/octet-stream")
		w := httptest.NewRecorder()
		a.HTTP.Handler.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("chunk at %s HTTP %d: %s", offset, w.Code, w.Body)
		}
		return Obj(Parse(w.Body.String()))
	}
	chunk("0", "hello ", 200)
	if p := call("GET", route+"/transfer", nil, 200); Num(p, "offset") != 6 {
		t.Fatalf("saved offset: %v", p)
	}
	chunk("0", "hello ", 409)
	if p := chunk("6", "world", 200); Str(p, "state") != "ready" || Num(p, "offset") != 11 {
		t.Fatalf("final chunk: %v", p)
	}
	call("POST", "/messages", M{"conversationId": cid, "content": "A resumed file", "attachmentIds": []string{id}, "requestId": ID()}, 200)
	r := httptest.NewRequest("GET", "/api/v1"+route+"/download", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Range", "bytes=6-")
	w := httptest.NewRecorder()
	a.HTTP.Handler.ServeHTTP(w, r)
	if w.Code != 206 || w.Body.String() != "world" || w.Header().Get("ETag") == "" {
		t.Fatalf("resumed download HTTP %d: %s", w.Code, w.Body)
	}
}
