package backend

import (
	"bytes"
	"database/sql"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// These tests cross the actual HTTP and Engine.IO v4 boundaries, rather than
// replacing authentication or realtime handlers with test doubles.
func integrationApp(t *testing.T, configure ...func(*Config)) (*App, *httptest.Server) {
	t.Helper()
	dir := t.TempDir()
	c := Config{DataDir: dir, AttachmentDir: filepath.Join(dir, "attachments"), PublicURL: "https://dorham.example", Origins: []string{"https://dorham.example", "capacitor://localhost", "dorham://app"}, MaxDatabaseMiB: 32, MaxUsers: 100, MaxOnline: 20, MaxVoice: 16, StandardShareSlots: 3, ScreenMaxFrameRate: 30, ScreenMaxBitrate: 1500000, RetentionDays: 90, MaxMessages: 50000, MediaTransport: "mesh", RegistrationOpen: true, GuestsEnabled: true, TTSIdleSeconds: 180, TTSAudioCacheMiB: 8}
	for _, apply := range configure {
		apply(&c)
	}
	a := NewApp(c)
	srv := httptest.NewServer(a.HTTP.Handler)
	t.Cleanup(func() { srv.Close(); a.Close() })
	return a, srv
}

func integrationSession(a *App, native bool) (string, string, string, string) {
	uid, sid, token, csrf := ID(), ID(), Token(), Token()
	a.DB.Run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)", uid, "user_"+uid, "Integration", "unused", Now())
	a.DB.Run("INSERT INTO sessions(id,user_id,access_hash,csrf,native,access_expires,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)", sid, uid, Hash(token), csrf, native, Now()+600000, Now()+3600000, Now())
	return uid, sid, token, csrf
}

func integrationHTTP(a *App, method, path, cookie, bearer, csrf, origin string, body M) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, bytes.NewBufferString(JSON(body)))
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: "dorham_session", Value: cookie})
	}
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	if csrf != "" {
		r.Header.Set("X-CSRF-Token", csrf)
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	w := httptest.NewRecorder()
	a.HTTP.Handler.ServeHTTP(w, r)
	return w
}

func integrationSocket(t *testing.T, url, origin, cookie string, auth M) (*websocket.Conn, bool) {
	t.Helper()
	h := http.Header{}
	if origin != "" {
		h.Set("Origin", origin)
	}
	if cookie != "" {
		h.Set("Cookie", "dorham_session="+cookie)
	}
	c, r, e := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(url, "http")+"/socket.io/?EIO=4&transport=websocket", h)
	if e != nil {
		if r != nil && r.StatusCode == http.StatusForbidden {
			return nil, false
		}
		if r != nil {
			data, _ := io.ReadAll(r.Body)
			t.Fatalf("Engine.IO upgrade failed HTTP %d: %s %v", r.StatusCode, data, e)
		}
		t.Fatalf("Engine.IO upgrade failed: %v", e)
	}
	t.Cleanup(func() { c.Close() })
	c.SetReadDeadline(time.Now().Add(4 * time.Second))
	_, raw, e := c.ReadMessage()
	if e != nil || !strings.HasPrefix(string(raw), "0{") {
		t.Fatalf("missing Engine.IO open packet: %s %v", raw, e)
	}
	if e = c.WriteMessage(websocket.TextMessage, []byte("40"+JSON(auth))); e != nil {
		t.Fatal(e)
	}
	for {
		_, raw, e = c.ReadMessage()
		if e != nil {
			t.Fatalf("Socket.IO namespace connect failed: %v", e)
		}
		packet := string(raw)
		if strings.HasPrefix(packet, "40") {
			return c, true
		}
		if strings.HasPrefix(packet, "44") {
			return c, false
		}
		if packet == "2" {
			c.WriteMessage(websocket.TextMessage, []byte("3"))
		}
	}
}

