package backend

import (
	"runtime"
	"testing"
	"time"
)

func TestGamesSchedulerHeavyAlbumWakesUseCompactMetadata(t *testing.T) {
	g, now, online := gamesTestFixture(t)
	for _, uid := range []string{"f", "g", "h"} {
		online[uid] = true
		g.a.DB.Run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)", uid, uid, uid, "fixture-only", *now)
		g.a.DB.Run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES('server',?,'member',?)", uid, *now)
		g.a.DB.Run("INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,heartbeat,joined_at) VALUES(?,'voice',?,?,?,?)", uid, "socket-"+uid, ID(), *now, *now)
	}
	s := Obj(g.create("a", M{"requestId": ID(), "channelId": "voice", "kind": "telephone", "settings": M{"maxPlayers": 8}}))
	for _, uid := range []string{"b", "c", "d", "e", "f", "g", "h"} {
		s = gamesTestCommand(g, uid, s, "join", nil)
	}
	s = gamesTestCommand(g, "a", s, "start", nil)
	id := S(s["id"])
	picture := gamePicture()
	for stroke := 0; stroke < 10; stroke++ {
		points := []any{}
		for point := 0; point < 100; point++ {
			points = append(points, []any{1000, 1000})
		}
		gameStroke(picture, M{"color": "#20232b", "width": 7, "points": points})
	}
	albums, pictures := []any{}, []any{}
	for seat := 0; seat < 8; seat++ {
		album := []any{}
		for step := 0; step < 7; step++ {
			entry := M{"author": (seat + step) % 8, "type": "text", "text": "previous sentence"}
			if step%2 == 1 {
				entry = M{"author": (seat + step) % 8, "type": "picture", "picture": picture}
			}
			album = append(album, entry)
		}
		albums = append(albums, album)
		pictures = append(pictures, picture)
	}
	g.mu.Lock()
	g.a.DB.Tx(func(tx *DB) any {
		full := g.load(tx, id)
		engine := Obj(full["state"])
		engine["albums"], engine["pictures"] = albums, pictures
		engine["phase"], engine["step"], engine["token"] = "draw", 7, "phone-7"
		g.save(tx, full, false)
		return nil
	})
	g.changed(id, nil)
	g.mu.Unlock()
	bytes := len(S(g.a.DB.One("SELECT state FROM game_sessions WHERE id=?", id)["state"]))
	if bytes < 300*1024 || bytes > 768*1024 {
		t.Fatalf("expected a substantial valid album below its existing budget, got %d bytes", bytes)
	}
	if size := len(JSON(g.observed[id])); size > 4096 || Obj(g.observed[id]["state"])["albums"] != nil {
		t.Fatalf("scheduler retains drawing/private album data: %d bytes", size)
	}
	want := *now + 60000
	if got := g.nearest(); got != want {
		t.Fatalf("deadline changed for heavy album: got %d want %d", got, want)
	}
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	for i := 0; i < 20; i++ {
		g.schedule()
		if got := g.nearest(); got != want {
			t.Fatalf("wake %d lost deadline: %d", i, got)
		}
	}
	runtime.ReadMemStats(&after)
	allocated := after.TotalAlloc - before.TotalAlloc
	// Twenty scheduling wakes must not allocate/decode the >300KiB album each
	// time. The generous bound permits SQL-driver/platform variance but catches
	// the previous full JSON parse (many tens of MiB on this same fixture).
	if allocated > 8*1024*1024 {
		t.Fatalf("20 wakes decoded/allocated heavy game states again: %d bytes", allocated)
	}
	t.Logf("album=%d bytes; compact metadata=%d bytes; 20 wakes allocated=%d bytes", bytes, len(JSON(g.observed[id])), allocated)
}

