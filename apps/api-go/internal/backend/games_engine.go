package backend

import (
	"crypto/rand"
	"fmt"
	"golang.org/x/text/unicode/norm"
	"math/big"
	"strings"
	"unicode"
)

func gameRandom(n int) int {
	v, e := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if e != nil {
		panic(e)
	}
	return int(v.Int64())
}
func gameInsist(b bool, msg ...string) {
	m := "That action is unavailable."
	if len(msg) > 0 {
		m = msg[0]
	}
	Check(b, 400, "INVALID_MOVE", m)
}
func gi(v any) int { return int(N(v)) }
func gameInt(v any, min, max int) int {
	n := gi(v)
	gameInsist(gameValidInt(v, min, max), "Choose a valid number.")
	return n
}
func gameArray(n int, value any) []any {
	a := make([]any, n)
	for i := range a {
		a[i] = value
	}
	return a
}
func gameInts(n int) []any {
	a := make([]any, n)
	for i := range a {
		a[i] = i
	}
	return a
}
func gameShuffle(a []any) []any {
	a = append([]any{}, a...)
	for i := len(a) - 1; i > 0; i-- {
		j := gameRandom(i + 1)
		a[i], a[j] = a[j], a[i]
	}
	return a
}
func gameContains(a []any, v any) bool {
	for _, x := range a {
		if JSON(x) == JSON(v) {
			return true
		}
	}
	return false
}
func gameRemove(a []any, v any) []any {
	r := []any{}
	for _, x := range a {
		if JSON(x) != JSON(v) {
			r = append(r, x)
		}
	}
	return r
}
func gameTail(a []any, n int) []any {
	if len(a) > n {
		return a[len(a)-n:]
	}
	return a
}
func gameText(v any, max int) string {
	s, ok := v.(string)
	s = strings.TrimSpace(s)
	gameInsist(ok && TextLen(s) > 0 && TextLen(s) <= max, "Enter a shorter, nonempty answer.")
	return norm.NFC.String(s)
}
func gameNormalize(s string) string {
	s = norm.NFKC.String(strings.ToLower(s))
	return strings.Map(func(r rune) rune {
		switch r {
		case 'ي', 'ى':
			return 'ی'
		case 'ك':
			return 'ک'
		case '\u200c', '\u200d', 'ـ':
			return -1
		}
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, s)
}
func gamePicture() M { return M{"strokes": []any{}, "points": 0} }
func gameUndo(p M) {
	a := Arr(p["strokes"])
	if len(a) > 0 {
		p["points"] = gi(p["points"]) - len(Arr(Obj(a[len(a)-1])["points"]))
		p["strokes"] = a[:len(a)-1]
	}
}
func gameStroke(p M, v M) {
	colors := []any{"#20232b", "#ffffff", "#e45b63", "#4a86e8", "#43a477", "#ecc64c", "#9a69d5", "#e78e48"}
	gameInsist(gameContains(colors, S(v["color"])) && gameContains([]any{3, 7, 14}, gi(v["width"])), "Choose a drawing tool.")
	points := Arr(v["points"])
	gameInsist(len(points) >= 1 && len(points) <= 100, "Draw shorter strokes.")
	strokes := Arr(p["strokes"])
	gameInsist(gi(p["points"])+len(points) <= 1000 && len(strokes) < 160, "This drawing is full. Clear it or submit it.")
	copyPoints := []any{}
	for _, v := range points {
		a := Arr(v)
		gameInsist(len(a) == 2)
		copyPoints = append(copyPoints, []any{gameInt(a[0], 0, 1000), gameInt(a[1], 0, 1000)})
	}
	p["strokes"] = append(strokes, M{"color": v["color"], "width": v["width"], "points": copyPoints})
	p["points"] = gi(p["points"]) + len(points)
}

var gameEnglish = strings.Split("apple bridge castle dragon elephant flower guitar island jungle kite lantern mountain notebook ocean pencil queen rainbow snowman tiger umbrella volcano window yacht zebra balloon camera dolphin eagle forest garden hammer iceberg jacket kettle lemon moon needle orange penguin rocket sailboat turtle unicorn violin waterfall anchor bicycle cloud desert envelope feather glove helmet igloo jellyfish key ladder mirror nest owl planet rabbit sunflower train village whale zipper robot candle butterfly crown diamond fire ghost heart leaf magnet pearl star tower", " ")
var gamePersian = strings.Split("سیب پل قلعه اژدها فیل گل گیتار جزیره جنگل بادبادک فانوس کوه دفتر دریا مداد ملکه رنگین‌کمان آدم‌برفی ببر چتر آتشفشان پنجره قایق گورخر بادکنک دوربین دلفین عقاب باغ چکش کاپشن کتری لیمو ماه سوزن پرتقال پنگوئن موشک لاک‌پشت ویولن آبشار لنگر دوچرخه ابر بیابان پاکت پر دستکش کلاه کلید نردبان آینه لانه جغد سیاره خرگوش قطار روستا نهنگ ربات شمع پروانه تاج الماس آتش روح قلب برگ آهنربا مروارید ستاره برج", " ")

func gameWords(settings M) []any {
	w := gameEnglish
	if S(settings["language"]) == "fa" {
		w = gamePersian
	}
	a := []any{}
	for _, s := range w {
		a = append(a, s)
	}
	return gameShuffle(a)
}
func startGameEngine(kind string, n int, settings M, now int64) M {
	var s M
	switch kind {
	case "four":
		s = M{"phase": "turn", "deadline": now + 60000, "result": nil, "board": gameArray(42, -1), "turn": 0, "moves": 0}
	case "domino":
		s = M{"scores": gameArray(n, 0), "mode": settings["domino"], "result": nil}
		dominoRound(s, n, now)
	case "ludo":
		tokens := []any{}
		for i := 0; i < n; i++ {
			tokens = append(tokens, gameArray(4, -1))
		}
		s = M{"phase": "roll", "deadline": now + 60000, "result": nil, "tokens": tokens, "turn": 0, "die": 0, "sixes": 0, "rolls": 0}
	case "poker":
		s = pokerStart(n, settings, now)
	case "drawing":
		order := []any{}
		for r := 0; r < gi(settings["rounds"]); r++ {
			order = append(order, gameInts(n)...)
		}
		s = M{"phase": "drawing", "deadline": 0, "result": nil, "round": 0, "order": order, "words": gameWords(settings), "scores": gameArray(n, 0)}
		drawingTurn(s, settings, now)
	case "telephone":
		albums, pictures := []any{}, []any{}
		for i := 0; i < n; i++ {
			albums = append(albums, []any{})
			pictures = append(pictures, gamePicture())
		}
		s = M{"phase": "write", "deadline": now + N(settings["seconds"])*1000, "result": nil, "step": 0, "token": "phone-0", "albums": albums, "done": []any{}, "answers": M{}, "pictures": pictures}
	case "words":
		team := gameRandom(2)
		roles := append(gameArray(9, team), gameArray(8, 1-team)...)
		roles = append(roles, gameArray(7, 2)...)
		roles = append(roles, 3)
		w := gameWords(settings)
		s = M{"phase": "clue", "deadline": now + N(settings["seconds"])*1000, "result": nil, "team": team, "captains": []any{0, 1}, "board": w[:25], "roles": gameShuffle(roles), "revealed": gameArray(25, false), "clue": nil, "guesses": 0, "history": []any{}, "turns": 0, "token": "words-0"}
	default:
		gameInsist(false)
	}
	s["active"] = gameArray(n, true)
	return s
}
func gameAct(kind string, s M, seat int, a, settings M, now int64) {
	gameInsist(a != nil && S(a["type"]) != "")
	switch kind {
	case "four":
		fourAction(s, seat, a, now)
	case "domino":
		dominoAction(s, seat, a, now)
	case "ludo":
		ludoAction(s, seat, a, now, func() int { return gameRandom(6) + 1 })
	case "poker":
		pokerAction(s, seat, a, now)
	case "drawing":
		drawingAction(s, seat, a, settings, now)
	case "telephone":
		phoneAction(s, seat, a, settings, now)
	case "words":
		wordsAction(s, seat, a, settings, now)
	}
}
func gameProject(kind string, s M, seat int) M {
	switch kind {
	case "poker":
		return pokerView(s, seat)
	case "domino":
		return dominoView(s, seat)
	case "drawing":
		return drawingView(s, seat)
	case "telephone":
		return phoneView(s, seat)
	case "words":
		return wordsView(s, seat)
	case "four":
		winning := s["winning"]
		if winning == nil {
			winning = []any{}
		}
		view := M{"phase": s["phase"], "board": s["board"], "turn": s["turn"], "winning": winning}
		if v, ok := s["winner"]; ok {
			view["winner"] = v
		}
		if v, ok := s["last"]; ok {
			view["last"] = v
		}
		return view
	default:
		offsets := []any{}
		for i := range Arr(s["tokens"]) {
			offsets = append(offsets, ludoOffset(s, i))
		}
		legal := []any{}
		if seat == gi(s["turn"]) && S(s["phase"]) == "move" {
			legal = ludoLegal(s)
		}
		return M{"phase": s["phase"], "tokens": s["tokens"], "turn": s["turn"], "die": s["die"], "offsets": offsets, "legal": legal}
	}
}
func gameTimeout(kind string, s, settings M, now int64) {
	switch kind {
	case "drawing":
		drawingTick(s, settings, now)
	case "telephone":
		phoneAdvance(s, settings, now)
	case "words":
		wordsSwitch(s, settings, now)
	case "poker":
		if S(s["phase"]) == "betting" {
			pokerTimeout(s, now)
			return
		}
		fallthrough
	default:
		s["phase"] = "ended"
		s["result"] = "Game ended after inactivity"
		s["deadline"] = 0
	}
}
func gameDepart(kind string, s M, seat int, settings M, now int64) {
	active := Arr(s["active"])
	active[seat] = false
	remaining := []int{}
	for i, v := range active {
		if B(v) {
			remaining = append(remaining, i)
		}
	}
	if kind == "poker" {
		pokerDepart(s, seat, now)
		return
	}
	if len(remaining) < 2 {
		s["phase"] = "ended"
		s["deadline"] = 0
		s["result"] = "Game closed"
		if len(remaining) > 0 {
			s["result"] = fmt.Sprintf("Player %d wins by departure", remaining[0]+1)
		}
		return
	}
	next := remaining[0]
	for _, v := range remaining {
		if v > seat {
			next = v
			break
		}
	}
	switch kind {
	case "drawing":
		if gi(s["drawer"]) == seat && S(s["phase"]) == "drawing" {
			drawingTick(s, settings, now)
		} else {
			drawingEveryone(s, now)
		}
	case "telephone":
		done := Arr(s["done"])
		if !gameContains(done, seat) {
			s["done"] = append(done, seat)
		}
		if len(Arr(s["done"])) == len(Arr(s["albums"])) {
			phoneAdvance(s, settings, now)
		}
	case "words":
		team := seat % 2
		teamSeats := []int{}
		for _, p := range remaining {
			if p%2 == team {
				teamSeats = append(teamSeats, p)
			}
		}
		if len(teamSeats) < 2 {
			s["phase"] = "ended"
			s["result"] = fmt.Sprintf("Team %d wins by departure", 2-team)
			s["deadline"] = 0
		} else if gi(Arr(s["captains"])[team]) == seat {
			Arr(s["captains"])[team] = teamSeats[0]
		}
	case "domino":
		hands := Arr(s["hands"])
		s["boneyard"] = append(Arr(s["boneyard"]), Arr(hands[seat])...)
		hands[seat] = []any{}
		s["passes"] = 0
		if len(Arr(s["chain"])) == 0 {
			dominoOpening(s)
			s["deadline"] = now + 60000
		} else if gi(s["turn"]) == seat {
			s["turn"] = next
			s["deadline"] = now + 60000
		}
	case "ludo":
		Arr(s["tokens"])[seat] = gameArray(4, -1)
		if gi(s["turn"]) == seat {
			s["turn"] = next
			s["phase"] = "roll"
			s["sixes"] = 0
			s["deadline"] = now + 60000
		}
	}
}
