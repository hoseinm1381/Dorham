package backend

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const mediaMiB int64 = 1048576

var mediaUUID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type mediaTicket struct {
	Session, File string
	Expires       int64
}
type mediaChecked struct {
	Key, MIME string
	Expires   int64
}
type Media struct {
	a                                  *App
	mu                                 sync.Mutex
	writers                            map[string]bool
	readers                            map[string]int
	tickets                            map[string]mediaTicket
	ticketOrder                        []string
	checked                            map[string]mediaChecked
	sweeping                           bool
	scan                               *os.File
	scanMu                             sync.Mutex
	images                             *mediaImages
	speech                             *mediaSpeech
	sfuMu                              sync.Mutex
	sfuActive                          bool
	sfuClosed                          bool
	sfuRequested                       uint64
	sfuWaiters                         []*mediaSFURun
	sfuDirty                           bool
	sfuPasses, sfuUpdates, sfuRemovals int64
	client                             *http.Client
}

func NewMedia(a *App) *Media {
	m := &Media{a: a, writers: map[string]bool{}, readers: map[string]int{}, tickets: map[string]mediaTicket{}, checked: map[string]mediaChecked{}, client: &http.Client{Timeout: 15 * time.Second}, images: newMediaImages()}
	for _, dir := range []string{a.C.AttachmentDir, filepath.Join(a.C.DataDir, "avatars")} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			panic(err)
		}
	}
	m.speech = newMediaSpeech(m)
	return m
}
func (m *Media) RegisterRoutes() {
	m.registerAttachments()
	m.registerImages()
	m.registerSpeech()
	m.registerAdmission()
}
func (m *Media) Close() {
	m.sfuMu.Lock()
	m.sfuClosed = true
	var pending chan struct{}
	if len(m.sfuWaiters) > 0 {
		pending = m.sfuWaiters[len(m.sfuWaiters)-1].done
	}
	m.sfuMu.Unlock()
	if pending != nil {
		<-pending
	}
	m.images.close()
	m.speech.close()
	m.scanMu.Lock()
	defer m.scanMu.Unlock()
	if m.scan != nil {
		m.scan.Close()
		m.scan = nil
	}
}
func (m *Media) Cleanup() { m.cleanupAttachments(0); m.speech.cleanup() }
func (m *Media) Metrics() M {
	s := M{"passes": atomic.LoadInt64(&m.sfuPasses), "permissionUpdates": atomic.LoadInt64(&m.sfuUpdates), "removals": atomic.LoadInt64(&m.sfuRemovals)}
	return M{"tts": m.speech.metrics(), "images": m.images.metrics(), "sfuControl": s}
}
func mediaID(v string) string {
	Check(mediaUUID.MatchString(v), 400, "VALIDATION", "Invalid identifier.")
	return v
}
func mediaRequest(v string) string {
	Check(mediaUUID.MatchString(v), 400, "VALIDATION", "Invalid request identifier.")
	return v
}
func mediaMust(err error) {
	if err != nil {
		panic(err)
	}
}
func (m *Media) file(id string, partial bool) string {
	mediaID(id)
	ext := ".bin"
	if partial {
		ext = ".part"
	}
	return filepath.Join(m.a.C.AttachmentDir, id+ext)
}
func mediaHashFile(name string) (string, []byte, error) {
	f, e := os.Open(name)
	if e != nil {
		return "", nil, e
	}
	defer f.Close()
	h := sha256.New()
	prefix := make([]byte, 512)
	n, e := io.ReadFull(f, prefix)
	if e != nil && e != io.EOF && e != io.ErrUnexpectedEOF {
		return "", nil, e
	}
	prefix = prefix[:n]
	h.Write(prefix)
	if _, e = io.Copy(h, f); e != nil {
		return "", nil, e
	}
	return hex.EncodeToString(h.Sum(nil)), prefix, nil
}
func mediaSafe(fn func()) (ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	fn()
	return true
}
func mediaError(status int, code, message string) { Fail(status, code, message) }
func (m *Media) emitSocket(socket, event string, payload any) {
	m.a.Hub.EmitSocket(socket, event, payload)
}

// JWT and Twirp use the same HS256 access grants as the official LiveKit SDK.
// No network request or DB transaction can leak a bearer token into a URL/log.
func mediaJWT(key, secret, subject string, video M, ttl int64) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	now := time.Now().Unix()
	body := M{"iss": key, "sub": subject, "nbf": now, "exp": now + ttl, "video": video}
	if subject != "" {
		body["name"] = strings.Split(subject, ":")[0]
	}
	p := header + "." + base64.RawURLEncoding.EncodeToString([]byte(JSON(body)))
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(p))
	return p + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func mediaVerifyJWT(raw, key, secret string) M {
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return nil
	}
	head, e := base64.RawURLEncoding.DecodeString(parts[0])
	if e != nil {
		return nil
	}
	var h M
	if json.Unmarshal(head, &h) != nil || Str(h, "alg") != "HS256" {
		return nil
	}
	sig, e := base64.RawURLEncoding.DecodeString(parts[2])
	if e != nil {
		return nil
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return nil
	}
	data, e := base64.RawURLEncoding.DecodeString(parts[1])
	if e != nil {
		return nil
	}
	var body M
	if json.Unmarshal(data, &body) != nil || Str(body, "iss") != key {
		return nil
	}
	now := time.Now().Unix()
	if Num(body, "exp") <= now || Num(body, "nbf") > now {
		return nil
	}
	return body
}
func (m *Media) twirp(method string, body M, grant M) (M, error) {
	base := m.a.C.LivekitAPIURL
	if base == "" {
		base = m.a.C.LivekitURL
		base = strings.Replace(base, "wss://", "https://", 1)
		base = strings.Replace(base, "ws://", "http://", 1)
	}
	req, e := http.NewRequest("POST", strings.TrimRight(base, "/")+"/twirp/livekit.RoomService/"+method, strings.NewReader(JSON(body)))
	if e != nil {
		return nil, e
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+mediaJWT(m.a.C.LivekitKey, m.a.C.LivekitSecret, "", grant, 60))
	res, e := m.client.Do(req)
	if e != nil {
		return nil, e
	}
	defer res.Body.Close()
	data, e := io.ReadAll(io.LimitReader(res.Body, 8*mediaMiB))
	if e != nil {
		return nil, e
	}
	var out M
	if json.Unmarshal(data, &out) != nil {
		return nil, fmt.Errorf("invalid SFU response")
	}
	if res.StatusCode >= 300 {
		return nil, &mediaSFUError{Str(out, "code")}
	}
	return out, nil
}

type mediaSFUError struct{ code string }

func (e *mediaSFUError) Error() string { return "SFU control failed: " + e.code }

type mediaSFURun struct {
	done     chan struct{}
	failure  any
	revision uint64
}

func mediaMissing(e error) bool { v, ok := e.(*mediaSFUError); return ok && v.code == "not_found" }
