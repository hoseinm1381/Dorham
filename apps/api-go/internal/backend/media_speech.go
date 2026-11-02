package backend

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
)

type mediaClip struct {
	Data       []byte
	Channel    string
	Recipients map[string]string
	Expires    int64
}
type mediaSpeechJob struct {
	UID             string
	Message, Sender M
	Initial         []M
}
type mediaSpeech struct {
	m              *Media
	mu             sync.Mutex
	seen, cooldown map[string]int64
	audio          map[string]mediaClip
	order          []string
	audioBytes     int64
	queued         int
	started        int64
	closed         bool
	jobs           chan mediaSpeechJob
	done           chan struct{}
	worker         *mediaSpeechWorker
	engine         func(string, func()) ([]byte, error)
}

func newMediaSpeech(m *Media) *mediaSpeech {
	s := &mediaSpeech{m: m, seen: map[string]int64{}, cooldown: map[string]int64{}, audio: map[string]mediaClip{}, started: Now(), jobs: make(chan mediaSpeechJob, 4), done: make(chan struct{}), worker: &mediaSpeechWorker{idle: int64(m.a.C.TTSIdleSeconds) * 1000, lastUsed: Now()}}
	go s.loop()
	return s
}
func (m *Media) SetSpeechSynthesizer(engine func(string, func()) ([]byte, error)) {
	m.speech.mu.Lock()
	m.speech.engine = engine
	m.speech.mu.Unlock()
}
func (m *Media) Speech(uid string, msg M) { m.speech.enqueue(uid, msg) }
func (s *mediaSpeech) notice(uid, text string) {
	s.m.a.Hub.EmitUser(uid, "voice:tts-notice", M{"text": text})
}
func (s *mediaSpeech) remove(id string) {
	if clip, ok := s.audio[id]; ok {
		s.audioBytes -= int64(len(clip.Data))
		delete(s.audio, id)
	}
	for i, k := range s.order {
		if k == id {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
}
func (s *mediaSpeech) cleanup() {
	now := Now()
	s.mu.Lock()
	for id, expires := range s.seen {
		if expires <= now {
			delete(s.seen, id)
		}
	}
	for id, clip := range s.audio {
		if clip.Expires <= now {
			s.remove(id)
		}
	}
	for id, at := range s.cooldown {
		if at <= now-60000 {
			delete(s.cooldown, id)
		}
	}
	idle := s.queued == 0
	s.mu.Unlock()
	if idle {
		s.worker.cleanup()
	}
}
func (s *mediaSpeech) metrics() M {
	s.mu.Lock()
	v := M{"queued": s.queued, "cachedClips": len(s.audio), "cachedAudioBytes": s.audioBytes, "audioBudgetBytes": int64(s.m.a.C.TTSAudioCacheMiB) * mediaMiB, "dedupEntries": len(s.seen), "cooldownEntries": len(s.cooldown)}
	s.mu.Unlock()
	v["worker"] = s.worker.metrics()
	return v
}
func (s *mediaSpeech) enqueue(uid string, msg M) {
	s.cleanup()
	now, id := Now(), Str(msg, "id")
	s.mu.Lock()
	if s.closed || s.seen[id] > 0 || Num(msg, "createdAt") < s.started-1000 || now-Num(msg, "createdAt") > 30000 {
		s.mu.Unlock()
		return
	}
	s.seen[id] = now + 60000
	s.mu.Unlock()
	db := s.m.a.DB
	sender := db.One("SELECT * FROM voice_members WHERE user_id=? AND heartbeat>?", uid, now-30000)
	if sender == nil {
		return
	}
	if !mediaSafe(func() {
		Check(!Bool(sender, "server_muted"), 403, "FORBIDDEN", "Server muted.")
		db.Tx(func(tx *DB) any { return s.m.a.Service.Channel(tx, uid, Str(sender, "channel_id"), "speak") })
	}) {
		s.notice(uid, "You cannot use TTS in this voice channel. Your message was sent normally.")
		return
	}
	s.mu.Lock()
	limited := len(utf16.Encode([]rune(Str(msg, "content")))) > 400 || s.queued >= 4 || now-s.cooldown[uid] < 4000
	s.mu.Unlock()
	if limited {
		s.notice(uid, "TTS is limited to 400 characters and one request every 4 seconds. Your message was sent normally.")
		return
	}
	initial := db.All("SELECT user_id,epoch FROM voice_members WHERE channel_id=? AND heartbeat>?", sender["channel_id"], now-30000)
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if s.queued >= 4 {
		s.mu.Unlock()
		s.notice(uid, "TTS is busy. Your message was sent normally.")
		return
	}
	if now-s.cooldown[uid] < 4000 {
		s.mu.Unlock()
		s.notice(uid, "TTS is limited to 400 characters and one request every 4 seconds. Your message was sent normally.")
		return
	}
	s.cooldown[uid] = now
	s.queued++
	s.jobs <- mediaSpeechJob{uid, Clone(msg), sender, initial}
	s.mu.Unlock()
}
func (s *mediaSpeech) audience(job mediaSpeechJob) []M {
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return nil
	}
	db := s.m.a.DB
	current := db.One("SELECT * FROM voice_members WHERE user_id=? AND channel_id=? AND epoch=? AND heartbeat>?", job.UID, job.Sender["channel_id"], job.Sender["epoch"], Now()-30000)
	stored := db.One("SELECT content,deleted FROM messages WHERE id=?", job.Message["id"])
	if current == nil || Bool(current, "server_muted") || stored == nil || Bool(stored, "deleted") || Str(stored, "content") != Str(job.Message, "content") {
		return nil
	}
	if !mediaSafe(func() {
		db.Tx(func(tx *DB) any { return s.m.a.Service.Channel(tx, job.UID, Str(job.Sender, "channel_id"), "speak") })
	}) {
		return nil
	}
	members := db.All("SELECT user_id,epoch,socket_id FROM voice_members WHERE channel_id=? AND deafened=0 AND server_deafened=0 AND heartbeat>?", job.Sender["channel_id"], Now()-30000)
	out := []M{}
	for _, member := range members {
		for _, initial := range job.Initial {
			if initial["user_id"] == member["user_id"] && initial["epoch"] == member["epoch"] {
				out = append(out, member)
				break
			}
		}
	}
	return out
}
func (s *mediaSpeech) loop() {
	defer close(s.done)
	for job := range s.jobs {
		s.run(job)
		s.mu.Lock()
		s.queued--
		s.mu.Unlock()
	}
}
func (s *mediaSpeech) run(job mediaSpeechJob) {
	defer func() {
		if recover() != nil {
			s.mu.Lock()
			closed := s.closed
			s.mu.Unlock()
			if !closed {
				s.notice(job.UID, "TTS is unavailable. Your message was sent normally.")
			}
		}
	}()
	s.mu.Lock()
	closed, engine := s.closed, s.engine
	s.mu.Unlock()
	if closed {
		return
	}
	announced := false
	cold := func() {
		if announced {
			return
		}
		announced = true
		members := s.audience(job)
		for _, member := range members {
			s.m.emitSocket(Str(member, "socket_id"), "voice:tts-loading", M{"id": job.Message["id"], "channelId": job.Sender["channel_id"], "userId": job.UID, "expiresAt": Now() + 15000})
		}
	}
	var data []byte
	var err error
	if engine != nil {
		data, err = engine(Str(job.Message, "content"), cold)
	} else {
		data, err = s.worker.synthesize(Str(job.Message, "content"), cold)
	}
	if err != nil {
		panic(err)
	}
	members := s.audience(job)
	if members == nil {
		return
	}
	recipients := map[string]string{}
	for _, member := range members {
		recipients[Str(member, "user_id")] = Str(member, "epoch")
	}
	budget := int64(s.m.a.C.TTSAudioCacheMiB) * mediaMiB
	if int64(len(data)) > budget || len(data) > 3000000 {
		panic(errors.New("speech audio exceeds memory budget"))
	}
	expires := Now() + 120000
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	for len(s.audio) >= 8 || s.audioBytes+int64(len(data)) > budget {
		if len(s.order) == 0 {
			s.mu.Unlock()
			return
		}
		s.remove(s.order[0])
	}
	id := Str(job.Message, "id")
	s.audio[id] = mediaClip{data, Str(job.Sender, "channel_id"), recipients, expires}
	s.order = append(s.order, id)
	s.audioBytes += int64(len(data))
	s.mu.Unlock()
	for _, member := range members {
		s.m.emitSocket(Str(member, "socket_id"), "voice:tts", M{"id": id, "channelId": job.Sender["channel_id"], "userId": job.UID, "expiresAt": expires})
	}
}
func (s *mediaSpeech) read(uid, id string) []byte {
	s.mu.Lock()
	clip, ok := s.audio[id]
	if ok && clip.Expires <= Now() {
		s.remove(id)
	}
	closed := s.closed
	s.mu.Unlock()
	if closed || !ok || clip.Expires <= Now() || clip.Recipients[uid] == "" {
		return nil
	}
	member := s.m.a.DB.One("SELECT epoch FROM voice_members WHERE user_id=? AND channel_id=? AND deafened=0 AND server_deafened=0 AND heartbeat>?", uid, clip.Channel, Now()-30000)
	if Str(member, "epoch") == clip.Recipients[uid] {
		return clip.Data
	}
	return nil
}
func (s *mediaSpeech) close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.audio = map[string]mediaClip{}
	s.order = nil
	s.audioBytes = 0
	s.seen = map[string]int64{}
	s.cooldown = map[string]int64{}
	custom := s.engine != nil
	close(s.jobs)
	s.mu.Unlock()
	s.worker.close()
	if !custom {
		<-s.done
	}
}
func (m *Media) registerSpeech() {
	m.a.Route("GET", "/api/v1/voice/tts/{id}/audio", true, func(r *Request) any {
		data := m.speech.read(r.UID(), r.Param("id"))
		Check(data != nil, 404, "NOT_FOUND", "Speech audio is unavailable.")
		r.Header("Cache-Control", "private, no-store")
		r.Header("Content-Type", "audio/wav")
		r.Header("Content-Length", S(len(data)))
		r.W.WriteHeader(200)
		r.W.Write(data)
		return nil
	})
}