func TestIntegrationCookieCSRFNativeAndSocketOrigin(t *testing.T) {
	a, srv := integrationApp(t)
	uid, _, token, csrf := integrationSession(a, false)
	for _, tc := range []struct {
		name, cookie, bearer, csrf, origin string
		want                               int
	}{
		{"cookie read", token, "", "", "", 200},
		{"native read", "", token, "", "", 200},
		{"invalid bearer overrides cookie", token, "invalid", "", "", 401},
		{"hostile origin cookie", token, "", "", "https://attacker.invalid", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := integrationHTTP(a, "GET", "/api/v1/auth/me", tc.cookie, tc.bearer, tc.csrf, tc.origin, nil)
			if r.Code != tc.want {
				t.Fatalf("%d: %s", r.Code, r.Body.String())
			}
		})
	}
	for _, tc := range []struct {
		name, cookie, bearer, csrf, origin string
		want                               int
	}{
		{"cookie requires origin", token, "", csrf, "", 403},
		{"cookie requires csrf", token, "", "", "https://dorham.example", 403},
		{"cookie rejects wrong csrf", token, "", "wrong", "https://dorham.example", 403},
		{"native bearer no cookie proof", "", token, "", "capacitor://localhost", 200},
		{"cookie accepts csrf", token, "", csrf, "https://dorham.example", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, fresh, freshCSRF := integrationSession(a, false)
			if tc.cookie != "" {
				tc.cookie = fresh
			}
			if tc.bearer != "" {
				tc.bearer = fresh
			}
			if tc.csrf == csrf {
				tc.csrf = freshCSRF
			}
			r := integrationHTTP(a, "POST", "/api/v1/auth/renew", tc.cookie, tc.bearer, tc.csrf, tc.origin, M{"requestId": ID()})
			if r.Code != tc.want {
				t.Fatalf("%d: %s", r.Code, r.Body.String())
			}
			if r.Code == 200 { // Renewal intentionally rotates the access token.
				for _, c := range r.Result().Cookies() {
					if c.Name == "dorham_session" {
						token = c.Value
					}
				}
			}
		})
	}
	// Use a fresh credential because successful renewal rotates access hashes.
	uid, _, token, csrf = integrationSession(a, false)
	if _, ok := integrationSocket(t, srv.URL, "https://attacker.invalid", token, M{"csrf": csrf}); ok {
		t.Fatal("hostile socket origin accepted")
	}
	if _, ok := integrationSocket(t, srv.URL, "https://dorham.example", token, M{"csrf": "wrong"}); ok {
		t.Fatal("socket cookie without CSRF proof accepted")
	}
	if _, ok := integrationSocket(t, srv.URL, "https://dorham.example", token, M{"csrf": csrf}); !ok {
		t.Fatal("legitimate cookie socket rejected")
	}
	if !a.Hub.Online(uid) {
		t.Fatal("authenticated socket absent from presence")
	}
	if _, ok := integrationSocket(t, srv.URL, "dorham://app", "", M{"token": token}); !ok {
		t.Fatal("legacy native token handshake rejected")
	}
}

func TestIntegrationBrowserJSONContentTypeWithoutRequestBody(t *testing.T) {
	a, _ := integrationApp(t)
	_, _, token, _ := integrationSession(a, true)
	for _, tc := range []struct {
		method, path, body string
		want               int
	}{
		{"GET", "/health", "", 200},
		{"GET", "/api/v1/auth/me", "", 200},
		{"POST", "/api/v1/auth/login", "", 400},
		{"POST", "/api/v1/auth/login", "{", 400},
		{"GET", "/health", "null", 400},
	} {
		r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		a.HTTP.Handler.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatalf("%s %s body %q got HTTP %d: %s", tc.method, tc.path, tc.body, w.Code, w.Body.String())
		}
	}
}

func TestIntegrationSocketExpiryAndRevocationRechecked(t *testing.T) {
	a, srv := integrationApp(t)
	_, sid, token, _ := integrationSession(a, true)
	c, ok := integrationSocket(t, srv.URL, "capacitor://localhost", "", M{"token": token})
	if !ok {
		t.Fatal("valid native handshake rejected")
	}
	a.DB.Run("UPDATE sessions SET access_expires=? WHERE id=?", Now()-1, sid)
	if _, ok = integrationSocket(t, srv.URL, "capacitor://localhost", "", M{"token": token}); ok {
		t.Fatal("expired native token reconnect accepted")
	}
	if e := c.WriteMessage(websocket.TextMessage, []byte(`421["voice:leave",{"requestId":"`+ID()+`"}]`)); e != nil {
		t.Fatal(e)
	}
	for {
		_, raw, e := c.ReadMessage()
		if e != nil {
			break
		}
		if strings.HasPrefix(string(raw), "41") {
			break
		}
		if strings.HasPrefix(string(raw), "431") && strings.Contains(string(raw), `"ok":true`) {
			t.Fatal("expired session executed authenticated action")
		}
	}
	// Explicit revocation must reject a new handshake too, regardless of recovery.
	a.DB.Run("DELETE FROM sessions WHERE id=?", sid)
	if _, ok = integrationSocket(t, srv.URL, "capacitor://localhost", "", M{"token": token}); ok {
		t.Fatal("revoked session reconnected")
	}
}

