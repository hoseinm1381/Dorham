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
	"runtime"
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
	AcceptedAt      int64
}
type mediaSpeech struct {
	m              *Media
	mu             sync.Mutex
	seen, cooldown map[string]int64
	audio          map[string]mediaClip
	order          []string
	audioBytes     int64
	reuse          map[[32]byte]mediaSpeechReuse
	reuseBytes     int64
	cacheHits      int
	queued         int
	plusPending    int
	started        int64
	closed         bool
	jobs           chan mediaSpeechJob
	plusJobs       chan mediaSpeechJob
	plusDone       chan struct{}
	plusStats      speechPlusStats
	done           chan struct{}
	stop           chan struct{}
	worker         *mediaSpeechWorker
	engine         func(string, func()) ([]byte, error)
	progressEngine func(string, func(), func(int)) ([]byte, error)
}

func newMediaSpeech(m *Media) *mediaSpeech {
	s := &mediaSpeech{m: m, seen: map[string]int64{}, cooldown: map[string]int64{}, audio: map[string]mediaClip{}, reuse: map[[32]byte]mediaSpeechReuse{}, started: Now(), jobs: make(chan mediaSpeechJob, 4), done: make(chan struct{}), stop: make(chan struct{}), worker: &mediaSpeechWorker{keepWarm: m.a.C.TTSKeepWarm, idle: int64(m.a.C.TTSIdleSeconds) * 1000, lastUsed: Now(), cpuPercent: m.a.C.TTSCPUPercent, timeout: time.Duration(m.a.C.TTSTimeoutSeconds) * time.Second}}
	s.plusJobs = make(chan mediaSpeechJob, 1)
	s.plusDone = make(chan struct{})
	go func() {
		defer close(s.plusDone)
		for job := range s.plusJobs {
			s.runPlus(job)
			s.mu.Lock()
			s.plusPending--
			s.mu.Unlock()
		}
	}()
	go s.loop()
	return s
}
func (m *Media) SetSpeechSynthesizer(engine func(string, func()) ([]byte, error)) {
	m.speech.mu.Lock()
	m.speech.engine = engine
	m.speech.mu.Unlock()
}
func (m *Media) SetSpeechProgressSynthesizer(engine func(string, func(), func(int)) ([]byte, error)) {
	m.speech.mu.Lock()
	m.speech.progressEngine = engine
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
	for key, item := range s.reuse {
		if item.expires <= now {
			s.removeReuse(key)
		}
	}
	s.mu.Unlock()
	s.worker.cleanup()
	if s.worker.underPressure() {
		s.mu.Lock()
		s.reuse = map[[32]byte]mediaSpeechReuse{}
		s.reuseBytes = 0
		s.mu.Unlock()
	}
}
func (s *mediaSpeech) metrics() M {
	s.mu.Lock()
	v := M{"queued": s.queued, "cachedClips": len(s.audio), "cachedAudioBytes": s.audioBytes, "reusableClips": len(s.reuse), "reusableAudioBytes": s.reuseBytes, "synthesisCacheHits": s.cacheHits, "audioBudgetBytes": int64(s.m.a.C.TTSAudioCacheMiB) * mediaMiB, "dedupEntries": len(s.seen), "cooldownEntries": len(s.cooldown)}
	s.mu.Unlock()
	v["worker"] = s.worker.metrics()
	v["plus"] = M{"requests": s.plusStats.requests.Load(), "errors": s.plusStats.errors.Load(), "fallbacks": s.plusStats.fallbacks.Load(), "queued": len(s.plusJobs)}
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
	sender := db.One("SELECT v.*,u.speech_plus FROM voice_members v JOIN users u ON u.id=v.user_id WHERE v.user_id=? AND v.heartbeat>?", uid, now-30000)
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
	limited := len(utf16.Encode([]rune(Str(msg, "content")))) > 400 || now-s.cooldown[uid] < 4000
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
	if now-s.cooldown[uid] < 4000 {
		s.mu.Unlock()
		s.notice(uid, "TTS is limited to 400 characters and one request every 4 seconds. Your message was sent normally.")
		return
	}
	s.cooldown[uid] = now
	job := mediaSpeechJob{uid, Clone(msg), sender, initial, now}
	plusSelected := Bool(sender, "speech_plus")
	if plusSelected {
		select {
		case s.plusJobs <- job:
			s.plusPending++
			s.mu.Unlock()
			return
		default:
			s.plusStats.fallbacks.Add(1)
		}
	}
	if s.queued >= 4 {
		s.mu.Unlock()
		s.notice(uid, "TTS is busy. Your message was sent normally.")
		return
	}
	s.queued++
	s.mu.Unlock()
	s.progress(job, 0, "queued")
	s.mu.Lock()
	if s.closed {
		s.queued--
		s.mu.Unlock()
		return
	}
	s.jobs <- job
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
func nextSpeechRecycle(now time.Time) time.Time {
	year, month, day := now.UTC().Date()
	slot := time.Date(year, month, day, 1, 30, 0, 0, time.UTC) // 05:00 Tehran
	if !slot.After(now) {
		slot = slot.AddDate(0, 0, 1)
	}
	return slot
}

func (s *mediaSpeech) recycleIdleWorker(before time.Time) bool {
	// Serialize the occupancy check and retirement with voice joins. Model
	// loading runs separately in the existing prewarm loop after the lock is released.
	return s.m.a.DB.Tx(func(tx *DB) any {
		if tx.One("SELECT 1 FROM voice_members LIMIT 1") != nil || (s.m.a.Hub != nil && s.m.a.Hub.directCallActive("")) {
			return false
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.closed || s.queued != 0 || s.plusPending != 0 {
			return false
		}
		w := s.worker
		w.mu.Lock()
		defer w.mu.Unlock()
		if !w.keepWarm || w.closed || w.busy || w.cmd == nil || !time.Now().Before(before) {
			return false
		}
		w.retireLocked()
		return true
	}).(bool)
}

func (s *mediaSpeech) loop() {
	defer close(s.done)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case job, ok := <-s.jobs:
			if !ok {
				return
			}
			s.run(job)
			s.mu.Lock()
			s.queued--
			s.mu.Unlock()
		case <-ticker.C:
			s.mu.Lock()
			warm := !s.closed && s.queued == 0 && s.engine == nil && s.progressEngine == nil
			s.mu.Unlock()
			if warm {
				s.worker.prewarm()
			}
		}
	}
}
func (s *mediaSpeech) run(job mediaSpeechJob) {
	defer func() { s.progress(job, 100, "finished") }()
	defer func() {
		if recover() != nil {
			s.mu.Lock()
			closed := s.closed
			s.mu.Unlock()
			if !closed {
				if s.worker.underPressure() {
					s.notice(job.UID, speechMemoryNotice)
				} else {
					s.notice(job.UID, "TTS is unavailable. Your message was sent normally.")
				}
			}
		}
	}()
	s.mu.Lock()
	closed, engine, progressEngine := s.closed, s.engine, s.progressEngine
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
	if len(s.audience(job)) == 0 {
		return
	}
	text := Str(job.Message, "content")
	s.progress(job, 0, "preparing")
	chunks := s.reused(text)
	if len(chunks) == 1 {
		if !s.waitFirst(job) {
			return
		}
		s.publish(job, chunks[0], 0, 1)
		return
	}
	last := -1
	progress := func(percent int) {
		if percent > last && percent >= 0 && percent < 100 {
			last = percent
			s.progress(job, percent, "synthesizing")
		}
	}
	var data []byte
	var err error
	if progressEngine != nil {
		data, err = progressEngine(text, cold, progress)
	} else if engine != nil {
		data, err = engine(text, cold)
	} else {
		data, err = s.worker.synthesizeProgress(text, cold, progress)
	}
	if err != nil {
		panic(err)
	}
	if !s.waitFirst(job) {
		return
	}
	// Publish one complete WAV. Piper's natural sentence/language boundaries stay
	// intact; no first-half playback or arbitrary midpoint synthesis is used.
	s.publish(job, data, 0, 1)
	s.remember(text, [][]byte{data})
}

