package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type jsonNumber = json.Number
type Request struct {
	A                   *App
	W                   http.ResponseWriter
	R                   *http.Request
	Body, User, Session M
	status              int
	written             bool
}

func (r *Request) Param(k string) string { return VID(r.R.PathValue(k)) }
func (r *Request) Query(k string) string { return r.R.URL.Query().Get(k) }
func (r *Request) UID() string           { return Str(r.User, "id") }
func (r *Request) Status(n int)          { r.status = n }
func (r *Request) Header(k, v string)    { r.W.Header().Set(k, v) }

type windowBudget struct {
	At    int64
	Count int
}
type App struct {
	C             Config
	DB            *DB
	Service       *Service
	Hub           *Hub
	Media         *Media
	Games         *Games
	Mux           *http.ServeMux
	HTTP          *http.Server
	started       time.Time
	stop          chan struct{}
	closeOnce     sync.Once
	maintenanceWG sync.WaitGroup
	rateMu        sync.Mutex
	rates         map[string]windowBudget
	lockPath      string
}

func NewApp(c Config) *App {
	a := &App{C: c, Mux: http.NewServeMux(), started: time.Now(), stop: make(chan struct{}), rates: map[string]windowBudget{}}
	if e := os.MkdirAll(c.DataDir, 0700); e != nil {
		panic(e)
	}
	a.acquireLock()
	defer func() {
		if p := recover(); p != nil {
			os.Remove(a.lockPath)
			panic(p)
		}
	}()
	a.DB = OpenDB(c)
	a.Service = NewService(a.DB, c)
	a.Hub = NewHub(a)
	a.DB.Tx(func(tx *DB) any {
		tx.Run("DELETE FROM voice_members")
		tx.Run("UPDATE coordinators SET user_id=NULL,epoch=epoch+1,expires_at=0")
		return nil
	})
	a.DB.EnableRuntimeStorage()
	a.Media = NewMedia(a)
	a.Games = NewGames(a)
	a.Service.Notify = a.Hub.Notify
	a.Service.OnTTS = a.Media.Speech
	a.registerAuth()
	a.registerCore()
	a.Media.RegisterRoutes()
	a.Games.RegisterRoutes()
	a.Hub.Register()
	a.Route("GET", "/health", false, func(r *Request) any { return M{"status": "ok"} })
	a.Route("GET", "/ready", false, func(r *Request) any {
		a.DB.One("SELECT version FROM schema_migrations LIMIT 1")
		return M{"status": "ready", "database": a.DB.Dialect}
	})
	a.Route("GET", "/api/v1/config", false, func(r *Request) any {
		return M{"registrationOpen": c.RegistrationOpen, "mediaTransport": c.MediaTransport, "publicUrl": c.PublicURL, "guestsEnabled": c.GuestsEnabled}
	})
	a.Mux.HandleFunc("/", a.static)
	a.HTTP = &http.Server{Handler: a.middleware(a.Mux), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Minute, IdleTimeout: 65 * time.Second, MaxHeaderBytes: 32768}
	a.maintenanceWG.Add(1)
	go a.maintenance()
	return a
}
func (a *App) Route(method, path string, auth bool, fn func(*Request) any) {
	a.Mux.HandleFunc(method+" "+path, func(w http.ResponseWriter, req *http.Request) {
		r := &Request{A: a, W: w, R: req, Body: M{}, status: 200}
		defer func() {
			if v := recover(); v != nil {
				a.writeError(w, v)
			}
		}()
		if auth {
			a.authenticate(r)
		}
		if strings.HasPrefix(req.Header.Get("Content-Type"), "multipart/form-data") {
			req.Body = http.MaxBytesReader(w, req.Body, 512*1024)
		}
		if req.Body != nil && req.ContentLength != 0 && strings.HasPrefix(req.Header.Get("Content-Type"), "application/json") {
			d := json.NewDecoder(http.MaxBytesReader(w, req.Body, 128*1024))
			d.UseNumber()
			var b M
			if e := d.Decode(&b); e != nil || b == nil {
				Fail(400, "VALIDATION", "Invalid JSON body")
			}
			var extra any
			Check(d.Decode(&extra) == io.EOF, 400, "VALIDATION", "Invalid JSON body")
			r.Body = b
		}
		if a.C.RateLimit {
			a.rateRequest(r)
		}
		result := fn(r)
		if result == nil {
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(r.status)
		enc := json.NewEncoder(w)
		enc.SetEscapeHTML(false)
		_ = enc.Encode(result)
	})
}
func (a *App) writeError(w http.ResponseWriter, v any) {
	e := RecoverError(v)
	if e.Status == 500 {
		log.Printf("request failed: %T", v)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(e.Status)
	_ = json.NewEncoder(w).Encode(M{"error": M{"code": e.Code, "message": e.Message}})
}
func (a *App) allowed(origin string) bool { return origin == "" || Contains(a.C.Origins, origin) }
func (a *App) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if !a.allowed(origin) {
			a.writeError(w, APIError{403, "ORIGIN", "Origin is not allowed."})
			return
		}
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CSRF-Token, X-Request-Id, X-Dorham-Native, Range")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https: wss:"+func() string {
			if !a.C.Production {
				return " http: ws:"
			}
			return ""
		}()+"; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'")
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/internal/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}
func (a *App) sourceIP(r *http.Request) string {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	addr, _ := netip.ParseAddr(host)
	trusted := false
	for _, t := range a.C.TrustedProxies {
		p, e := netip.ParsePrefix(t)
		if e == nil && p.Contains(addr) {
			trusted = true
		}
		if t == host {
			trusted = true
		}
	}
	if trusted {
		parts := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
		for i := len(parts) - 1; i >= 0; i-- {
			candidate := strings.TrimSpace(parts[i])
			ip, e := netip.ParseAddr(candidate)
			if e != nil {
				continue
			}
			isTrusted := false
			for _, t := range a.C.TrustedProxies {
				p, e := netip.ParsePrefix(t)
				if t == candidate || (e == nil && p.Contains(ip)) {
					isTrusted = true
				}
			}
			host = candidate
			if !isTrusted {
				break
			}
		}
	}
	return host
}
func (a *App) takeRate(key string, max int, window int64) {
	a.rateMu.Lock()
	defer a.rateMu.Unlock()
	now := Now()
	v := a.rates[key]
	if v.At+window <= now {
		v = windowBudget{At: now}
	}
	v.Count++
	if len(a.rates) > 10000 {
		for k, x := range a.rates {
			if x.At+3600000 < now {
				delete(a.rates, k)
			}
		}
		Check(len(a.rates) < 20000, 429, "RATE_LIMIT", "Too many requests.")
	}
	a.rates[key] = v
	Check(v.Count <= max, 429, "RATE_LIMIT", "Too many requests. Please retry later.")
}
func (a *App) rateRequest(r *Request) {
	source := a.sourceIP(r.R)
	a.takeRate("source-budget:"+source, 6000, 60000)
	key := "source:" + source
	if r.User != nil {
		key = "account:" + r.UID()
	} else if u, _ := a.resolveSession(a.rawToken(r.R)); u != nil {
		key = "account:" + Str(u, "id")
	}
	a.takeRate(key, 600, 60000)
	if r.R.Method == "POST" && Contains([]string{"/api/v1/auth/login", "/api/v1/auth/register", "/api/v1/auth/recover", "/api/v1/auth/guest", "/api/v1/auth/refresh"}, r.R.URL.Path) {
		a.takeRate("auth-source:"+source, 60, 900000)
		if name := Str(r.Body, "username"); name != "" && len(name) <= 32 {
			a.takeRate("auth-account:"+Hash(strings.ToLower(name)), 60, 900000)
		}
	}
}
func (a *App) rawToken(r *http.Request) string {
	if s := r.Header.Get("Authorization"); strings.HasPrefix(s, "Bearer ") {
		return strings.TrimPrefix(s, "Bearer ")
	}
	if c, e := r.Cookie("dorham_session"); e == nil {
		return c.Value
	}
	return ""
}
func (a *App) resolveSession(raw string) (M, M) {
	if raw == "" || len(raw) > 512 {
		return nil, nil
	}
	columns := []string{"id", "user_id", "access_hash", "refresh_hash", "csrf", "native", "access_expires", "expires_at", "created_at", "device_name", "last_seen"}
	selects := []string{"u.*"}
	for _, col := range columns {
		selects = append(selects, "s."+col+" AS session_"+col)
	}
	u := a.DB.One("SELECT "+strings.Join(selects, ",")+" FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.access_hash=? AND s.access_expires>=? AND s.expires_at>=? AND u.banned=0", Hash(raw), Now(), Now())
	if u == nil {
		return nil, nil
	}
	s := M{}
	for _, col := range columns {
		s[col] = u["session_"+col]
		delete(u, "session_"+col)
	}
	return u, s
}
func (a *App) authenticate(r *Request) {
	u, s := a.resolveSession(a.rawToken(r.R))
	_, ticketPresent := r.R.URL.Query()["media_ticket"]
	if strings.HasSuffix(r.R.URL.Path, "/media") && strings.HasPrefix(r.R.URL.Path, "/api/v1/attachments/") && ticketPresent && (r.R.Method == "GET" || r.R.Method == "HEAD") {
		u, s = nil, nil
		if a.Media != nil {
			sid := a.Media.ResolveTicket(r.Query("media_ticket"), r.R.PathValue("id"))
			if sid != "" {
				s = a.DB.One("SELECT * FROM sessions WHERE id=? AND expires_at>?", sid, Now())
				if s != nil {
					u = a.DB.One("SELECT * FROM users WHERE id=? AND banned=0", s["user_id"])
				}
			}
		}
	}
	Check(u != nil && s != nil, 401, "UNAUTHENTICATED", "Please sign in.")
	r.User, r.Session = u, s
	if B(u["must_change_password"]) && !Contains([]string{"/api/v1/auth/me", "/api/v1/auth/password", "/api/v1/auth/logout"}, r.R.URL.Path) {
		Fail(403, "PASSWORD_CHANGE_REQUIRED", "Change your temporary password before continuing.")
	}
	if !Contains([]string{"GET", "HEAD", "OPTIONS"}, r.R.Method) && !strings.HasPrefix(r.R.Header.Get("Authorization"), "Bearer ") {
		origin := r.R.Header.Get("Origin")
		Check(origin != "" && a.allowed(origin) && Equal(r.R.Header.Get("X-CSRF-Token"), Str(s, "csrf")), 403, "CSRF", "Refresh your session and retry.")
	}
}
func (a *App) static(w http.ResponseWriter, r *http.Request) {
	root := absolute("apps/web/dist")
	path := r.URL.Path
	if strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/internal/") {
		a.writeError(w, APIError{404, "NOT_FOUND", "Not found."})
		return
	}
	if strings.HasPrefix(path, "/avatars/") {
		root = filepath.Join(a.C.DataDir, "avatars")
		path = strings.TrimPrefix(path, "/avatars")
		w.Header().Set("Cache-Control", "public, max-age=3600, immutable")
	}
	clean := filepath.Clean(filepath.FromSlash("/" + path))
	target := filepath.Join(root, strings.TrimLeft(clean, "/\\"))
	rel, e := filepath.Rel(root, target)
	if e != nil || strings.HasPrefix(rel, "..") {
		a.writeError(w, APIError{404, "NOT_FOUND", "Not found."})
		return
	}
	if st, e := os.Stat(target); e != nil || st.IsDir() {
		if strings.HasPrefix(r.URL.Path, "/avatars/") {
			a.writeError(w, APIError{404, "NOT_FOUND", "Not found."})
			return
		}
		target = filepath.Join(root, "index.html")
	}
	if strings.HasSuffix(target, "sw.js") {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeFile(w, r, target)
}
func (a *App) Listen(address string) error { return a.HTTP.ListenAndServe() }
func (a *App) Serve(l net.Listener) error  { return a.HTTP.Serve(l) }
func (a *App) Close() {
	a.closeOnce.Do(func() {
		close(a.stop)
		a.Hub.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		a.HTTP.Shutdown(ctx)
		a.maintenanceWG.Wait()
		a.Games.Close()
		a.Media.Close()
		a.DB.Close()
		if p, e := os.ReadFile(a.lockPath); e == nil && strings.TrimSpace(string(p)) == strconv.Itoa(os.Getpid()) {
			os.Remove(a.lockPath)
		}
	})
}
func (a *App) maintenance() {
	defer a.maintenanceWG.Done()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	next := time.Now().Add(5 * time.Second)
	nextRetention := time.Time{}
	for {
		select {
		case <-a.stop:
			return
		case <-ticker.C:
			started := time.Now()
			delay := started.Sub(next)
			next = started.Add(5 * time.Second)
			func() {
				defer func() { a.Hub.recordMaintenance(time.Since(started), delay) }()
				defer func() {
					if v := recover(); v != nil {
						log.Printf("maintenance failed: %T", v)
					}
				}()
				retention := !started.Before(nextRetention)
				a.DB.TunePageCache()
				a.Media.speech.cleanup()
				if retention {
					a.Media.cleanupAttachments(0)
				}
				a.Service.Cleanup(retention)
				if retention {
					nextRetention = started.Add(time.Minute)
				}
				a.Hub.DisconnectInvalid()
				a.Hub.Notify("voice:changed", M{})
			}()
		}
	}
}
func (a *App) metrics() M {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	var disk int64
	entries, _ := os.ReadDir(a.C.DataDir)
	for _, f := range entries {
		if s, e := f.Info(); e == nil && !s.IsDir() {
			disk += s.Size()
		}
	}
	media := a.Media.Metrics()
	mediaStorage := a.Media.Storage()
	mediaStorage["io"] = media["attachmentIO"]
	return M{"uptimeSeconds": time.Since(a.started).Seconds(), "runtime": "go", "version": "1.1.0", "databaseIO": a.DB.Metrics(), "memory": M{"rss": processRSS(), "heapUsed": m.HeapAlloc, "heapTotal": m.HeapSys, "external": m.Sys - m.HeapSys, "arrayBuffers": 0}, "go": M{"goroutines": runtime.NumGoroutine(), "gcCycles": m.NumGC}, "tts": media["tts"], "images": media["images"], "sfuControl": media["sfuControl"], "cpu": processCPU(), "eventLoop": M{"meanMs": 0, "p95Ms": 0, "maxMs": 0, "applicable": false}, "realtime": a.Hub.Metrics(), "dataBytes": disk, "storage": a.storageStatus(), "attachments": mediaStorage, "connectedUsers": len(a.Hub.Users()), "accounts": a.DB.One("SELECT COUNT(*) AS count FROM users")["count"], "messages": a.DB.One("SELECT COUNT(*) AS count FROM messages")["count"], "shares": a.DB.One("SELECT COUNT(*) AS count FROM share_leases")["count"]}
}

var _ = fmt.Sprint
