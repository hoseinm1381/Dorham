package backend

import (
	"fmt"
	sio "github.com/zishang520/socket.io/servers/socket/v3"
	sioTypes "github.com/zishang520/socket.io/v3/pkg/types"
	"log"
	"net/http"
	"sync"
	"time"
)

type peer struct {
	socket                                            *sio.Socket
	id, uid, session                                  string
	mu                                                sync.Mutex
	eventMu                                           sync.Mutex
	voiceChannel, gameWatching, directoryKey, roomKey string
	windowStart                                       int64
	eventCount                                        int
	latency                                           M
	probing                                           bool
}
type Hub struct {
	a            *App
	server       *sio.Server
	mu           sync.RWMutex
	peers        map[string]*peer
	voiceRefresh revisionFlight
	closed       bool
	workWG       sync.WaitGroup
	loopWG       sync.WaitGroup
	metricMu     sync.Mutex
	actions      map[string]M
	disconnects  map[string]int64
	maintenance  M
}

func NewHub(a *App) *Hub {
	opts := sio.DefaultServerOptions()
	opts.SetCors(&sioTypes.Cors{Origin: func(origin string) bool { return a.allowed(origin) }, Credentials: true, Methods: []string{"GET", "POST"}})
	opts.SetMaxHttpBufferSize(128 * 1024)
	opts.SetPingInterval(20 * time.Second)
	opts.SetPingTimeout(10 * time.Second)
	recovery := &sio.ConnectionStateRecovery{}
	recovery.SetMaxDisconnectionDuration(120000)
	recovery.SetSkipMiddlewares(false)
	opts.SetConnectionStateRecovery(recovery)
	return &Hub{a: a, server: sio.NewServer(nil, opts), peers: map[string]*peer{}}
}
func (h *Hub) Register() {
	h.a.Mux.Handle("/socket.io/", h.server.ServeHandler(nil))
	h.server.Use(func(s *sio.Socket, next func(*sio.ExtendedError)) {
		h.mu.Lock()
		if h.closed {
			h.mu.Unlock()
			next(sio.NewExtendedError("Server is shutting down.", nil))
			return
		}
		h.workWG.Add(1)
		h.mu.Unlock()
		defer h.workWG.Done()
		defer func() {
			if v := recover(); v != nil {
				next(sio.NewExtendedError(RecoverError(v).Message, nil))
			}
		}()
		handshake := s.Handshake()
		auth := Obj(handshake.Auth)
		raw := Str(auth, "token")
		if raw == "" {
			req := &http.Request{Header: handshake.Headers.Header()}
			if c, e := req.Cookie("dorham_session"); e == nil {
				raw = c.Value
			}
		}
		u, session := h.a.resolveSession(raw)
		Check(u != nil && !Bool(u, "must_change_password"), 401, "UNAUTHENTICATED", "Please sign in and replace any temporary password.")
		if Str(auth, "token") == "" {
			Check(Equal(Str(auth, "csrf"), Str(session, "csrf")), 403, "CSRF", "Invalid session proof.")
		}
		uid := Str(u, "id")
		Check(h.Online(uid) || len(h.Users()) < h.a.C.MaxOnline, 409, "CAPACITY", "This instance is at its online capacity.")
		s.SetData(&peer{socket: s, id: string(s.Id()), uid: uid, session: Str(session, "id"), windowStart: Now()})
		next(nil)
	})
	h.server.On("connection", func(args ...any) {
		s := args[0].(*sio.Socket)
		p, ok := s.Data().(*peer)
		if !ok {
			s.Disconnect(true)
			return
		}
		h.mu.Lock()
		if h.closed {
			h.mu.Unlock()
			s.Disconnect(true)
			return
		}
		h.peers[p.id] = p
		h.workWG.Add(1)
		h.mu.Unlock()
		defer h.workWG.Done()
		if len(h.Users()) > h.a.C.MaxOnline {
			s.Emit("capacity", M{"message": "Online capacity reached."})
			s.Disconnect(true)
			return
		}
		h.emit("presence", M{"userId": p.uid, "online": true})
		h.safe(func() { h.a.Games.Presence(p.uid, true) })
		h.handlers(p)
		s.On("disconnect", func(reason ...any) {
			label := "unknown"
			if len(reason) > 0 {
				label = S(reason[0])
			}
			h.recordDisconnect(label)
			h.disconnected(p)
		})
		go h.probe(p)
	})
	h.a.Route("GET", "/api/v1/presence", true, func(r *Request) any { return M{"online": h.Users(), "latencies": h.latencies()} })
	h.loopWG.Add(1)
	go h.latencyLoop()
}
func (h *Hub) snapshot() []*peer {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]*peer, 0, len(h.peers))
	for _, p := range h.peers {
		out = append(out, p)
	}
	return out
}
func (h *Hub) Users() []string {
	out := []string{}
	seen := map[string]bool{}
	for _, p := range h.snapshot() {
		if !seen[p.uid] {
			seen[p.uid] = true
			out = append(out, p.uid)
		}
	}
	return out
}
func (h *Hub) Online(uid string) bool {
	for _, p := range h.snapshot() {
		if p.uid == uid {
			return true
		}
	}
	return false
}
func (h *Hub) Viewers() []M {
	out := []M{}
	for _, p := range h.snapshot() {
		p.mu.Lock()
		out = append(out, M{"socketId": p.id, "userId": p.uid, "sessionId": p.session, "channelId": p.voiceChannel, "voiceChannel": p.voiceChannel, "gameWatching": p.gameWatching})
		p.mu.Unlock()
	}
	return out
}
func (h *Hub) SessionForSocket(id string) string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if p := h.peers[id]; p != nil {
		return p.session
	}
	return ""
}
func (h *Hub) EmitSocket(id, event string, payload any) {
	h.mu.RLock()
	p := h.peers[id]
	h.mu.RUnlock()
	if p != nil {
		_ = p.socket.Emit(event, payload)
	}
}
func (h *Hub) EmitUser(uid, event string, payload any) {
	for _, p := range h.snapshot() {
		if p.uid == uid {
			_ = p.socket.Emit(event, payload)
		}
	}
}
func (h *Hub) emit(event string, payload any) {
	for _, p := range h.snapshot() {
		_ = p.socket.Emit(event, payload)
	}
}
func (h *Hub) valid(p *peer) {
	s := h.a.DB.One("SELECT s.id FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.id=? AND s.expires_at>=? AND s.access_expires>=? AND u.banned=0 AND u.must_change_password=0", p.session, Now(), Now())
	if s == nil {
		p.socket.Disconnect(true)
		Fail(401, "UNAUTHENTICATED", "Session expired.")
	}
}
func (h *Hub) DisconnectInvalid() {
	for _, p := range h.snapshot() {
		func() { defer func() { _ = recover() }(); h.valid(p) }()
	}
}
func (h *Hub) DisconnectSession(id string) {
	for _, p := range h.snapshot() {
		if p.session == id {
			p.socket.Disconnect(true)
		}
	}
}
func (h *Hub) safe(fn func()) {
	defer func() {
		if v := recover(); v != nil {
			log.Printf("realtime cleanup failed: %T", v)
		}
	}()
	fn()
}
func (h *Hub) disconnected(p *peer) {
	h.mu.Lock()
	delete(h.peers, p.id)
	closing := h.closed
	if !closing {
		h.workWG.Add(1)
	}
	h.mu.Unlock()
	if closing {
		return
	}
	defer h.workWG.Done()
	h.safe(func() {
		if h.a.DB.One("SELECT channel_id FROM voice_members WHERE socket_id=?", p.id) != nil {
			h.a.Service.VoiceAction(p.uid, p.id, "leave")
		}
		if !h.Online(p.uid) {
			h.emit("presence", M{"userId": p.uid, "online": false})
			h.a.Games.Presence(p.uid, false)
		}
		h.a.Games.ReconcileVoice()
	})
}
func (h *Hub) Close() {
	h.mu.Lock()
	h.closed = true
	h.mu.Unlock()
	h.workWG.Wait()
	h.loopWG.Wait()
	done := make(chan struct{})
	h.server.Close(func(error) { close(done) })
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
	h.mu.Lock()
	h.peers = map[string]*peer{}
	h.mu.Unlock()
}
func (h *Hub) Notify(kind string, payload any) {
	b := Obj(payload)
	switch kind {
	case "conversation:event":
		audience := h.a.Service.ConversationAudience(h.Viewers(), Str(b, "conversationId"))
		for _, id := range audience {
			h.EmitSocket(id, kind, payload)
		}
	case "voice:move":
		id := Str(b, "socketId")
		h.mu.RLock()
		p := h.peers[id]
		h.mu.RUnlock()
		if p != nil {
			p.mu.Lock()
			p.voiceChannel = ""
			p.mu.Unlock()
			h.EmitSocket(id, "voice:move", M{"channelId": b["channelId"]})
		}
	case "voice:changed", "voice:state:changed":
		h.refreshVoice()
		if kind == "voice:changed" {
			h.a.Games.ReconcileVoice()
			h.a.Media.Synchronize()
		}
	default:
		h.emit(kind, payload)
	}
}
func (h *Hub) refreshVoice() {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	h.workWG.Add(1)
	h.mu.Unlock()
	defer h.workWG.Done()
	h.voiceRefresh.run(h.refreshVoicePass)
}
func (h *Hub) refreshVoicePass() {
	updates := h.a.Service.VoiceSnapshot(h.Viewers())
	for _, update := range updates {
		id := Str(update, "socketId")
		h.mu.RLock()
		p := h.peers[id]
		h.mu.RUnlock()
		if p == nil {
			continue
		}
		directoryKey := JSON(update["directory"])
		p.mu.Lock()
		sendDirectory := p.directoryKey != directoryKey
		p.directoryKey = directoryKey
		p.mu.Unlock()
		if sendDirectory {
			h.EmitSocket(id, "voice:directory", update["directory"])
		}
		room, exists := update["room"]
		if !exists {
			continue
		}
		if room == nil {
			p.mu.Lock()
			p.voiceChannel = ""
			p.roomKey = ""
			p.mu.Unlock()
			h.EmitSocket(id, "voice:removed", M{})
			continue
		}
		r := Merge(Obj(room))
		shares := []any{}
		for _, v := range Arr(r["shares"]) {
			x := Merge(Obj(v))
			delete(x, "expiresAt")
			shares = append(shares, x)
		}
		r["shares"] = shares
		key := JSON(r)
		p.mu.Lock()
		changed := p.roomKey != key
		p.roomKey = key
		p.mu.Unlock()
		if changed {
			h.EmitSocket(id, "voice:room", room)
		}
	}
}
func (h *Hub) handle(p *peer, event string, fn func(M) any) {
	p.socket.On(event, func(args ...any) {
		if len(args) < 2 {
			return
		}
		ack, ok := args[len(args)-1].(sio.Ack)
		if !ok {
			return
		}
		h.mu.Lock()
		if h.closed {
			h.mu.Unlock()
			return
		}
		h.workWG.Add(1)
		h.mu.Unlock()
		defer h.workWG.Done()
		started := time.Now()
		failed := true
		defer func() { h.recordAction(event, time.Since(started), failed) }()
		p.eventMu.Lock()
		defer p.eventMu.Unlock()
		defer func() {
			if v := recover(); v != nil {
				e := RecoverError(v)
				if e.Status == 500 {
					e.Code = "INVALID_REQUEST"
					e.Message = "Real-time action failed."
				}
				ack([]any{M{"ok": false, "error": M{"code": e.Code, "message": e.Message}}}, nil)
			}
		}()
		b, is := args[0].(map[string]any)
		Check(is, 400, "VALIDATION", "Invalid real-time payload.")
		if Now()-p.windowStart > 10000 {
			p.windowStart = Now()
			p.eventCount = 0
		}
		p.eventCount++
		Check(p.eventCount <= 400, 429, "RATE_LIMIT", "Too many real-time actions.")
		h.valid(p)
		result := fn(b)
		failed = false
		ack([]any{M{"ok": true, "data": result}}, nil)
	})
}
func (h *Hub) handlers(p *peer) {
	s := h.a.Service
	h.handle(p, "message:send", func(raw M) any {
		b := CoreMessageBody(raw)
		return s.Send(p.uid, Str(b, "requestId"), Str(b, "conversationId"), Str(b, "content"), coreMessageReply(b), Strings(b["attachmentIds"]), Bool(b, "tts"))
	})
	h.handle(p, "game:watch", func(b M) any {
		id := VString(b, "id", 1, 80, false)
		view := h.a.Games.View(p.uid, id)
		p.mu.Lock()
		p.gameWatching = id
		p.mu.Unlock()
		return view
	})
	h.handle(p, "game:unwatch", func(b M) any {
		id := VString(b, "id", 1, 80, false)
		p.mu.Lock()
		if p.gameWatching == id {
			p.gameWatching = ""
		}
		p.mu.Unlock()
		return M{}
	})
	h.handle(p, "typing", func(b M) any {
		id := VString(b, "conversationId", 1, 80, false)
		active := VBool(b, "active")
		viewers := []M{}
		for _, v := range h.Viewers() {
			if Str(v, "socketId") != p.id {
				viewers = append(viewers, v)
			}
		}
		audience := s.ConversationAudience(viewers, id, p.uid)
		for _, sid := range audience {
			h.EmitSocket(sid, "typing", M{"conversationId": id, "active": active, "userId": p.uid})
		}
		return M{}
	})
	h.handle(p, "voice:join", func(b M) any {
		channel := VString(b, "channelId", 1, 80, false)
		eligible := VBool(b, "eligible")
		result := s.JoinVoice(p.uid, p.id, channel, eligible)
		if !p.socket.Connected() {
			s.VoiceAction(p.uid, p.id, "leave")
			Fail(401, "UNAUTHENTICATED", "Voice connection closed.")
		}
		p.mu.Lock()
		p.voiceChannel = channel
		p.mu.Unlock()
		return result
	})
	h.handle(p, "voice:leave", func(b M) any {
		RID(b)
		result := s.VoiceAction(p.uid, p.id, "leave")
		p.mu.Lock()
		p.voiceChannel = ""
		p.mu.Unlock()
		return result
	})
	h.handle(p, "voice:heartbeat", func(raw M) any {
		b := M{}
		if _, ok := raw["eligible"]; ok {
			b["eligible"] = VBool(raw, "eligible")
		}
		result := s.VoiceAction(p.uid, p.id, "heartbeat", b)
		if room, ok := result["room"]; ok {
			h.EmitSocket(p.id, "voice:room", room)
		}
		return result
	})
	h.handle(p, "voice:state", func(b M) any {
		RID(b)
		VBool(b, "muted")
		VBool(b, "deafened")
		return s.VoiceAction(p.uid, p.id, "state", M{"muted": b["muted"], "deafened": b["deafened"]})
	})
	h.handle(p, "share:start", func(b M) any {
		_, numeric := b["protocolVersion"].(float64)
		Check(numeric && Num(b, "protocolVersion") == 2, 428, "UPGRADE_REQUIRED", "Update Dorham to 0.5.0 before sharing your screen.")
		Strict(b, "requestId", "protocolVersion", "includeAudio")
		rid := RID(b)
		audio := VBool(b, "includeAudio", true)
		return s.Share(p.uid, p.id, rid, false, audio)
	})
	h.handle(p, "share:stop", func(b M) any { return s.Share(p.uid, p.id, RID(b), true, false) })
	h.handle(p, "share:update", func(b M) any {
		Strict(b, "requestId", "leaseId", "expectedRevision", "frameRate", "includeAudio")
		rid := RID(b)
		VString(b, "leaseId", 1, 80, false)
		VInt(b, "expectedRevision", 1, 9007199254740991)
		if _, ok := b["frameRate"]; ok {
			rate := VInt(b, "frameRate", 15, 30)
			Check(rate == 15 || rate == 30, 400, "VALIDATION", "Invalid frame rate")
		}
		if _, ok := b["includeAudio"]; ok {
			Check(!VBool(b, "includeAudio"), 400, "VALIDATION", "Audio may only be disabled")
		}
		return s.UpdateShare(p.uid, p.id, rid, b)
	})
	h.handle(p, "voice:sfu", func(b M) any { return h.a.Media.Credentials(p.uid, p.id, VString(b, "channelId", 1, 80, false)) })
	h.handle(p, "voice:signal", func(b M) any { return h.signal(p, b) })
}
func (h *Hub) signal(p *peer, raw M) any {
	b := Clone(raw)
	channel := VString(b, "channelId", 1, 80, false)
	to := VString(b, "to", 1, 80, false)
	epoch := VString(b, "epoch", 1, 80, false)
	if value, ok := b["description"]; ok {
		d, yes := value.(map[string]any)
		Check(yes, 400, "VALIDATION", "Invalid description")
		VEnum(d, "type", []string{"offer", "answer", "pranswer", "rollback"})
		VString(d, "sdp", 0, 100000, false, true)
		b["description"] = corePick(d, "type", "sdp")
	}
	if value, ok := b["candidate"]; ok && value != nil {
		c, yes := value.(map[string]any)
		Check(yes, 400, "VALIDATION", "Invalid candidate")
		VString(c, "candidate", 0, 4096, false, true)
		for _, k := range []string{"sdpMid", "usernameFragment"} {
			if v, ok := c[k]; ok && v != nil {
				VString(c, k, 0, 128*1024, false)
			}
		}
		if v, ok := c["sdpMLineIndex"]; ok && v != nil {
			VInt(c, "sdpMLineIndex", -2147483648, 2147483647)
		}
		b["candidate"] = corePick(c, "candidate", "sdpMid", "sdpMLineIndex", "usernameFragment")
	}
	if value, ok := b["streams"]; ok {
		_, yes := value.([]any)
		Check(yes && len(Arr(value)) <= 3, 400, "VALIDATION", "Invalid streams")
		streams := []any{}
		for _, x := range Arr(value) {
			stream, yes := x.(map[string]any)
			Check(yes, 400, "VALIDATION", "Invalid stream")
			VString(stream, "streamId", 1, 80, false)
			VEnum(stream, "kind", []string{"audio", "screen"})
			VString(stream, "leaseId", 1, 80, false, true)
			streams = append(streams, corePick(stream, "streamId", "kind", "leaseId"))
		}
		b["streams"] = streams
	}
	if value, ok := b["subscription"]; ok {
		sub, yes := value.(map[string]any)
		Check(yes, 400, "VALIDATION", "Invalid subscription")
		VString(sub, "leaseId", 1, 80, false)
		VBool(sub, "enabled")
		b["subscription"] = corePick(sub, "leaseId", "enabled")
	}
	b = corePick(b, "channelId", "to", "epoch", "description", "candidate", "streams", "subscription")
	sender := h.a.DB.One("SELECT * FROM voice_members WHERE user_id=? AND socket_id=? AND channel_id=? AND epoch=?", p.uid, p.id, channel, epoch)
	Check(sender != nil, 403, "STALE_EPOCH", "Voice session is no longer current.")
	h.a.Service.Channel(h.a.DB, p.uid, channel)
	target := h.a.DB.One("SELECT * FROM voice_members WHERE user_id=? AND channel_id=?", to, channel)
	Check(target != nil, 404, "PEER_LEFT", "Peer left the room.")
	h.a.Service.Channel(h.a.DB, to, channel)
	for _, stream := range Arr(b["streams"]) {
		v := Obj(stream)
		if Str(v, "kind") == "screen" {
			Check(h.a.DB.One("SELECT id FROM share_leases WHERE id=? AND user_id=? AND channel_id=? AND expires_at>=?", v["leaseId"], p.uid, channel, Now()) != nil, 403, "SHARE_EXPIRED", "Screen-share authorization expired.")
		}
	}
	b["from"] = p.uid
	h.EmitSocket(Str(target, "socket_id"), "voice:signal", b)
	return M{}
}
func (h *Hub) probe(p *peer) {
	p.mu.Lock()
	if p.probing {
		p.mu.Unlock()
		return
	}
	p.probing = true
	p.mu.Unlock()
	start := time.Now()
	p.socket.Timeout(5*time.Second).EmitWithAck("connection:probe", M{"version": 1})(func(args []any, e error) {
		p.mu.Lock()
		p.probing = false
		if e != nil || len(args) == 0 || Num(Obj(args[0]), "version") != 1 {
			p.latency = nil
		} else {
			milliseconds := time.Since(start).Milliseconds()
			if milliseconds >= 0 && milliseconds <= 5000 {
				p.latency = M{"userId": p.uid, "milliseconds": milliseconds, "measuredAt": Now()}
			}
		}
		p.mu.Unlock()
		h.EmitSocket(p.id, "connection:latencies", h.latencies())
	})
}
func (h *Hub) latencies() []M {
	users := map[string]M{}
	for _, p := range h.snapshot() {
		if users[p.uid] == nil {
			users[p.uid] = M{"userId": p.uid, "milliseconds": nil, "measuredAt": nil}
		}
		p.mu.Lock()
		sample := Clone(p.latency)
		p.mu.Unlock()
		if sample == nil || Num(sample, "measuredAt") < Now()-45000 {
			continue
		}
		previous := users[p.uid]
		if previous["milliseconds"] == nil || Num(sample, "milliseconds") < Num(previous, "milliseconds") {
			users[p.uid] = sample
		}
	}
	out := []M{}
	for _, v := range users {
		out = append(out, v)
	}
	return out
}
func (h *Hub) latencyLoop() {
	defer h.loopWG.Done()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-h.a.stop:
			return
		case <-ticker.C:
			h.DisconnectInvalid()
			for _, p := range h.snapshot() {
				go h.probe(p)
			}
			h.emit("connection:latencies", h.latencies())
		}
	}
}

var _ = fmt.Sprint