func (s *mediaSpeech) progress(job mediaSpeechJob, percent int, phase string) {
	for _, member := range s.audience(job) {
		s.m.emitSocket(Str(member, "socket_id"), "voice:tts-progress", M{"id": job.Message["id"], "messageId": job.Message["id"], "channelId": job.Sender["channel_id"], "userId": job.UID, "percent": percent, "phase": phase, "expiresAt": Now() + 600000})
	}
}

func (s *mediaSpeech) waitFirst(job mediaSpeechJob) bool {
	delay := time.Duration(job.AcceptedAt+3000-Now()) * time.Millisecond
	if delay <= 0 {
		return true
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-s.stop:
		return false
	}
}

func (s *mediaSpeech) publish(job mediaSpeechJob, data []byte, index, count int) {
	members := s.audience(job)
	if len(members) == 0 {
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
	for s.audioBytes+s.reuseBytes+int64(len(data)) > budget && len(s.reuse) > 0 {
		s.evictReuse()
	}
	for len(s.audio) >= 16 || s.audioBytes+s.reuseBytes+int64(len(data)) > budget {
		if len(s.order) == 0 {
			s.mu.Unlock()
			return
		}
		s.remove(s.order[0])
	}
	id := Str(job.Message, "id")
	if index > 0 {
		id += "-tts-" + S(index)
	}
	s.audio[id] = mediaClip{data, Str(job.Sender, "channel_id"), recipients, expires}
	s.order = append(s.order, id)
	s.audioBytes += int64(len(data))
	s.mu.Unlock()
	for _, member := range members {
		s.m.emitSocket(Str(member, "socket_id"), "voice:tts", M{"id": id, "messageId": job.Message["id"], "chunkIndex": index, "chunkCount": count, "channelId": job.Sender["channel_id"], "userId": job.UID, "expiresAt": expires})
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
	close(s.stop)
	s.audio = map[string]mediaClip{}
	s.order = nil
	s.audioBytes = 0
	s.reuse = map[[32]byte]mediaSpeechReuse{}
	s.reuseBytes = 0
	s.seen = map[string]int64{}
	s.cooldown = map[string]int64{}
	custom := s.engine != nil || s.progressEngine != nil
	close(s.jobs)
	close(s.plusJobs)
	s.mu.Unlock()
	s.worker.close()
	<-s.plusDone
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
	data  []byte
	err   error
	ready bool
}
type mediaSpeechWorker struct {
	mu                        sync.Mutex
	cmd                       *exec.Cmd
	input                     io.WriteCloser
	replies                   chan mediaWorkerReply
	updates                   chan int
	exited                    chan struct{}
	closed, busy              bool
	lastUsed, idle            int64
	starts, idleStops         int
	start                     func() *exec.Cmd
	cpuPercent                int
	timeout                   time.Duration
	isolation                 *speechCPUGroup
	keepWarm, ready, pressure bool
	memoryStops               int
	nextWarm                  int64
	memory                    func() (int64, int64, bool)
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
		in.Close()
		return e
	}
	cmd.Stderr = io.Discard
	group, release, e := prepareSpeechCPU(cmd, w.cpuPercent)
	if e != nil {
		in.Close()
		out.Close()
		return e
	}
	defer release()
	if e = cmd.Start(); e != nil {
		in.Close()
		out.Close()
		if group != nil {
			group.kill()
		}
		return e
	}
	replies := make(chan mediaWorkerReply, 1)
	updates := make(chan int, 1)
	exited := make(chan struct{})
	w.cmd = cmd
	w.input = in
	w.replies = replies
	w.updates = updates
	w.exited = exited
	w.starts++
	w.ready = false
	w.isolation = group
	go func() {
		defer close(exited)
		scanner := bufio.NewScanner(out)
		scanner.Buffer(make([]byte, 4096), 4001000)
		for scanner.Scan() {
			var response struct {
				Audio    string `json:"audio"`
				Ready    bool   `json:"ready"`
				Progress *int   `json:"progress"`
			}
			data := scanner.Bytes()
			var err error
			var audio []byte
			decoded := json.Unmarshal(data, &response)
			if decoded == nil && response.Progress != nil && *response.Progress >= 0 && *response.Progress < 100 && response.Audio == "" && !response.Ready {
				// Progress has its own bounded latest-value slot. It must never
				// occupy or displace the terminal audio/error response.
				select {
				case updates <- *response.Progress:
				default:
					select {
					case <-updates:
					default:
					}
					select {
					case updates <- *response.Progress:
					default:
					}
				}
				continue
			}
			if decoded != nil || len(response.Audio) > 4000000 || (response.Audio == "" && !response.Ready) {
				err = errors.New("invalid speech response")
			} else if !response.Ready {
				audio, err = base64.StdEncoding.DecodeString(response.Audio)
				if len(audio) > 3000000 || !bytes.HasPrefix(audio, []byte("RIFF")) {
					err = errors.New("invalid speech audio")
				}
			}
			select {
			case replies <- mediaWorkerReply{data: audio, err: err, ready: response.Ready}:
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
	return w.request(M{"text": text}, cold)
}
func (w *mediaSpeechWorker) synthesizeProgress(text string, cold func(), progress func(int)) ([]byte, error) {
	return w.request(M{"text": text, "progress": true}, cold, progress)
}
func (w *mediaSpeechWorker) request(request M, cold func(), callbacks ...func(int)) ([]byte, error) {
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
	if w.keepWarm && !w.memorySafeLocked(wasCold) {
		w.pressure = true
		w.retireLocked()
		w.mu.Unlock()
		return nil, errors.New("speech memory pressure")
	}
	if wasCold {
		if e := w.launch(); e != nil {
			w.mu.Unlock()
			return nil, e
		}
	}
	w.pressure = false
	w.busy = true
	w.lastUsed = Now()
	input, replies, updates, exit := w.input, w.replies, w.updates, w.exited
	select {
	case <-updates:
	default:
	}
	w.mu.Unlock()
	defer func() { w.mu.Lock(); w.busy = false; w.lastUsed = Now(); w.mu.Unlock() }()
	if wasCold && cold != nil {
		cold()
	}
	_, e := io.WriteString(input, JSON(request)+"\n")
	if e != nil {
		w.mu.Lock()
		w.retireLocked()
		w.mu.Unlock()
		return nil, e
	}
	deadline := w.timeout
	if deadline <= 0 {
		deadline = 60 * time.Second
	}
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	for {
		select {
		case percent := <-updates:
			if len(callbacks) > 0 && callbacks[0] != nil {
				callbacks[0](percent)
			}
		case reply := <-replies:
			if reply.err == nil && reply.ready != Bool(request, "warmup") {
				return nil, errors.New("unexpected speech response")
			}
			if Bool(request, "warmup") && reply.err == nil {
				w.mu.Lock()
				w.ready = w.cmd != nil
				w.mu.Unlock()
			}
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
}
func (w *mediaSpeechWorker) retireLocked() {
	if w.cmd == nil {
		return
	}
	w.input.Close()
	if w.isolation != nil {
		w.isolation.kill()
	}
	w.cmd.Process.Kill()
	select {
	case <-w.exited:
	case <-time.After(2 * time.Second):
	}
	w.cmd = nil
	w.ready = false
	w.input = nil
	w.replies = nil
	w.updates = nil
	w.exited = nil
}
func (w *mediaSpeechWorker) cleanup() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.cmd != nil {
		select {
		case <-w.exited:
			w.retireLocked()
			w.nextWarm = Now() + 30000
		default:
		}
	}
	if !w.closed && w.keepWarm && !w.memorySafeLocked(false) {
		w.pressure = true
		if w.cmd != nil {
			w.memoryStops++
			w.retireLocked()
		}
	}
	if !w.closed && !w.keepWarm && w.cmd != nil && !w.busy && Now()-w.lastUsed >= w.idle {
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
	cpu := M{"enabled": w.cpuPercent > 0, "percentOfHost": w.cpuPercent}
	if w.isolation != nil {
		cpu = w.isolation.metrics()
	}
	return M{"running": w.cmd != nil, "stopping": false, "pid": pid, "busy": w.busy, "starts": w.starts, "idleStops": w.idleStops, "idleSeconds": w.idle / 1000, "keepWarm": w.keepWarm, "modelsReady": w.ready, "memoryPressure": w.pressure, "memoryStops": w.memoryStops, "timeoutSeconds": int64(w.timeout / time.Second), "cpu": cpu}
}

const speechMemoryNotice = "TTS was unloaded to free server memory. Speech will resume when enough memory is available. Your text message was sent normally."

// The restart reserve includes room for both models, avoiding reload/evict loops.
func (w *mediaSpeechWorker) memorySafeLocked(launch bool) bool {
	read := w.memory
	if read == nil {
		read = cacheMemoryHeadroom
	}
	host, service, ok := read()
	if !ok {
		return runtime.GOOS != "linux"
	}
	reserve := int64(0)
	if launch || w.pressure {
		reserve = 448 * mediaMiB
	}
	return host >= 384*mediaMiB+reserve && service >= 192*mediaMiB+reserve
}
func (w *mediaSpeechWorker) underPressure() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.pressure
}
func (w *mediaSpeechWorker) prewarm() {
	w.mu.Lock()
	if !w.keepWarm || w.closed || w.busy || w.ready || Now() < w.nextWarm || !w.memorySafeLocked(w.cmd == nil) {
		w.mu.Unlock()
		return
	}
	w.nextWarm = Now() + 60000
	w.mu.Unlock()
	_, err := w.request(M{"warmup": true}, nil)
	if err == nil {
		w.mu.Lock()
		w.pressure = false
		w.nextWarm = 0
		w.mu.Unlock()
	}
}
func (w *mediaSpeechWorker) close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	w.retireLocked()
}