func TestIntegrationDBRollbackBackupAndInstanceOwnership(t *testing.T) {
	a, _ := integrationApp(t)
	uid, _, token, _ := integrationSession(a, false)
	before := a.DB.All("SELECT version FROM schema_migrations ORDER BY version")
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("transaction failure did not propagate")
			}
		}()
		a.DB.Tx(func(tx *DB) any {
			tx.Run("UPDATE users SET display_name='Must rollback' WHERE id=?", uid)
			Fail(409, "TEST_ROLLBACK", "rollback")
			return nil
		})
	}()
	if Str(a.DB.One("SELECT display_name FROM users WHERE id=?", uid), "display_name") != "Integration" {
		t.Fatal("failed transaction persisted data")
	}
	backup := filepath.Join(t.TempDir(), "rollback.sqlite")
	a.DB.Backup(backup)
	if _, e := os.Stat(backup); e != nil {
		t.Fatal(e)
	}
	restoredConfig := a.C
	restoredConfig.DataDir = t.TempDir()
	data, e := os.ReadFile(backup)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(restoredConfig.DataDir, "dorham.sqlite"), data, 0600); e != nil {
		t.Fatal(e)
	}
	restored := OpenDB(restoredConfig)
	defer restored.Close()
	if JSON(before) != JSON(restored.All("SELECT version FROM schema_migrations ORDER BY version")) {
		t.Fatal("backup restoration changed migration ledger")
	}
	if Str(restored.One("PRAGMA integrity_check"), "integrity_check") != "ok" || len(restored.All("PRAGMA foreign_key_check")) != 0 {
		t.Fatal("restored backup failed database integrity")
	}
	if restored.One("SELECT id FROM sessions WHERE access_hash=?", Hash(token)) == nil {
		t.Fatal("backup lost existing client session")
	}
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("two servers acquired same data directory")
			}
		}()
		second := NewApp(a.C)
		second.Close()
	}()
	if _, e = os.Stat(a.lockPath); e != nil {
		t.Fatal("failed concurrent startup removed owner lock")
	}
}

func TestIntegrationExistingNodeArgon2Credentials(t *testing.T) {
	// Generated with the deployed Node argon2@0.45.1 package, explicit test
	// salt, and the historical application hash parameters. That implementation
	// serializes m,p,t; PHC parameter order is not a password compatibility rule.
	const encoded = "$argon2id$v=19$m=19456,p=1,t=2$ZG9yaGFtLXRlc3Qtc2FsdCE$JVir3fBUNcHqxmsnJFItyvcrh4outKsGxm27sVqSolw"
	const password = "Compatibility-سلام-123"
	if !PasswordVerify(encoded, password) {
		t.Fatal("existing Node Argon2 password rejected")
	}
	if PasswordVerify(encoded, password+"incorrect") {
		t.Fatal("wrong password accepted")
	}
	for _, param := range []string{"m=19456,t=2,p=1", "p=1,t=2,m=19456", "t=2,m=19456,p=1"} {
		if !PasswordVerify(strings.Replace(encoded, "m=19456,p=1,t=2", param, 1), password) {
			t.Fatalf("valid parameter ordering rejected: %s", param)
		}
	}
	for _, param := range []string{"m=19456,p=1,p=2", "m=19456,p=1", "m=19456,p=1,t=2,foo=1", "m=999999999,p=1,t=2", "m=19456,p=0,t=2", "m=19456,p=1,t=0"} {
		if PasswordVerify(strings.Replace(encoded, "m=19456,p=1,t=2", param, 1), password) {
			t.Fatalf("invalid parameters accepted: %s", param)
		}
	}
	a, _ := integrationApp(t)
	uid, _, _, _ := integrationSession(a, true)
	a.DB.Run("UPDATE users SET username='node_legacy',password_hash=? WHERE id=?", encoded, uid)
	r := integrationHTTP(a, "POST", "/api/v1/auth/login", "", "", "", "capacitor://localhost", M{"username": "node_legacy", "password": password, "requestId": ID()})
	if r.Code != 200 {
		t.Fatalf("existing account cannot login after Go migration: HTTP %d %s", r.Code, r.Body.String())
	}
}