func TestGamesSchedulerCommittedSameMillisecondSavesRollbackAndFKCleanup(t *testing.T) {
	g, now, _ := gamesTestFixture(t)
	s := Obj(g.create("a", M{"requestId": ID(), "channelId": "voice", "kind": "four", "settings": M{"maxPlayers": 2}}))
	id := S(s["id"])
	c := Obj(g.chessCreate("c", M{"requestId": ID(), "serverId": "server", "channelId": "voice", "openSeat": true, "mode": "standard", "minutes": 5, "increment": 0}))
	cid := S(c["id"])
	if got := g.nearest(); got != *now+600000 {
		t.Fatalf("pending chess deadline: %d", got)
	}
	// Save twice without advancing the clock. Dirty invalidation must not rely
	// solely on updated_at, and must observe only committed state after rollback.
	g.mu.Lock()
	g.a.DB.Tx(func(tx *DB) any {
		full := g.load(tx, id)
		full["createdAt"] = *now - 590000
		g.save(tx, full, false)
		return nil
	})
	g.mu.Unlock()
	if got := g.nearest(); got != *now+10000 {
		t.Fatalf("same-millisecond committed arcade save was missed: %d", got)
	}
	gamesExpectError(t, "FIXTURE_ROLLBACK", func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		g.a.DB.Tx(func(tx *DB) any {
			full := g.load(tx, id)
			full["createdAt"] = *now
			g.save(tx, full, false)
			Fail(409, "FIXTURE_ROLLBACK", "fixture")
			return nil
		})
	})
	if got := g.nearest(); got != *now+10000 {
		t.Fatalf("rolled-back arcade deadline leaked into scheduler: %d", got)
	}
	phantom := ID()
	gamesExpectError(t, "FIXTURE_ROLLBACK", func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		g.a.DB.Tx(func(tx *DB) any {
			full := g.load(tx, id)
			full["id"] = phantom
			g.save(tx, full, false)
			Fail(409, "FIXTURE_ROLLBACK", "fixture")
			return nil
		})
	})
	if got := g.nearest(); got != *now+10000 || g.deadlineDirty["game:"+phantom] {
		t.Fatalf("failed creation retained a phantom deadline/cache marker: %d", got)
	}
	g.mu.Lock()
	g.a.DB.Tx(func(tx *DB) any {
		current := g.chessLoad(tx, cid)
		current.CreatedAt = *now - 595000
		g.chessSave(tx, current)
		return nil
	})
	g.mu.Unlock()
	if got := g.nearest(); got != *now+5000 {
		t.Fatalf("same-millisecond committed chess save was missed: %d", got)
	}
	gamesExpectError(t, "FIXTURE_ROLLBACK", func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		g.a.DB.Tx(func(tx *DB) any {
			current := g.chessLoad(tx, cid)
			current.CreatedAt = *now
			g.chessSave(tx, current)
			Fail(409, "FIXTURE_ROLLBACK", "fixture")
			return nil
		})
	})
	if got := g.nearest(); got != *now+5000 {
		t.Fatalf("rolled-back chess deadline leaked into scheduler: %d", got)
	}
	g.a.DB.Run("DELETE FROM channels WHERE id='voice'")
	if got := g.nearest(); got != 0 || len(g.observed) != 0 || len(g.chessObserved) != 0 || len(g.deadlineDirty) != 0 {
		t.Fatalf("FK-deleted games retained timers/cache: deadline=%d games=%d chess=%d dirty=%d", got, len(g.observed), len(g.chessObserved), len(g.deadlineDirty))
	}
}

func TestGamesSchedulerFreshDueStateAndActualTimerShutdown(t *testing.T) {
	g, _, _ := gamesTestFixture(t)
	s := Obj(g.create("a", M{"requestId": ID(), "channelId": "voice", "kind": "four", "settings": M{"maxPlayers": 2}}))
	id := S(s["id"])
	g.now = Now
	g.mu.Lock()
	g.a.DB.Tx(func(tx *DB) any {
		full := g.load(tx, id)
		full["createdAt"] = Now() - 600000 + 120
		g.save(tx, full, false)
		return nil
	})
	g.changed(id, nil)
	g.mu.Unlock()
	g.wg.Add(1)
	go g.loop()
	expires := time.Now().Add(3 * time.Second)
	for time.Now().Before(expires) {
		if S(g.a.DB.One("SELECT status FROM game_sessions WHERE id=?", id)["status"]) == "finished" {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	result := Obj(Parse(S(g.a.DB.One("SELECT state FROM game_sessions WHERE id=?", id)["state"])))
	if S(result["status"]) != "finished" || S(result["result"]) != "Lobby expired" {
		t.Fatalf("real timer did not execute a fresh persisted due transition: %s", JSON(result))
	}
	done := make(chan struct{})
	go func() { g.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("scheduler did not shut down promptly")
	}
	g.Close() // repeated close remains safe
}
