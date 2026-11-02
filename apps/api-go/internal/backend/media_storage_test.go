package backend

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func mediaTestStore(t *testing.T) (*Media, string, []byte) {
	t.Helper()
	dir := t.TempDir()
	c := Config{DataDir: dir, AttachmentDir: filepath.Join(dir, "attachments"), MaxDatabaseMiB: 16, MaxAvatarsMiB: 2, AttachmentBudgetMiB: 4, UploadReserveMiB: 0, UploadConcurrency: 2, TTSIdleSeconds: 180, TTSAudioCacheMiB: 1}
	db := OpenDB(c)
	a := &App{C: c, DB: db}
	a.Service = NewService(db, c)
	m := NewMedia(a)
	t.Cleanup(func() { m.Close(); db.Close() })
	for _, uid := range []string{"owner", "peer", "outsider"} {
		db.Run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)", uid, uid, uid, "unused", Now())
	}
	db.Run("INSERT INTO conversations(id,kind,created_at) VALUES('dm','dm',?)", Now())
	for _, uid := range []string{"owner", "peer"} {
		db.Run("INSERT INTO dm_members(conversation_id,user_id) VALUES('dm',?)", uid)
	}
	db.Run("INSERT INTO messages(id,conversation_id,sequence,user_id,content,created_at) VALUES('message','dm',1,'owner','',?)", Now())
	id := ID()
	data := []byte("\x89PNG\r\n\x1a\nsecure attachment payload")
	digest := sha256.Sum256(data)
	db.Run("INSERT INTO attachments(id,user_id,conversation_id,message_id,request_id,name,size,digest,state,created_at,expires_at) VALUES(?,'owner','dm','message',?,'photo.png',?,?,'ready',?,?)", id, ID(), len(data), hex.EncodeToString(digest[:]), Now(), Now()+60000)
	if err := os.WriteFile(m.file(id, false), data, 0600); err != nil {
		t.Fatal(err)
	}
	return m, id, data
}
func mediaServeTest(m *Media, uid, id, rangeHeader, method string) (rec *httptest.ResponseRecorder, err APIError) {
	req := httptest.NewRequest(method, "/api/v1/attachments/"+id+"/media", nil)
	req.SetPathValue("id", id)
	req.Header.Set("Range", rangeHeader)
	rec = httptest.NewRecorder()
	defer func() {
		if p := recover(); p != nil {
			err = RecoverError(p)
		}
	}()
	m.serveAttachment(&Request{A: m.a, W: rec, R: req, User: M{"id": uid}}, true)
	return
}
func TestMediaSQLPrivacyRangesIntegrity(t *testing.T) {
	m, id, data := mediaTestStore(t)
	rec, e := mediaServeTest(m, "peer", id, "bytes=4-15", "GET")
	if e.Status != 0 || rec.Code != 206 || string(rec.Body.Bytes()) != string(data[4:16]) || rec.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("range: %d %v %q", rec.Code, e, rec.Body.String())
	}
	rec, e = mediaServeTest(m, "peer", id, "", "HEAD")
	if e.Status != 0 || rec.Body.Len() != 0 || rec.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("HEAD %v %v", rec, e)
	}
	_, e = mediaServeTest(m, "outsider", id, "", "GET")
	if e.Status != 403 {
		t.Fatalf("outsider=%v", e)
	}
	rec, e = mediaServeTest(m, "peer", id, "bytes=99-", "GET")
	if e.Status != 0 || rec.Code != 416 {
		t.Fatalf("range status %d %v", rec.Code, e)
	}
	// Changing bytes and mtime invalidates the integrity cache even at unchanged length.
	changed := append([]byte(nil), data...)
	changed[len(changed)-1] ^= 1
	os.WriteFile(m.file(id, false), changed, 0600)
	stamp := time.Now().Add(time.Second)
	os.Chtimes(m.file(id, false), stamp, stamp)
	_, e = mediaServeTest(m, "peer", id, "", "GET")
	if e.Status != 410 {
		t.Fatalf("corrupt=%v", e)
	}
	os.WriteFile(m.file(id, false), data, 0600)
	m.a.DB.Run("UPDATE attachments SET expires_at=0 WHERE id=?", id)
	_, e = mediaServeTest(m, "peer", id, "", "GET")
	if e.Status != 410 {
		t.Fatalf("expired=%v", e)
	}
	m.a.DB.Run("UPDATE attachments SET expires_at=? WHERE id=?", Now()+60000, id)
	m.a.DB.Run("UPDATE messages SET deleted=1 WHERE id='message'")
	_, e = mediaServeTest(m, "peer", id, "", "GET")
	if e.Status != 410 {
		t.Fatalf("deleted=%v", e)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.readers) != 0 {
		t.Fatal("reader slot leaked after denial/error")
	}
}
func TestMediaCredentialsEnforcePublishSources(t *testing.T) {
	m, _, _ := mediaTestStore(t)
	a := m.a
	a.C.MediaTransport = "livekit"
	a.C.LivekitKey = "key"
	a.C.LivekitSecret = "secret"
	a.C.LivekitURL = "wss://example.invalid"
	a.DB.Run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('server','Server','owner',?)", Now())
	for _, uid := range []string{"owner", "peer"} {
		role := "member"
		if uid == "owner" {
			role = "owner"
		}
		a.DB.Run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES('server',?,?,?)", uid, role, Now())
	}
	a.DB.Run("INSERT INTO channels(id,server_id,name,kind,created_at) VALUES('voice','server','Voice','voice',?)", Now())
	a.DB.Run("INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,heartbeat,joined_at) VALUES('owner','voice','socket','epoch',?,?)", Now(), Now())
	check := func(want string, subscribe bool) {
		t.Helper()
		result := m.Credentials("owner", "socket", "voice")
		claims := mediaVerifyJWT(Str(result, "token"), "key", "secret")
		grant := Obj(claims["video"])
		if mediaSourceSet(grant["canPublishSources"]) != want || Bool(grant, "canSubscribe") != subscribe || Bool(grant, "canPublishData") {
			t.Fatalf("grant=%v", grant)
		}
	}
	check("2", true)
	a.DB.Run("INSERT INTO share_leases(id,user_id,channel_id,expires_at,include_audio) VALUES('lease','owner','voice',?,1)", Now()+60000)
	check("234", true)
	a.DB.Run("UPDATE voice_members SET server_muted=1 WHERE user_id='owner'")
	check("34", true)
	a.DB.Run("UPDATE voice_members SET server_deafened=1 WHERE user_id='owner'")
	check("34", false)
	a.DB.Run("DELETE FROM share_leases")
	check("", false)
	a.DB.Run("UPDATE voice_members SET heartbeat=0 WHERE user_id='owner'")
	if mediaSafe(func() { m.Credentials("owner", "socket", "voice") }) {
		t.Fatal("stale voice got JWT")
	}
}
func TestMediaSpeechClipsRequireSameLiveEpochAndHearing(t *testing.T) {
	m, _, _ := mediaTestStore(t)
	db := m.a.DB
	db.Run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('server','Server','owner',?)", Now())
	db.Run("INSERT INTO channels(id,server_id,name,kind,created_at) VALUES('voice','server','Voice','voice',?)", Now())
	db.Run("INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,heartbeat,joined_at) VALUES('peer','voice','socket','epoch',?,?)", Now(), Now())
	speech := m.speech
	audio := []byte("RIFFbounded-wave")
	speech.mu.Lock()
	speech.audio["clip"] = mediaClip{audio, "voice", map[string]string{"peer": "epoch"}, Now() + 120000}
	speech.order = append(speech.order, "clip")
	speech.audioBytes = int64(len(audio))
	speech.mu.Unlock()
	if string(speech.read("peer", "clip")) != string(audio) || speech.read("outsider", "clip") != nil {
		t.Fatal("TTS recipient restriction")
	}
	for _, field := range []string{"deafened", "server_deafened"} {
		db.Run("UPDATE voice_members SET " + field + "=1 WHERE user_id='peer'")
		if speech.read("peer", "clip") != nil {
			t.Fatal("deafened user heard clip")
		}
		db.Run("UPDATE voice_members SET " + field + "=0 WHERE user_id='peer'")
	}
	db.Run("UPDATE voice_members SET epoch='new-epoch' WHERE user_id='peer'")
	if speech.read("peer", "clip") != nil {
		t.Fatal("rejoined epoch heard old clip")
	}
	speech.mu.Lock()
	clip := speech.audio["clip"]
	clip.Expires = Now() - 1
	speech.audio["clip"] = clip
	speech.mu.Unlock()
	speech.cleanup()
	if Num(speech.metrics(), "cachedAudioBytes") != 0 || Num(speech.metrics(), "cachedClips") != 0 {
		t.Fatal("expired speech retained")
	}
}