func TestIntegrationNativeRefreshRotationAndReplayRevocation(t *testing.T) {
	a, _ := integrationApp(t)
	_, sid, access, csrf := integrationSession(a, true)
	refresh := Token()
	a.DB.Run("UPDATE sessions SET refresh_hash=? WHERE id=?", Hash(refresh), sid)
	request := M{"refreshToken": refresh, "requestId": ID()}
	r := integrationHTTP(a, "POST", "/api/v1/auth/refresh", "", "", "", "capacitor://localhost", request)
	if r.Code != 200 {
		t.Fatalf("native refresh failed: %d %s", r.Code, r.Body.String())
	}
	rotated := Obj(Parse(r.Body.String()))
	if Str(rotated, "csrf") != csrf || Str(rotated, "accessToken") == access || Str(rotated, "refreshToken") == refresh {
		t.Fatal("native renewal failed token rotation or changed CSRF contract")
	}
	if u, _ := a.resolveSession(access); u != nil {
		t.Fatal("old native access token survives rotation")
	}
	if u, _ := a.resolveSession(Str(rotated, "accessToken")); u == nil {
		t.Fatal("rotated native access token rejected")
	}
	r = integrationHTTP(a, "POST", "/api/v1/auth/refresh", "", "", "", "capacitor://localhost", request)
	if r.Code != 401 {
		t.Fatalf("refresh replay accepted: HTTP %d", r.Code)
	}
	if u, _ := a.resolveSession(Str(rotated, "accessToken")); u != nil {
		t.Fatal("refresh replay failed to revoke entire session")
	}
}

