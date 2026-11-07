package backend

import (
	"crypto/sha256"
	"testing"
	"time"
)

func TestSpeechPersistentWorkerEvictsAndRecoversWithHysteresis(t *testing.T) {
	w := mediaFixtureWorker()
	w.keepWarm = true
	host, service := int64(1200)*mediaMiB, int64(800)*mediaMiB
	w.memory = func() (int64, int64, bool) { return host, service, true }
	defer w.close()
	if _, err := w.synthesize("hello", nil); err != nil {
		t.Fatal(err)
	}
	time.Sleep(3 * time.Millisecond)
	w.cleanup()
	if !Bool(w.metrics(), "running") {
		t.Fatal("persistent worker retired on idle")
	}
	service = 150 * mediaMiB
	w.cleanup()
	if Bool(w.metrics(), "running") || !Bool(w.metrics(), "memoryPressure") || Num(w.metrics(), "memoryStops") != 1 {
		t.Fatal("worker not sacrificed", w.metrics())
	}
	service = 300 * mediaMiB
	if _, err := w.synthesize("hello", nil); err == nil {
		t.Fatal("reloaded with inadequate memory")
	}
	if Num(w.metrics(), "starts") != 1 {
		t.Fatal("worker thrashed")
	}
	service = 800 * mediaMiB
	if _, err := w.synthesize("hello", nil); err != nil {
		t.Fatal("recovery failed", err)
	}
	if Bool(w.metrics(), "memoryPressure") || Num(w.metrics(), "starts") != 2 {
		t.Fatal("pressure did not clear")
	}
}

func TestSpeechMemoryPressureCancelsActiveGeneration(t *testing.T) {
	w := mediaFixtureWorker()
	w.keepWarm = true
	low := false
	w.memory = func() (int64, int64, bool) {
		if low {
			return 100 * mediaMiB, 100 * mediaMiB, true
		}
		return 1200 * mediaMiB, 800 * mediaMiB, true
	}
	defer w.close()
	done := make(chan error, 1)
	go func() { _, err := w.synthesize("slow", nil); done <- err }()
	deadline := time.Now().Add(3 * time.Second)
	for !Bool(w.metrics(), "busy") {
		if time.Now().After(deadline) {
			t.Fatal("not started")
		}
		time.Sleep(time.Millisecond)
	}
	low = true
	w.cleanup()
	if err := <-done; err == nil {
		t.Fatal("evicted generation returned success")
	}
	if Bool(w.metrics(), "running") {
		t.Fatal("worker survived eviction")
	}
}

func TestSpeechReuseCacheBoundedExpiresAndDropsOnPressure(t *testing.T) {
	m, _, _ := mediaTestStore(t)
	s := m.speech
	chunks := [][]byte{[]byte("RIFFfirst"), []byte("RIFFsecond")}
	s.remember("سلام friends", chunks)
	if got := s.reused("سلام friends"); len(got) != 2 || string(got[1]) != "RIFFsecond" {
		t.Fatal("no reuse")
	}
	if s.reused("سلام Friends") != nil {
		t.Fatal("different text reused")
	}
	if s.cacheHits != 1 {
		t.Fatal("hit not counted")
	}
	key := sha256.Sum256([]byte("سلام friends"))
	entry := s.reuse[key]
	entry.expires = Now() - 1
	s.reuse[key] = entry
	s.cleanup()
	if s.reused("سلام friends") != nil || s.reuseBytes != 0 {
		t.Fatal("expired audio retained")
	}
	for i := 0; i < 40; i++ {
		s.remember(S(i), [][]byte{make([]byte, 100000)})
	}
	if len(s.reuse) > 16 || s.audioBytes+s.reuseBytes > mediaMiB {
		t.Fatal("unbounded reuse")
	}
	s.worker.keepWarm = true
	s.worker.memory = func() (int64, int64, bool) { return 100 * mediaMiB, 100 * mediaMiB, true }
	s.cleanup()
	if s.reuseBytes != 0 || len(s.reuse) != 0 {
		t.Fatal("optional cache retained under pressure")
	}
}

func TestSpeechInitialWaitCanBeCancelled(t *testing.T) {
	m, _, _ := mediaTestStore(t)
	finished := make(chan bool, 1)
	go func() { finished <- m.speech.waitFirst(mediaSpeechJob{AcceptedAt: Now()}) }()
	m.Close()
	select {
	case ok := <-finished:
		if ok {
			t.Fatal("shutdown did not cancel initial wait")
		}
	case <-time.After(time.Second):
		t.Fatal("initial wait blocked shutdown")
	}
}

func TestSpeechPrewarmKeepsBothModelsReadyAndUsesOneProcess(t *testing.T) {
	w := mediaFixtureWorker()
	w.keepWarm = true
	w.memory = func() (int64, int64, bool) { return 1200 * mediaMiB, 800 * mediaMiB, true }
	defer w.close()
	w.prewarm()
	if !Bool(w.metrics(), "modelsReady") || Num(w.metrics(), "starts") != 1 {
		t.Fatal("prewarm failed", w.metrics())
	}
	if _, err := w.synthesize("hello", nil); err != nil {
		t.Fatal(err)
	}
	w.prewarm()
	if Num(w.metrics(), "starts") != 1 {
		t.Fatal("more than one worker")
	}
}

