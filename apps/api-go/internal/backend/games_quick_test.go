package backend

import (
	"fmt"
	"testing"
)

func TestQuickGamesSixteenSeatRound(t *testing.T) {
	g, now, online := gamesTestFixture(t)
	players := []string{"a", "b", "c", "d", "e"}
	for i := len(players); i < 17; i++ {
		uid := fmt.Sprintf("quick-%d", i)
		g.a.DB.Run("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)", uid, uid, uid, "fixture", *now)
		g.a.DB.Run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES('server',?,'member',?)", uid, *now)
		g.a.DB.Run("INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,heartbeat,joined_at) VALUES(?,'voice',?,?,?,?)", uid, "socket-"+uid, ID(), *now, *now)
		online[uid] = true
		players = append(players, uid)
	}
	lobby := Obj(g.create("a", gameTestVersion, M{"requestId": ID(), "channelId": "voice", "kind": "rps", "settings": M{"maxPlayers": 16}}))
	gamesExpectError(t, "APP_UPDATE_REQUIRED", func() {
		g.create("b", "1.2.7", M{"requestId": ID(), "channelId": "voice", "kind": "rps", "settings": M{"maxPlayers": 16}})
	})
	for _, version := range []string{"", "1.2.7", "1.2.8-beta", "1.02.8"} {
		if len(Arr(g.List("b", "voice", version))) != 0 {
			t.Fatalf("lobby leaked to incompatible version %q", version)
		}
		gamesExpectError(t, "APP_UPDATE_REQUIRED", func() { g.View("b", S(lobby["id"]), version) })
	}
	if len(Arr(g.List("b", "voice", "1.2.10"))) != 1 || len(legacyClientFeatureNotices("android", "1.2.5")) != 1 ||
		len(legacyClientFeatureNotices("windows", gameTestVersion)) != 0 {
		t.Fatal("unexpected version negotiation")
	}
	gamesExpectError(t, "APP_UPDATE_REQUIRED", func() {
		g.command("b", S(lobby["id"]), "1.2.7", M{"requestId": ID(), "revision": lobby["revision"], "kind": "join"})
	})
	current := lobby
	for _, uid := range players[1:16] {
		current = gamesTestCommand(g, uid, lobby, "join", nil)
	}
	if gi(current["players"]) != 16 {
		t.Fatal("all sixteen seats must join from the same lobby revision")
	}
	gamesExpectError(t, "SEAT_TAKEN", func() { gamesTestCommand(g, players[16], lobby, "join", nil) })
	started := gamesTestCommand(g, "a", current, "start", nil)
	token := Obj(started["state"])["token"]
	id := S(started["id"])
	body := M{"requestId": ID(), "revision": started["revision"], "kind": "action", "action": M{"type": "quick-pick", "choice": 0, "token": token}}
	first := Obj(g.command("a", id, gameTestVersion, body))
	if N(Obj(g.command("a", id, gameTestVersion, body))["revision"]) != N(first["revision"]) {
		t.Fatal("retry scored a choice twice")
	}
	watch := Obj(Obj(g.View(players[16], id, gameTestVersion))["state"])
	if watch["entries"] != nil || watch["ownEntry"] != nil || !B(Arr(watch["submitted"])[0]) {
		t.Fatal("spectator leaked a locked choice")
	}
	pick := M{"type": "quick-pick", "choice": 2, "token": token}
	gamesExpectError(t, "FORBIDDEN", func() { gamesTestCommand(g, players[16], started, "action", pick) })
	gamesExpectError(t, "INVALID_MOVE", func() { gamesTestCommand(g, "a", started, "action", pick) })
	for _, uid := range players[1:16] {
		current = gamesTestCommand(g, uid, started, "action", pick)
	}
	state := Obj(current["state"])
	if S(state["phase"]) != "quick-reveal" || gi(Arr(state["scores"])[0]) != 15 || len(Arr(state["entries"])) != 16 {
		t.Fatalf("round did not score all seats: %s", JSON(state))
	}
	*now = N(current["deadline"])
	current = Obj(g.View("a", id, gameTestVersion))
	if gi(Obj(current["state"])["round"]) != 2 {
		t.Fatal("scheduler did not start the second round")
	}
	gamesExpectError(t, "STALE_GAME", func() { gamesTestCommand(g, "a", started, "action", pick) })
}

