package backend

import (
	"strings"
	"testing"
)

func gamesTestFixture(t *testing.T) (*Games, *int64, map[string]bool) {
	t.Helper()
	c := Config{DataDir: t.TempDir(), MaxDatabaseMiB: 32, MaxUsers: 100, MaxOnline: 20, MaxVoice: 16, GuestsEnabled: true}
	db := OpenDB(c)
	a := &App{C: c, DB: db}
	a.Service = NewService(db, c)
	a.Hub = &Hub{a: a, peers: map[string]*peer{}}
	now := int64(1800000000000)
	online := map[string]bool{}
	for _, uid := range []string{"a", "b", "c", "d", "e", "outsider"} {
		db.Run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)", uid, uid, uid, "unused test fixture", now)
		online[uid] = true
	}
	db.Run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('server','Games','a',?)", now)
	for _, uid := range []string{"a", "b", "c", "d", "e"} {
		role := "member"
		if uid == "a" {
			role = "owner"
		}
		db.Run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES('server',?,?,?)", uid, role, now)
	}
	for _, id := range []string{"voice", "other"} {
		db.Run("INSERT INTO channels(id,server_id,name,kind,created_at) VALUES(?,'server',?,'voice',?)", id, id, now)
	}
	for _, uid := range []string{"a", "b", "c", "d", "e"} {
		db.Run("INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,heartbeat,joined_at) VALUES(?,'voice',?,?,?,?)", uid, "socket-"+uid, ID(), now, now)
	}
	g := &Games{a: a, stop: make(chan struct{}), wake: make(chan struct{}, 1), rates: map[string][2]int64{}, observed: map[string]M{}, chessObserved: map[string]*ChessGame{}, online: func(uid string) bool { return online[uid] }, now: func() int64 { return now }}
	t.Cleanup(func() { g.Close(); db.Close() })
	return g, &now, online
}
func gamesExpectError(t *testing.T, code string, fn func()) {
	t.Helper()
	defer func() {
		p := recover()
		if p == nil {
			t.Fatalf("expected %s", code)
		}
		e := RecoverError(p)
		if e.Code != code {
			t.Fatalf("expected %s got %s: %v", code, e.Code, p)
		}
	}()
	fn()
}
func gamesTestCommand(g *Games, uid string, s M, kind string, action M) M {
	b := M{"requestId": ID(), "revision": s["revision"], "kind": kind}
	if action != nil {
		b["action"] = action
	}
	return Obj(g.command(uid, S(s["id"]), b))
}
func TestGamesAllLobbiesPermissionsPrivacyAndIdempotency(t *testing.T) {
	for kind, limit := range gameLimits {
		t.Run(kind, func(t *testing.T) {
			g, _, _ := gamesTestFixture(t)
			s := Obj(g.create("a", M{"requestId": ID(), "channelId": "voice", "kind": kind, "settings": M{"maxPlayers": limit[1]}}))
			if S(s["status"]) != "waiting" || gi(s["players"]) != 1 || S(Obj(s["state"])["phase"]) != "lobby" {
				t.Fatal("waiting projection")
			}
			gamesExpectError(t, "CAPACITY", func() {
				g.create("a", M{"requestId": ID(), "channelId": "voice", "kind": kind, "settings": M{"maxPlayers": limit[1]}})
			})
			gamesExpectError(t, "FORBIDDEN", func() { g.View("outsider", S(s["id"])) })
			gamesExpectError(t, "NOT_READY", func() { gamesTestCommand(g, "a", s, "start", nil) })
			players := []string{"a", "b", "c", "d", "e"}
			for i := 1; i < limit[0]; i++ {
				body := M{"requestId": ID(), "revision": s["revision"], "kind": "join"}
				s = Obj(g.command(players[i], S(s["id"]), body))
				again := Obj(g.command(players[i], S(s["id"]), body))
				if N(again["revision"]) != N(s["revision"]) {
					t.Fatal("duplicate join changed state")
				}
			}
			s = gamesTestCommand(g, "a", s, "start", nil)
			if S(s["status"]) != "playing" {
				t.Fatal("start")
			}
			watch := Obj(g.View("e", S(s["id"])))
			if gi(watch["self"]) != -1 || B(watch["canPlay"]) {
				t.Fatal("spectator seat")
			}
			gamesExpectError(t, "FORBIDDEN", func() { gamesTestCommand(g, "e", s, "action", M{"type": "drop", "column": 0}) })
			state := Obj(watch["state"])
			switch kind {
			case "poker":
				for _, h := range Arr(state["holes"]) {
					for _, card := range Arr(h) {
						if gi(card) != -1 {
							t.Fatal("private poker card")
						}
					}
				}
				if _, ok := state["deck"]; ok {
					t.Fatal("deck leak")
				}
			case "domino":
				if len(Arr(state["hand"])) != 0 {
					t.Fatal("private hand")
				}
			case "telephone":
				if state["previous"] != nil || state["picture"] != nil {
					t.Fatal("private album")
				}
			case "drawing":
				if state["word"] != nil {
					t.Fatal("private drawing answer")
				}
			case "words":
				for _, role := range Arr(state["roles"]) {
					if role != nil {
						t.Fatal("secret word roles")
					}
				}
			}
		})
	}
}
func TestGamesRetriesPauseBudgetRestartAndHostTransfer(t *testing.T) {
	g, now, online := gamesTestFixture(t)
	s := Obj(g.create("a", M{"requestId": ID(), "channelId": "voice", "kind": "four", "settings": M{"maxPlayers": 2}}))
	s = gamesTestCommand(g, "b", s, "join", nil)
	s = gamesTestCommand(g, "a", s, "start", nil)
	gamesExpectError(t, "CAPACITY", func() {
		g.chessCreate("a", M{"requestId": ID(), "serverId": "server", "mode": "standard", "difficulty": "Easy", "minutes": 3, "increment": 0})
	})
	body := M{"requestId": ID(), "revision": s["revision"], "kind": "action", "action": M{"type": "drop", "column": 0}}
	s = Obj(g.command("a", S(s["id"]), body))
	again := Obj(g.command("a", S(s["id"]), body))
	if JSON(s["state"]) != JSON(again["state"]) {
		t.Fatal("duplicate move")
	}
	conflict := Clone(body)
	Obj(conflict["action"])["column"] = 1
	gamesExpectError(t, "IDEMPOTENCY_CONFLICT", func() { g.command("a", S(s["id"]), conflict) })
	deadline := N(s["deadline"])
	*now += 3000
	online["a"] = false
	g.ReconcileVoice()
	s = Obj(g.View("a", S(s["id"])))
	if N(s["pausedUntil"]) != *now+30000 {
		t.Fatal("pause missing")
	}
	*now += 9000
	online["a"] = true
	g.ReconcileVoice()
	s = Obj(g.View("a", S(s["id"])))
	if N(s["pausedUntil"]) != 0 || N(s["deadline"]) != deadline+9000 || N(Obj(Arr(s["seats"])[0])["grace"]) != 21000 {
		t.Fatal("reconnect grace")
	}
	g.initialize()
	s = Obj(g.View("b", S(s["id"])))
	if N(s["pausedUntil"]) != *now+21000 {
		t.Fatal("restart grace")
	}
	g.ReconcileVoice()
	online["a"] = false
	g.ReconcileVoice()
	*now += 21001
	g.mu.Lock()
	g.tick()
	g.mu.Unlock()
	s = Obj(g.View("b", S(s["id"])))
	if S(s["status"]) != "finished" || S(s["result"]) != "Player 2 wins by departure" {
		t.Fatal("departure did not settle")
	}
	s = Obj(g.create("b", M{"requestId": ID(), "channelId": "voice", "kind": "domino", "settings": M{"maxPlayers": 4}}))
	s = gamesTestCommand(g, "c", s, "join", nil)
	gamesTestCommand(g, "b", s, "leave", nil)
	s = Obj(g.View("c", S(s["id"])))
	if S(s["hostId"]) != "c" || gi(s["players"]) != 1 {
		t.Fatal("host transfer")
	}
}
func TestChessVoiceSeatRetriesClockAndRestart(t *testing.T) {
	g, now, online := gamesTestFixture(t)
	s := Obj(g.chessCreate("a", M{"requestId": ID(), "serverId": "server", "channelId": "voice", "openSeat": true, "mode": "standard", "minutes": 5, "increment": 2}))
	if S(s["status"]) != "pending" || S(s["blackName"]) != "Open seat" {
		t.Fatal("open seat")
	}
	*now += 20000
	s = Obj(g.ChessView("a", S(s["id"])))
	if gi(Arr(s["remaining"])[0]) != 300000 {
		t.Fatal("pending clock charged")
	}
	body := M{"requestId": ID(), "revision": s["revision"], "kind": "join"}
	s = Obj(g.chessCommand("b", S(s["id"]), body))
	again := Obj(g.chessCommand("b", S(s["id"]), body))
	if N(again["revision"]) != N(s["revision"]) {
		t.Fatal("duplicate join")
	}
	gamesExpectError(t, "SEAT_TAKEN", func() {
		g.chessCommand("c", S(s["id"]), M{"requestId": ID(), "revision": s["revision"], "kind": "join"})
	})
	spectator := Obj(g.ChessView("c", S(s["id"])))
	if len(Arr(spectator["actions"])) != 0 || B(spectator["canPlay"]) {
		t.Fatal("spectator can play")
	}
	*now += 3750
	s = Obj(g.chessCommand("a", S(s["id"]), M{"requestId": ID(), "revision": s["revision"], "kind": "action", "action": M{"from": 52, "to": 36}}))
	if N(Arr(s["remaining"])[0]) != 298250 {
		t.Fatal("increment/clock")
	}
	online["a"] = false
	g.Presence("a", false)
	s = Obj(g.ChessView("b", S(s["id"])))
	if N(s["pausedUntil"]) != *now+30000 {
		t.Fatal("chess pause")
	}
	*now += 9000
	online["a"] = true
	g.Presence("a", true)
	s = Obj(g.ChessView("a", S(s["id"])))
	if N(s["pausedUntil"]) != 0 || N(Arr(s["grace"])[0]) != 21000 {
		t.Fatal("chess reconnect")
	}
	g.initialize()
	s = Obj(g.ChessView("a", S(s["id"])))
	if N(s["pausedUntil"]) != *now+30000 {
		t.Fatal("chess restart")
	}
	g.ReconcileVoice()
	online["a"] = false
	g.Presence("a", false)
	*now += 21001
	g.mu.Lock()
	g.tick()
	g.mu.Unlock()
	s = Obj(g.ChessView("b", S(s["id"])))
	if S(s["status"]) != "finished" || S(s["result"]) != "Black wins by disconnection" {
		t.Fatal("chess disconnect did not settle")
	}
}
func TestGamesBlocksVoiceAndConcurrentPrivateSubmissions(t *testing.T) {
	g, now, _ := gamesTestFixture(t)
	s := Obj(g.create("a", M{"requestId": ID(), "channelId": "voice", "kind": "telephone", "settings": M{"maxPlayers": 4}}))
	g.a.DB.Run("INSERT INTO user_blocks(user_id,blocked_id) VALUES('a','b')")
	gamesExpectError(t, "FORBIDDEN", func() { gamesTestCommand(g, "b", s, "join", nil) })
	g.a.DB.Run("DELETE FROM user_blocks")
	s = gamesTestCommand(g, "b", s, "join", nil)
	s = gamesTestCommand(g, "c", s, "join", nil)
	s = gamesTestCommand(g, "a", s, "start", nil)
	revision, token := s["revision"], Obj(s["state"])["token"]
	for _, uid := range []string{"a", "b", "c"} {
		s = Obj(g.command(uid, S(s["id"]), M{"requestId": ID(), "revision": revision, "kind": "action", "action": M{"type": "submit", "token": token, "text": "private-" + uid}}))
	}
	if gi(Obj(s["state"])["step"]) != 1 {
		t.Fatal("concurrent token submissions stalled")
	}
	watch := Obj(g.View("d", S(s["id"])))
	if strings.Contains(JSON(watch), "private-") {
		t.Fatal("telephone secret leaked")
	}
	gamesExpectError(t, "INVALID_MOVE", func() { gamesTestCommand(g, "a", s, "action", M{"type": "submit", "token": token, "text": "stale"}) })
	g.a.DB.Run("UPDATE voice_members SET channel_id='other' WHERE user_id='d'")
	gamesExpectError(t, "VOICE_REQUIRED", func() { g.View("d", S(s["id"])) })
	gamesExpectError(t, "VOICE_REQUIRED", func() { g.List("d", "voice") })
	for _, uid := range []string{"a", "b"} {
		gamesTestCommand(g, uid, Obj(g.View(uid, S(s["id"]))), "leave", nil)
	}
	lobby := Obj(g.create("a", M{"requestId": ID(), "channelId": "voice", "kind": "four", "settings": M{"maxPlayers": 2}}))
	*now += 600001
	g.mu.Lock()
	g.tick()
	g.mu.Unlock()
	lobby = Obj(g.View("a", S(lobby["id"])))
	if S(lobby["result"]) != "Lobby expired" {
		t.Fatal("lobby never expired")
	}
}
func TestGamesAtomicLastSeat(t *testing.T) {
	g, _, _ := gamesTestFixture(t)
	s := Obj(g.create("a", M{"requestId": ID(), "channelId": "voice", "kind": "four", "settings": M{"maxPlayers": 2}}))
	results := make(chan any, 3)
	for _, uid := range []string{"b", "c", "d"} {
		go func(uid string) {
			func() {
				defer func() {
					if p := recover(); p != nil {
						results <- p
					}
				}()
				results <- gamesTestCommand(g, uid, s, "join", nil)
			}()
		}(uid)
	}
	success := 0
	for i := 0; i < 3; i++ {
		r := <-results
		if _, ok := r.(M); ok {
			success++
		} else {
			e := RecoverError(r)
			if e.Code != "STALE_GAME" && e.Code != "SEAT_TAKEN" {
				t.Fatalf("unexpected claim error %v", r)
			}
		}
	}
	if success != 1 {
		t.Fatalf("%d last-seat claims succeeded", success)
	}
	s = Obj(g.View("a", S(s["id"])))
	if gi(s["players"]) != 2 {
		t.Fatal("seat overwrite")
	}
}