func TestNextSpeechRecycle(t *testing.T) {
	tehran := time.FixedZone("Tehran", 3*60*60+30*60)
	now := time.Date(2026, 11, 7, 4, 59, 59, 0, tehran)
	slot := time.Date(2026, 11, 7, 1, 30, 0, 0, time.UTC)
	if got := nextSpeechRecycle(now); !got.Equal(slot) {
		t.Fatalf("next cleanup = %s, want %s", got, slot)
	}
	if got := nextSpeechRecycle(slot); !got.Equal(slot.Add(24 * time.Hour)) {
		t.Fatalf("cleanup slot was repeated: %s", got)
	}
}

func TestDailySpeechRecycleRequiresEmptyVoiceAndIdleSpeech(t *testing.T) {
	m, _, _ := mediaTestStore(t)
	db := m.a.DB
	db.Run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('server','Server','owner',?)", Now())
	db.Run("INSERT INTO channels(id,server_id,name,kind,created_at) VALUES('voice','server','Voice','voice',?)", Now())
	db.Run("INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,heartbeat,joined_at) VALUES('owner','voice','socket','epoch',?,?)", Now(), Now())
	w := mediaFixtureWorker()
	w.keepWarm = true
	w.memory = func() (int64, int64, bool) { return 1200 * mediaMiB, 800 * mediaMiB, true }
	defer w.close()
	w.prewarm()
	s := &mediaSpeech{m: m, worker: w}
	deadline := time.Now().Add(time.Minute)
	if s.recycleIdleWorker(deadline) || !Bool(w.metrics(), "modelsReady") {
		t.Fatal("recycled with a voice member present")
	}
	db.Run("DELETE FROM voice_members")
	s.queued = 1
	if s.recycleIdleWorker(deadline) {
		t.Fatal("recycled with local speech pending")
	}
	s.queued, s.plusPending = 0, 1
	if s.recycleIdleWorker(deadline) {
		t.Fatal("recycled with Speech Plus pending")
	}
	s.plusPending = 0
	if s.recycleIdleWorker(time.Now()) {
		t.Fatal("recycled outside the cleanup window")
	}
	if !s.recycleIdleWorker(deadline) || Bool(w.metrics(), "running") {
		t.Fatal("idle worker was not retired")
	}
	w.prewarm()
	if !Bool(w.metrics(), "modelsReady") || Num(w.metrics(), "starts") != 2 {
		t.Fatal("both voices did not prewarm again", w.metrics())
	}
}

func TestSpeechWholeMessageWaitsForCompletionAndReuseGetsFreshAuthorization(t *testing.T) {
	m, _, _ := mediaTestStore(t)
	db := m.a.DB
	m.a.Hub = &Hub{peers: map[string]*peer{}}
	db.Run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('server','Server','owner',?)", Now())
	for _, uid := range []string{"owner", "peer"} {
		role := "member"
		if uid == "owner" {
			role = "owner"
		}
		db.Run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES('server',?,?,?)", uid, role, Now())
	}
	db.Run("INSERT INTO channels(id,server_id,name,kind,created_at) VALUES('voice','server','Voice','voice',?)", Now())
	for _, uid := range []string{"owner", "peer"} {
		db.Run("INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,heartbeat,joined_at) VALUES(?,'voice',?,'epoch',?,?)", uid, uid, Now(), Now())
	}
	text := "سلام دوستان hello friends"
	db.Run("UPDATE messages SET content=? WHERE id='message'", text)
	parts := []string{}
	started := make(chan struct{})
	release := make(chan struct{})
	m.SetSpeechSynthesizer(func(text string, _ func()) ([]byte, error) {
		parts = append(parts, text)
		close(started)
		<-release
		return []byte("RIFF" + text), nil
	})
	job := mediaSpeechJob{UID: "owner", Message: M{"id": "message", "content": text}, Sender: db.One("SELECT * FROM voice_members WHERE user_id='owner'"), Initial: db.All("SELECT user_id,epoch FROM voice_members"), AcceptedAt: Now() - 3000}
	done := make(chan struct{})
	go func() { m.speech.run(job); close(done) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("full message not synthesized")
	}
	if m.speech.read("peer", "message") != nil || len(parts) != 1 || parts[0] != text {
		close(release)
		<-done
		t.Fatal("partial audio published or message was split")
	}
	close(release)
	<-done
	first := m.speech.read("peer", "message")
	if string(first) != "RIFF"+text || m.speech.read("peer", "message-tts-1") != nil {
		t.Fatal("complete single audio missing")
	}
	db.Run("UPDATE voice_members SET epoch='rejoined' WHERE user_id='peer'")
	if m.speech.read("peer", "message") != nil {
		t.Fatal("old authorization survived rejoin")
	}
	db.Run("INSERT INTO messages(id,conversation_id,sequence,user_id,content,created_at) VALUES('repeat','dm',2,'owner',?,?)", text, Now())
	job.Message = M{"id": "repeat", "content": text}
	job.Initial = db.All("SELECT user_id,epoch FROM voice_members")
	m.speech.run(job)
	if len(parts) != 1 || m.speech.cacheHits != 1 {
		t.Fatal("identical text synthesized again")
	}
	if string(m.speech.read("peer", "repeat")) != string(first) || m.speech.read("outsider", "repeat") != nil || m.speech.read("peer", "message") != nil {
		t.Fatal("cached audio authorization was reused")
	}
	db.Run("UPDATE voice_members SET deafened=1 WHERE user_id='peer'")
	if m.speech.read("peer", "repeat") != nil {
		t.Fatal("deafened cached recipient received audio")
	}
}