func TestQuickGamesRoundRulesAndPrivacy(t *testing.T) {
	for _, kind := range []string{"high-low", "target-dice", "odd-one", "color-sequence"} {
		t.Run(kind, func(t *testing.T) {
			now := int64(1000)
			s := quickStart(kind, 2, now)
			action := M{"type": "quick-pick", "token": s["token"]}
			switch kind {
			case "high-low":
				action["choice"] = 0
				if gi(s["answer"]) > gi(s["rank"]) {
					action["choice"] = 1
				}
			case "target-dice":
				action["choice"] = 0
			case "odd-one":
				action["choice"] = s["answer"]
			case "color-sequence":
				action["text"] = s["sequence"]
				if S(quickProject(kind, s, -1)["sequence"]) != S(s["sequence"]) {
					t.Fatal("sequence missing during watch")
				}
				gamesExpectError(t, "INVALID_MOVE", func() { quickAction(kind, s, 0, action, now) })
				now = N(s["deadline"])
				quickTimeout(kind, s, now)
			}
			quickAction(kind, s, 0, action, now)
			view := quickProject(kind, s, 1)
			if view["answer"] != nil || view["sequence"] != nil || view["entries"] != nil || view["ownEntry"] != nil {
				t.Fatalf("secret leaked: %s", JSON(view))
			}
			now = N(s["deadline"])
			quickTimeout(kind, s, now)
			view = quickProject(kind, s, 1)
			if S(view["phase"]) != "quick-reveal" || gi(Arr(view["gains"])[0]) != 1 || gi(Arr(view["gains"])[1]) != 0 {
				t.Fatalf("wrong reveal or score: %s", JSON(view))
			}
			for S(s["phase"]) != "ended" {
				quickTimeout(kind, s, N(s["deadline"]))
			}
			if S(s["result"]) != "Player 1 wins" || N(s["deadline"]) != 0 {
				t.Fatalf("game did not finish with first player ahead: %s", JSON(s))
			}
		})
	}
	t.Run("banking versus busting", func(t *testing.T) {
		s := quickStart("target-dice", 2, 0)
		s["dice"] = []any{6, 6}
		quickAction("target-dice", s, 0, M{"type": "quick-pick", "token": s["token"], "choice": 0}, 1)
		quickAction("target-dice", s, 1, M{"type": "quick-pick", "token": s["token"], "choice": 1}, 1)
		view := quickProject("target-dice", s, -1)
		if JSON(view["scores"]) != "[1,0]" || gi(Arr(view["totals"])[1]) <= 12 {
			t.Fatalf("bank should beat a bust: %s", JSON(view))
		}
	})
}

func TestQuickGamesTurnRulesAndPrivacy(t *testing.T) {
	t.Run("memory-match", func(t *testing.T) {
		s := quickStart("memory-match", 2, 0)
		if Arr(quickProject("memory-match", s, -1)["cards"])[0] != nil {
			t.Fatal("hidden card projected")
		}
		cards := Arr(s["cards"])
		for i := 0; i < len(cards); i++ {
			if B(Arr(s["matched"])[i]) {
				continue
			}
			seat := gi(s["turn"])
			quickAction("memory-match", s, seat, M{"type": "quick-pick", "choice": i}, 1)
			for j := i + 1; j < len(cards); j++ {
				if gi(cards[i]) == gi(cards[j]) {
					quickAction("memory-match", s, seat, M{"type": "quick-pick", "choice": j}, 2)
					break
				}
			}
			quickTimeout("memory-match", s, N(s["deadline"]))
		}
		if S(s["result"]) != "Game tied" || gi(Arr(s["scores"])[0]) != 6 {
			t.Fatalf("game did not score pairs in rotation: %s", JSON(s))
		}
	})
	t.Run("number-hunt", func(t *testing.T) {
		s := quickStart("number-hunt", 3, 0)
		s["secret"] = 25
		action := M{"type": "quick-pick", "choice": 20}
		gamesExpectError(t, "INVALID_MOVE", func() { quickAction("number-hunt", s, 1, action, 1) })
		quickAction("number-hunt", s, 0, action, 1)
		if v := quickProject("number-hunt", s, -1); gi(v["low"]) != 21 || v["secret"] != nil {
			t.Fatal("range or secret projection incorrect")
		}
		gameDepart("number-hunt", s, 1, nil, 2)
		quickAction("number-hunt", s, 2, M{"type": "quick-pick", "choice": 25}, 3)
		if S(s["result"]) != "Player 3 wins" {
			t.Fatalf("departure did not pass turn: %s", JSON(s))
		}
	})
	t.Run("treasure-grid", func(t *testing.T) {
		s := quickStart("treasure-grid", 2, 0)
		s["treasures"] = []any{0, 1, 5, 6, 24}
		if quickProject("treasure-grid", s, -1)["treasures"] != nil {
			t.Fatal("hidden gems projected")
		}
		quickAction("treasure-grid", s, 0, M{"type": "quick-pick", "choice": 2}, 1)
		if gi(Arr(s["tiles"])[2]) != 2 {
			t.Fatal("clue must count orthogonal and diagonal neighbors")
		}
		for _, tile := range Arr(s["treasures"]) {
			quickAction("treasure-grid", s, gi(s["turn"]), M{"type": "quick-pick", "choice": tile}, 2)
		}
		if S(s["result"]) != "Player 2 wins" || gi(s["remaining"]) != 0 {
			t.Fatalf("all gems must finish the game: %s", JSON(s))
		}
	})
}
