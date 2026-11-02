package backend

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sync"
	"time"
)

const CloudflareTurnTTL int64 = 86400

type turnEntry struct {
	until   int64
	done    chan struct{}
	servers []M
	failed  bool
}
type CloudflareTurn struct {
	keyID, apiToken string
	client          *http.Client
	baseURL         string
	now             func() int64
	mu              sync.Mutex
	cache           map[string]*turnEntry
	order           []string
}

func NewCloudflareTurn(keyID, apiToken string) *CloudflareTurn {
	return &CloudflareTurn{keyID: keyID, apiToken: apiToken, client: &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return fmt.Errorf("redirect denied") }}, baseURL: "https://rtc.live.cloudflare.com", now: Now, cache: map[string]*turnEntry{}}
}
func turnClone(rows []M) []M {
	out := []M{}
	for _, r := range rows {
		out = append(out, Obj(Parse(JSON(r))))
	}
	return out
}
func (t *CloudflareTurn) ForUser(uid string) []M {
	now := t.now()
	t.mu.Lock()
	if old := t.cache[uid]; old != nil && old.until > now {
		t.mu.Unlock()
		<-old.done
		if old.failed {
			Fail(503, "TURN_UNAVAILABLE", "The media relay is unavailable. Please retry shortly or contact the server owner.")
		}
		return turnClone(old.servers)
	}
	order := []string{}
	for _, id := range t.order {
		if e := t.cache[id]; e != nil && e.until > now {
			order = append(order, id)
		} else {
			delete(t.cache, id)
		}
	}
	t.order = order
	if len(t.cache) >= 100 && len(t.order) > 0 {
		delete(t.cache, t.order[0])
		t.order = t.order[1:]
	}
	entry := &turnEntry{until: now + 60000, done: make(chan struct{})}
	t.cache[uid] = entry
	t.order = append(t.order, uid)
	t.mu.Unlock()
	entry.servers, entry.failed = t.generate()
	close(entry.done)
	if entry.failed {
		Fail(503, "TURN_UNAVAILABLE", "The media relay is unavailable. Please retry shortly or contact the server owner.")
	}
	return turnClone(entry.servers)
}

var turnCloudflareURL = regexp.MustCompile(`^(stun|turn|turns):(?:stun|turn)\.cloudflare\.com:(3478|443|80|5349)(\?transport=(udp|tcp))?$`)

func (t *CloudflareTurn) generate() (servers []M, failed bool) {
	// Provider payloads can contain credentials. No underlying transport/JSON
	// error is allowed to cross the safe generic TURN_UNAVAILABLE boundary.
	failed = true
	defer func() {
		if recover() != nil {
			servers = nil
			failed = true
		}
	}()
	req, err := http.NewRequest(http.MethodPost, t.baseURL+"/v1/turn/keys/"+url.PathEscape(t.keyID)+"/credentials/generate-ice-servers", bytes.NewBufferString(`{"ttl":86400}`))
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+t.apiToken)
	req.Header.Set("Content-Type", "application/json")
	res, err := t.client.Do(req)
	if err != nil {
		return
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 65537))
	if err != nil || len(data) > 65536 {
		return
	}
	var parsed struct {
		IceServers []struct {
			URLs       json.RawMessage `json:"urls"`
			Username   *string         `json:"username"`
			Credential *string         `json:"credential"`
		} `json:"iceServers"`
	}
	if json.Unmarshal(data, &parsed) != nil || len(parsed.IceServers) < 1 || len(parsed.IceServers) > 8 {
		return
	}
	servers = []M{}
	relay := false
	for _, r := range parsed.IceServers {
		var urls []string
		var single string
		if json.Unmarshal(r.URLs, &single) == nil {
			urls = []string{single}
		} else if json.Unmarshal(r.URLs, &urls) != nil || len(urls) < 1 || len(urls) > 12 {
			return nil, true
		}
		if r.Username != nil && (len(*r.Username) < 1 || len(*r.Username) > 2048) {
			return nil, true
		}
		if r.Credential != nil && (len(*r.Credential) < 1 || len(*r.Credential) > 2048) {
			return nil, true
		}
		valid := []string{}
		hasRelay := false
		for _, u := range urls {
			if turnCloudflareURL.MatchString(u) {
				valid = append(valid, u)
				if len(u) >= 5 && u[:5] == "turn:" || len(u) >= 6 && u[:6] == "turns:" {
					hasRelay = true
				}
			}
		}
		if len(valid) == 0 {
			continue
		}
		if hasRelay && (r.Username == nil || r.Credential == nil) {
			return nil, true
		}
		server := M{"urls": valid}
		if r.Username != nil {
			server["username"] = *r.Username
		}
		if r.Credential != nil {
			server["credential"] = *r.Credential
		}
		servers = append(servers, server)
		relay = relay || hasRelay
	}
	if !relay {
		return nil, true
	}
	return servers, false
}
