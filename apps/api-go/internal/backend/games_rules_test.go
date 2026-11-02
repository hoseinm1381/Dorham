package backend

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"testing"
	"time"
)

func TestGamesTypeScriptCompatibility(t *testing.T) {
	data, e := os.ReadFile("games_contract_fixtures.json")
	if e != nil {
		t.Fatal(e)
	}
	var fixture map[string][]json.RawMessage
	if e = json.Unmarshal(data, &fixture); e != nil {
		t.Fatal(e)
	}
	t.Run("chess", func(t *testing.T) {
		for i, raw := range fixture["chess"] {
			var f struct {
				State      ChessPosition
				Actions    []ChessAction
				Key        string
				Outcome    any
				Check      bool
				Repetition int
			}
			if e = json.Unmarshal(raw, &f); e != nil {
				t.Fatal(e)
			}
			actual := LegalChess(f.State)
			sort.Slice(actual, func(i, j int) bool { return JSON(actual[i]) < JSON(actual[j]) })
			sort.Slice(f.Actions, func(i, j int) bool { return JSON(f.Actions[i]) < JSON(f.Actions[j]) })
			if JSON(actual) != JSON(f.Actions) {
				t.Fatalf("position %d legal mismatch\n%s\n%s", i, JSON(actual), JSON(f.Actions))
			}
			if chessPositionKey(f.State) != f.Key || JSON(chessOutcome(f.State)) != JSON(f.Outcome) || chessCheck(f.State, f.State.Turn) != f.Check || chessRepetition(f.State) != f.Repetition {
				t.Fatalf("position %d metadata mismatch", i)
			}
		}
	})
	t.Run("transitions", func(t *testing.T) {
		for i, raw := range fixture["transitions"] {
			f := Obj(Parse(string(raw)))
			s := Obj(f["state"])
			kind := S(f["kind"])
			var err any
			func() {
				defer func() { err = recover() }()
				switch S(f["type"]) {
				case "timeout":
					gameTimeout(kind, s, Obj(f["settings"]), N(f["now"]))
				case "depart":
					gameDepart(kind, s, gi(f["seat"]), Obj(f["settings"]), N(f["now"]))
				default:
					if kind == "ludo" && S(Obj(f["action"])["type"]) == "roll" {
						ludoAction(s, gi(f["seat"]), Obj(f["action"]), N(f["now"]), func() int { return gi(f["roll"]) })
					} else {
						gameAct(kind, s, gi(f["seat"]), Obj(f["action"]), Obj(f["settings"]), N(f["now"]))
					}
				}
			}()
			if (err != nil) != (f["error"] != nil) {
				t.Fatalf("%d %s error mismatch: %v expected %v", i, kind, err, f["error"])
			}
			if JSON(s) != JSON(f["expected"]) {
				t.Fatalf("%d %s transition mismatch\n%s\n%s", i, kind, JSON(s), JSON(f["expected"]))
			}
		}
	})
	t.Run("private-views", func(t *testing.T) {
		for i, raw := range fixture["views"] {
			f := Obj(Parse(string(raw)))
			actual := gameProject(S(f["kind"]), Obj(f["state"]), gi(f["seat"]))
			if JSON(actual) != JSON(f["expected"]) {
				t.Fatalf("%d %s seat %d projection mismatch\n%s\n%s", i, S(f["kind"]), gi(f["seat"]), JSON(actual), JSON(f["expected"]))
			}
		}
	})
	t.Run("poker-ranks", func(t *testing.T) {
		for i, raw := range fixture["ranks"] {
			f := Obj(Parse(string(raw)))
			if JSON(pokerRank(Arr(f["cards"]))) != JSON(f["expected"]) {
				t.Fatalf("rank %d mismatch", i)
			}
		}
	})
}