func TestIntegrationOfflineBackupPreservesRowsAndHistoricalSchema(t *testing.T) {
	a, _ := integrationApp(t)
	uid, _, _, _ := integrationSession(a, true)
	server, channel, lease, game := ID(), ID(), ID(), ID()
	a.DB.Run("INSERT INTO servers(id,name,owner_id,created_at) VALUES(?,?,?,?)", server, "Backup server", uid, Now())
	a.DB.Run("INSERT INTO channels(id,server_id,name,kind,created_at) VALUES(?,?,?,'voice',?)", channel, server, "Voice", Now())
	a.DB.Run("INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,heartbeat,joined_at) VALUES(?,?,?,?,?,?)", uid, channel, "preserve-socket", "preserve-epoch", Now(), Now())
	a.DB.Run("INSERT INTO coordinators(channel_id,user_id,epoch,expires_at) VALUES(?,?,17,?)", channel, uid, Now()+60000)
	a.DB.Run("INSERT INTO share_leases(id,user_id,channel_id,expires_at) VALUES(?,?,?,?)", lease, uid, channel, Now()+60000)
	a.DB.Run("INSERT INTO game_sessions(id,server_id,channel_id,host_id,kind,status,updated_at,state) VALUES(?,?,?,?,?,?,?,?)", game, server, channel, uid, "four", "active", Now(), `{"id":"preserve-game-state"}`)
	tables := []string{"schema_migrations", "users", "sessions", "voice_members", "coordinators", "share_leases", "game_sessions"}
	want := map[string]string{}
	for _, table := range tables {
		// Runtime voice rows are intentionally TEMP-only; offline backup must
		// preserve the durable main schema, without synthesizing runtime rows.
		want[table] = JSON(a.DB.All("SELECT * FROM main." + table))
	}
	c := a.C
	activeDest := filepath.Join(t.TempDir(), "must-not-run-while-active.sqlite")
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("offline backup ignored active server ownership lock")
			}
		}()
		OfflineBackup(c, activeDest)
	}()
	if _, e := os.Stat(activeDest); !os.IsNotExist(e) {
		t.Fatal("blocked offline backup created destination")
	}
	if _, e := os.Stat(a.lockPath); e != nil {
		t.Fatal("blocked offline backup removed live server ownership lock")
	}
	a.Close()
	dest := filepath.Join(t.TempDir(), "offline.sqlite")
	OfflineBackup(c, dest)
	protected, e := os.ReadFile(dest)
	if e != nil {
		t.Fatal(e)
	}
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("offline backup overwrote existing recovery file")
			}
		}()
		OfflineBackup(c, dest)
	}()
	protectedAfter, e := os.ReadFile(dest)
	if e != nil || !bytes.Equal(protected, protectedAfter) {
		t.Fatal("existing recovery backup changed")
	}
	for _, path := range []string{filepath.Join(c.DataDir, "dorham.sqlite"), dest} {
		raw, e := sql.Open("sqlite", path)
		if e != nil {
			t.Fatal(e)
		}
		db := &DB{raw: raw, mu: &sync.Mutex{}, Dialect: "sqlite"}
		for _, table := range tables {
			if got := JSON(db.All("SELECT * FROM " + table)); got != want[table] {
				t.Errorf("offline backup mutated %s in %s: %s", table, path, got)
			}
		}
		raw.Close()
	}
	// A recovery snapshot must precede migrations, including on older databases.
	old := c
	old.DataDir = t.TempDir()
	oldPath := filepath.Join(old.DataDir, "dorham.sqlite")
	raw, e := sql.Open("sqlite", oldPath)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = raw.Exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at BIGINT NOT NULL); INSERT INTO schema_migrations VALUES(1,123); CREATE TABLE before_migration(marker TEXT); INSERT INTO before_migration VALUES('keep-original')"); e != nil {
		t.Fatal(e)
	}
	raw.Close()
	before, e := os.ReadFile(oldPath)
	if e != nil {
		t.Fatal(e)
	}
	oldDest := filepath.Join(t.TempDir(), "historical.sqlite")
	OfflineBackup(old, oldDest)
	after, e := os.ReadFile(oldPath)
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("backup changed historical source database before taking recovery snapshot")
	}
	raw, e = sql.Open("sqlite", oldDest)
	if e != nil {
		t.Fatal(e)
	}
	defer raw.Close()
	var version int
	if e = raw.QueryRow("SELECT MAX(version) FROM schema_migrations").Scan(&version); e != nil || version != 1 {
		t.Fatalf("offline backup migrated historical ledger: version %d err %v", version, e)
	}
	var marker string
	if e = raw.QueryRow("SELECT marker FROM before_migration").Scan(&marker); e != nil || marker != "keep-original" {
		t.Fatalf("offline snapshot lost historical data: %s %v", marker, e)
	}
}

func TestIntegrationNewGoReceiptRetainsNodeRollbackFingerprint(t *testing.T) {
	f := newCoreFixture(t)
	rid := ID()
	uid := f.users["owner"]
	payload := M{"serverId": "legacy-server", "name": "سلام", "kind": "text"}
	result := f.s.Mutate(uid, rid, "channel.create", payload, func(tx *DB) any { return M{"id": "legacy-result"} })
	if Str(Obj(result), "id") != "legacy-result" {
		t.Fatal("missing mutation response")
	}
	// This literal is Node JSON.stringify({serverId,name,kind}), independently
	// pinned to the released TypeScript service's insertion order.
	const nodeJSON = `{"serverId":"legacy-server","name":"سلام","kind":"text"}`
	stored := f.db.One("SELECT fingerprint FROM mutations WHERE user_id=? AND request_id=?", uid, rid)
	if Str(stored, "fingerprint") != Hash(nodeJSON) {
		t.Fatal("Go-created receipt cannot be retried after rollback to existing Node service")
	}
	result = f.s.Mutate(uid, rid, "channel.create", payload, func(tx *DB) any { t.Fatal("retry reexecuted mutation"); return nil })
	if Str(Obj(result), "id") != "legacy-result" {
		t.Fatal("receipt replay lost existing response")
	}
}