type mediaWorkerReply struct {
	data []byte
	err  error
}
type mediaSpeechWorker struct {
	mu                sync.Mutex
	cmd               *exec.Cmd
	input             io.WriteCloser
	replies           chan mediaWorkerReply
	exited            chan struct{}
	closed, busy      bool
	lastUsed, idle    int64
	starts, idleStops int
	start             func() *exec.Cmd
}

func (w *mediaSpeechWorker) launch() error {
	var cmd *exec.Cmd
	if w.start != nil {
		cmd = w.start()
	} else {
		python := os.Getenv("DORHAM_TTS_PYTHON")
		if python == "" {
			python = "/opt/dorham-tts/venv/bin/python"
		}
		if _, e := os.Stat(python); e != nil {
			return e
		}
		worker, e := filepath.Abs("deployment/tts-worker.py")
		if e != nil {
			return e
		}
		cmd = exec.Command(python, "-u", worker)
	}
	mediaHideWindow(cmd)
	if cmd.Env == nil {
		cmd.Env = os.Environ()
	}
	cmd.Env = mediaWorkerEnv(cmd.Env)
	in, e := cmd.StdinPipe()
	if e != nil {
		return e
	}
	out, e := cmd.StdoutPipe()
	if e != nil {
		return e
	}
	cmd.Stderr = io.Discard
	if e = cmd.Start(); e != nil {
		return e
	}
	replies := make(chan mediaWorkerReply, 1)
	exited := make(chan struct{})
	w.cmd = cmd
	w.input = in
	w.replies = replies
	w.exited = exited
	w.starts++
	go func() {
		defer close(exited)
		scanner := bufio.NewScanner(out)
		scanner.Buffer(make([]byte, 4096), 4001000)
		for scanner.Scan() {
			var response struct {
				Audio string `json:"audio"`
			}
			data := scanner.Bytes()
			var err error
			var audio []byte
			if json.Unmarshal(data, &response) != nil || len(response.Audio) > 4000000 || response.Audio == "" {
				err = errors.New("invalid speech response")
			} else {
				audio, err = base64.StdEncoding.DecodeString(response.Audio)
				if len(audio) > 3000000 || !bytes.HasPrefix(audio, []byte("RIFF")) {
					err = errors.New("invalid speech audio")
				}
			}
			select {
			case replies <- mediaWorkerReply{audio, err}:
			default:
			}
		}
		select {
		case replies <- mediaWorkerReply{err: errors.New("speech worker exited")}:
		default:
		}
		cmd.Wait()
	}()
	return nil
}
func mediaWorkerEnv(env []string) []string {
	out := []string{}
	for _, value := range env {
		if !strings.HasPrefix(value, "OMP_NUM_THREADS=") && !strings.HasPrefix(value, "OPENBLAS_NUM_THREADS=") {
			out = append(out, value)
		}
	}
	return append(out, "OMP_NUM_THREADS=1", "OPENBLAS_NUM_THREADS=1")
}
func (w *mediaSpeechWorker) synthesize(text string, cold func()) ([]byte, error) {
	w.mu.Lock()
	if w.closed || w.busy {
		w.mu.Unlock()
		return nil, errors.New("speech unavailable")
	}
	if w.cmd != nil {
		select {
		case <-w.exited:
			w.retireLocked()
		default:
		}
	}
	wasCold := w.cmd == nil
	if wasCold {
		if e := w.launch(); e != nil {
			w.mu.Unlock()
			return nil, e
		}
	}
	w.busy = true
	w.lastUsed = Now()
	input, replies, exit := w.input, w.replies, w.exited
	w.mu.Unlock()
	defer func() { w.mu.Lock(); w.busy = false; w.lastUsed = Now(); w.mu.Unlock() }()
	if wasCold && cold != nil {
		cold()
	}
	_, e := io.WriteString(input, JSON(M{"text": text})+"\n")
	if e != nil {
		w.mu.Lock()
		w.retireLocked()
		w.mu.Unlock()
		return nil, e
	}
	timer := time.NewTimer(60 * time.Second)
	defer timer.Stop()
	select {
	case reply := <-replies:
		return reply.data, reply.err
	case <-exit:
		return nil, errors.New("speech exited")
	case <-timer.C:
		w.mu.Lock()
		w.retireLocked()
		w.mu.Unlock()
		return nil, errors.New("speech timeout")
	}
}
func (w *mediaSpeechWorker) retireLocked() {
	if w.cmd == nil {
		return
	}
	w.input.Close()
	w.cmd.Process.Kill()
	select {
	case <-w.exited:
	case <-time.After(2 * time.Second):
	}
	w.cmd = nil
	w.input = nil
	w.replies = nil
	w.exited = nil
}
func (w *mediaSpeechWorker) cleanup() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.closed && w.cmd != nil && !w.busy && Now()-w.lastUsed >= w.idle {
		w.idleStops++
		w.retireLocked()
	}
}
func (w *mediaSpeechWorker) metrics() M {
	w.mu.Lock()
	defer w.mu.Unlock()
	var pid any
	if w.cmd != nil {
		pid = w.cmd.Process.Pid
	}
	return M{"running": w.cmd != nil, "stopping": false, "pid": pid, "busy": w.busy, "starts": w.starts, "idleStops": w.idleStops, "idleSeconds": w.idle / 1000}
}
func (w *mediaSpeechWorker) close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	w.retireLocked()
}