func TestChessAIAndPokerConservation(t *testing.T) {
	for _, mode := range []string{"standard", "elixer"} {
		for _, difficulty := range []string{"Easy", "Medium", "Hard"} {
			s := InitialChess(mode)
			start := time.Now()
			a := chessAI(s, difficulty)
			if a == nil {
				t.Fatalf("%s %s returned no move", mode, difficulty)
			}
			ApplyChess(s, *a)
			if time.Since(start) > 500*time.Millisecond {
				t.Fatal("AI search did not remain bounded")
			}
		}
	}
	settings := M{"chips": 1000, "blind": 20}
	for _, n := range []int{2, 3, 4, 8} {
		for sample := 0; sample < 25; sample++ {
			s := pokerStart(n, settings, 0)
			for move := 0; S(s["phase"]) == "betting"; move++ {
				if move > 250 {
					t.Fatal("poker hand stalled")
				}
				p := gi(s["turn"])
				controls := Obj(pokerView(s, p)["controls"])
				a := M{"type": "call"}
				if B(controls["canCheck"]) {
					a["type"] = "check"
				}
				if B(controls["canRaise"]) && (move+sample)%5 == 0 {
					a = M{"type": "raise", "to": controls["minRaise"]}
					if N(a["to"]) > N(controls["maxRaise"]) {
						a["to"] = controls["maxRaise"]
					}
				} else if !B(controls["canCheck"]) && (move+sample)%11 == 0 {
					a["type"] = "fold"
				}
				pokerAction(s, p, a, int64(move))
				total := 0
				for _, v := range Arr(s["stack"]) {
					total += gi(v)
					if gi(v) < 0 {
						t.Fatal("negative chips")
					}
				}
				if S(s["phase"]) == "betting" {
					for _, v := range Arr(s["committed"]) {
						total += gi(v)
					}
				}
				if total != n*1000 {
					t.Fatalf("chips changed from %d to %d", n*1000, total)
				}
			}
		}
	}
	// Unequal all-ins create independently eligible side pots and return overbets.
	s := pokerStart(3, settings, 0)
	s["stack"] = []any{100, 200, 500}
	s["dealer"] = -1
	pokerHand(s, 0)
	for S(s["phase"]) == "betting" {
		p := gi(s["turn"])
		c := Obj(pokerView(s, p)["controls"])
		a := M{"type": "call"}
		if B(c["canRaise"]) {
			a = M{"type": "raise", "to": c["maxRaise"]}
		} else if B(c["canCheck"]) {
			a["type"] = "check"
		}
		pokerAction(s, p, a, 1)
	}
	total := 0
	pots := map[int]bool{}
	for _, v := range Arr(s["stack"]) {
		total += gi(v)
	}
	for _, p := range Arr(s["pots"]) {
		pots[gi(Obj(p)["amount"])] = true
	}
	if total != 800 || !pots[300] || !pots[200] {
		t.Fatal("side pot conservation or eligibility")
	}
	// An odd split goes clockwise from the dealer, while a folded hand stays hidden.
	s = pokerStart(3, settings, 0)
	for k, v := range (M{"board": []any{8, 9, 10, 11, 12}, "deck": []any{}, "holes": []any{[]any{13, 14}, []any{15, 16}, []any{17, 18}}, "street": []any{0, 0, 0}, "committed": []any{5, 5, 5}, "stack": []any{995, 995, 995}, "bet": 0, "acted": []any{false, false, false}, "turn": 0, "folded": []any{false, false, true}}) {
		s[k] = v
	}
	pokerAction(s, 0, M{"type": "check"}, 1)
	pokerAction(s, 1, M{"type": "check"}, 2)
	if JSON(s["payouts"]) != "[7,8,0]" || JSON(Arr(pokerView(s, -1)["holes"])[2]) != "[-1,-1]" {
		t.Fatal("odd split or folded privacy")
	}
}
func TestChessPerftAndElixer(t *testing.T) {
	var perft func(ChessPosition, int) int
	perft = func(s ChessPosition, depth int) int {
		if depth == 0 {
			return 1
		}
		n := 0
		for _, a := range LegalChess(s) {
			n += perft(chessTransition(s, a), depth-1)
		}
		return n
	}
	for d, want := range []int{1, 20, 400, 8902} {
		if got := perft(InitialChess("standard"), d); got != want {
			t.Fatalf("depth%d got%d want%d", d, got, want)
		}
	}
	s := InitialChess("standard")
	s.Board = []string{}
	for _, c := range "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R" {
		if c == '/' {
			continue
		}
		if c >= '1' && c <= '8' {
			for i := 0; i < int(c-'0'); i++ {
				s.Board = append(s.Board, "")
			}
		} else {
			s.Board = append(s.Board, string(c))
		}
	}
	if perft(s, 1) != 48 || perft(s, 2) != 2039 {
		t.Fatal("Kiwipete castling parity")
	}
	s = InitialChess("elixer")
	if chessOutcome(s) != nil {
		t.Fatal("Elixer kings must not draw")
	}
	s.Coins = [2]int{9, 9}
	s = ApplyChess(s, ChessAction{Buy: "r", To: 63})
	s = ApplyChess(s, ChessAction{Buy: "p", To: 8})
	f := 60
	s = ApplyChess(s, ChessAction{From: &f, To: 62})
	if s.Board[61] != "R" || s.Board[63] != "" {
		t.Fatal("bought rook castling")
	}
}
func TestGameValidationAndDrawingBounds(t *testing.T) {
	mustFail := func(fn func()) {
		t.Helper()
		defer func() {
			if recover() == nil {
				t.Fatal("expected rejection")
			}
		}()
		fn()
	}
	settings := M{"maxPlayers": 2, "seconds": 60, "rounds": 1, "language": "fa", "domino": "draw", "chips": 1000, "blind": 20}
	valid := M{"requestId": ID(), "channelId": "v", "kind": "four", "settings": settings}
	validateGameCreate(valid)
	bad := Clone(valid)
	Obj(bad["settings"])["extra"] = true
	mustFail(func() { validateGameCreate(bad) })
	p := gamePicture()
	for i := 0; i < 10; i++ {
		points := []any{}
		for j := 0; j < 100; j++ {
			points = append(points, []any{1, 2})
		}
		gameStroke(p, M{"color": "#20232b", "width": 3, "points": points})
	}
	mustFail(func() { gameStroke(p, M{"color": "#20232b", "width": 3, "points": []any{[]any{1, 2}}}) })
	gameUndo(p)
	if gi(p["points"]) != 900 {
		t.Fatal("undo capacity")
	}
	if gameNormalize(" كليد‌ ") != gameNormalize("کلید") {
		t.Fatal("Persian normalization")
	}
	_ = fmt.Sprint(settings)
}
func TestGamePauseAndChessClocks(t *testing.T) {
	s := M{"seats": []any{M{"id": "a", "left": false, "grace": 30000, "missingAt": 1000}, M{"id": "b", "left": false, "grace": 21000, "missingAt": 2000}}, "state": M{"deadline": 60000, "started": 500}, "pauseStarted": 1000}
	gameReconcilePause(s, 3000)
	if N(s["pausedUntil"]) != 23000 {
		t.Fatal("earliest remaining grace")
	}
	for _, p := range gameSeats(s) {
		p["missingAt"] = 0
	}
	gameReconcilePause(s, 10000)
	if N(s["pausedUntil"]) != 0 || N(s["pauseStarted"]) != 0 || N(Obj(s["state"])["deadline"]) != 69000 || N(Obj(s["state"])["started"]) != 9500 {
		t.Fatal("pause shifts deadlines and scoring time")
	}
	c := &ChessGame{Status: "playing", Position: InitialChess("standard"), Remaining: [2]int64{300000, 300000}, RunningSince: 1000}
	chessCharge(c, 4750)
	if c.Remaining[0] != 296250 {
		t.Fatal("clock charge")
	}
	c.PausedUntil = 40000
	chessCharge(c, 20000)
	if c.Remaining[0] != 296250 {
		t.Fatal("paused clock charged")
	}
	c.WhiteID = "a"
	c.Missing = []string{"a"}
	chessExpire(c, 40000)
	if c.Status != "finished" || c.Result != "Black wins by disconnection" {
		t.Fatal("disconnect expiry")
	}
	c = &ChessGame{Status: "playing", Position: InitialChess("standard"), Remaining: [2]int64{1, 300000}, RunningSince: 1000}
	chessCharge(c, 1001)
	if c.Result != "Black wins by timeout" {
		t.Fatal("timeout")
	}
	c = &ChessGame{Status: "pending", OpenSeat: true, CreatedAt: 1000}
	chessExpire(c, 600999)
	if c.Status != "pending" {
		t.Fatal("premature lobby expiry")
	}
	chessExpire(c, 601000)
	if c.Status != "finished" || c.Result != "Challenge expired" {
		t.Fatal("lobby expiry")
	}
}
