package backend

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// Chess rules intentionally share the browser contract, including the original
// Elixer purchase/virgin-piece rules. Network actions always pass legal generation.
type ChessAction struct {
	From      *int   `json:"from,omitempty"`
	To        int    `json:"to"`
	Promotion string `json:"promotion,omitempty"`
	Buy       string `json:"buy,omitempty"`
}
type ChessPosition struct {
	Mode    string       `json:"mode"`
	Board   []string     `json:"board"`
	Turn    int          `json:"turn"`
	Rights  string       `json:"rights"`
	EP      int          `json:"ep"`
	Virgin  []int        `json:"virgin"`
	Coins   [2]int       `json:"coins"`
	Half    int          `json:"half"`
	Ply     int          `json:"ply"`
	Repeats []string     `json:"repeats"`
	Last    *ChessAction `json:"last,omitempty"`
}

var chessCosts = map[string]int{"p": 1, "n": 3, "b": 3, "r": 5, "q": 9, "k": 100}
var chessBishop = [][2]int{{1, 1}, {1, -1}, {-1, 1}, {-1, -1}}
var chessRook = [][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}
var chessKnight = [][2]int{{1, 2}, {2, 1}, {-1, 2}, {-2, 1}, {1, -2}, {2, -1}, {-1, -2}, {-2, -1}}

func chessInside(x, y int) bool { return x >= 0 && x < 8 && y >= 0 && y < 8 }
func chessColor(p string) int {
	if p == strings.ToUpper(p) {
		return 0
	}
	return 1
}
func chessHas(a []int, n int) bool {
	for _, v := range a {
		if v == n {
			return true
		}
	}
	return false
}
func chessSquare(i int) string { return fmt.Sprintf("%c%d", 'a'+i%8, 8-i/8) }
func InitialChess(mode string) ChessPosition {
	s := ChessPosition{Mode: mode, Board: make([]string, 64), Rights: "", EP: -1, Virgin: []int{}, Coins: [2]int{3, 3}, Repeats: []string{}}
	if mode == "standard" {
		s.Rights = "KQkq"
		for i, p := range "rnbqkbnrpppppppp" {
			s.Board[i] = string(p)
		}
		for i, p := range "PPPPPPPPRNBQKBNR" {
			s.Board[i+48] = string(p)
		}
	} else {
		s.Board[4] = "k"
		s.Board[60] = "K"
		s.Virgin = []int{4, 60}
	}
	s.Repeats = []string{chessPositionKey(s)}
	return s
}
func chessAttacked(s ChessPosition, target, by int) bool {
	x, y := target%8, target/8
	for _, dx := range []int{-1, 1} {
		py := y - 1
		if by == 0 {
			py = y + 1
		}
		px := x + dx
		p := "p"
		if by == 0 {
			p = "P"
		}
		if chessInside(px, py) && s.Board[py*8+px] == p {
			return true
		}
	}
	for _, d := range chessKnight {
		p := "n"
		if by == 0 {
			p = "N"
		}
		if chessInside(x+d[0], y+d[1]) && s.Board[(y+d[1])*8+x+d[0]] == p {
			return true
		}
	}
	for _, v := range append(append([][2]int{}, chessBishop...), chessRook...) {
		for d := 1; chessInside(x+v[0]*d, y+v[1]*d); d++ {
			p := s.Board[(y+v[1]*d)*8+x+v[0]*d]
			if p == "" {
				continue
			}
			kind := "r"
			if v[0] != 0 && v[1] != 0 {
				kind = "b"
			}
			t := strings.ToLower(p)
			if chessColor(p) == by && (t == "q" || t == kind || (d == 1 && t == "k")) {
				return true
			}
			break
		}
	}
	return false
}
func chessCheck(s ChessPosition, color int) bool {
	k := "k"
	if color == 0 {
		k = "K"
	}
	for i, p := range s.Board {
		if p == k {
			return chessAttacked(s, i, 1-color)
		}
	}
	return true
}
func chessPseudo(s ChessPosition) []ChessAction {
	out := []ChessAction{}
	add := func(from, to int) {
		if strings.ToLower(s.Board[to]) == "k" {
			return
		}
		f := from
		if strings.ToLower(s.Board[from]) == "p" && (to < 8 || to >= 56) {
			for _, p := range []string{"q", "r", "b", "n"} {
				out = append(out, ChessAction{From: &f, To: to, Promotion: p})
			}
		} else {
			out = append(out, ChessAction{From: &f, To: to})
		}
	}
	for from, p := range s.Board {
		if p == "" || chessColor(p) != s.Turn {
			continue
		}
		t, x, y := strings.ToLower(p), from%8, from/8
		if t == "p" {
			dy := 1
			if s.Turn == 0 {
				dy = -1
			}
			next := from + dy*8
			if chessInside(x, y+dy) && s.Board[next] == "" {
				add(from, next)
				virgin := y == 1
				if s.Turn == 0 {
					virgin = y == 6
				}
				if s.Mode == "elixer" {
					virgin = chessHas(s.Virgin, from)
				}
				if virgin && chessInside(x, y+2*dy) && s.Board[from+16*dy] == "" {
					add(from, from+16*dy)
				}
			}
			for _, dx := range []int{-1, 1} {
				if chessInside(x+dx, y+dy) {
					to := next + dx
					target := s.Board[to]
					if (target != "" && chessColor(target) != s.Turn) || (to == s.EP && strings.ToLower(s.Board[to-dy*8]) == "p") {
						add(from, to)
					}
				}
			}
		} else {
			dirs := append(append([][2]int{}, chessBishop...), chessRook...)
			switch t {
			case "n":
				dirs = chessKnight
			case "b":
				dirs = chessBishop
			case "r":
				dirs = chessRook
			}
			for _, v := range dirs {
				for d := 1; chessInside(x+d*v[0], y+d*v[1]); d++ {
					to := (y+d*v[1])*8 + x + d*v[0]
					target := s.Board[to]
					if target != "" && chessColor(target) == s.Turn {
						break
					}
					add(from, to)
					if target != "" || t == "n" || t == "k" {
						break
					}
				}
			}
			king := 4
			if s.Turn == 0 {
				king = 60
			}
			if t == "k" && from == king && !chessCheck(s, s.Turn) {
				for _, step := range []int{1, -1} {
					corner := from + 3
					right := "k"
					if step < 0 {
						corner = from - 4
						right = "q"
					}
					rook := "r"
					if s.Turn == 0 {
						right = strings.ToUpper(right)
						rook = "R"
					}
					eligible := strings.Contains(s.Rights, right)
					if s.Mode == "elixer" {
						eligible = chessHas(s.Virgin, from) && chessHas(s.Virgin, corner)
					}
					if !eligible || s.Board[corner] != rook || s.Board[from+step] != "" || s.Board[from+step*2] != "" || (step < 0 && s.Board[from-3] != "") {
						continue
					}
					if !chessAttacked(s, from+step, 1-s.Turn) && !chessAttacked(s, from+step*2, 1-s.Turn) {
						add(from, from+step*2)
					}
				}
			}
		}
	}
	if s.Mode == "elixer" {
		for _, buy := range []string{"p", "n", "b", "r", "q"} {
			if s.Coins[s.Turn] >= chessCosts[buy] {
				start := 0
				if s.Turn == 0 {
					start = 48
				}
				for to := start; to < start+16; to++ {
					if s.Board[to] == "" {
						out = append(out, ChessAction{To: to, Buy: buy})
					}
				}
			}
		}
	}
	return out
}
func chessTransition(s ChessPosition, a ChessAction) ChessPosition {
	n := s
	n.Board = append([]string{}, s.Board...)
	n.Virgin = []int{}
	for _, i := range s.Virgin {
		if i != a.To && (a.From == nil || i != *a.From) {
			n.Virgin = append(n.Virgin, i)
		}
	}
	captured := n.Board[a.To]
	n.EP = -1
	n.Half++
	if a.Buy != "" {
		p := a.Buy
		if s.Turn == 0 {
			p = strings.ToUpper(p)
		}
		n.Board[a.To] = p
		n.Coins[s.Turn] -= chessCosts[a.Buy]
		n.Virgin = append(n.Virgin, a.To)
		n.Half = 0
	} else {
		from := *a.From
		p := n.Board[from]
		t := strings.ToLower(p)
		n.Board[from] = ""
		n.Board[a.To] = p
		if t == "p" {
			n.Half = 0
			if int(math.Abs(float64(a.To-from))) == 16 {
				n.EP = (a.To + from) / 2
			}
			if a.To == s.EP && captured == "" && from%8 != a.To%8 {
				victim := a.To - 8
				if s.Turn == 0 {
					victim = a.To + 8
				}
				n.Board[victim] = ""
				virgin := []int{}
				for _, i := range n.Virgin {
					if i != victim {
						virgin = append(virgin, i)
					}
				}
				n.Virgin = virgin
			}
			if a.Promotion != "" {
				n.Board[a.To] = a.Promotion
				if s.Turn == 0 {
					n.Board[a.To] = strings.ToUpper(a.Promotion)
				}
			}
		}
		if t == "k" {
			letters := "kq"
			if s.Turn == 0 {
				letters = "KQ"
			}
			for _, r := range letters {
				n.Rights = strings.ReplaceAll(n.Rights, string(r), "")
			}
			if int(math.Abs(float64(a.To-from))) == 2 {
				corner, dest := from-4, from-1
				if a.To > from {
					corner, dest = from+3, from+1
				}
				n.Board[dest] = n.Board[corner]
				n.Board[corner] = ""
				v := []int{}
				for _, i := range n.Virgin {
					if i != corner {
						v = append(v, i)
					}
				}
				n.Virgin = v
			}
		}
		if captured != "" {
			n.Half = 0
		}
		for i, right := range map[int]string{0: "q", 7: "k", 56: "Q", 63: "K"} {
			if from == i || a.To == i {
				n.Rights = strings.ReplaceAll(n.Rights, right, "")
			}
		}
	}
	if s.Mode == "elixer" {
		n.Coins[s.Turn]++
	}
	n.Turn = 1 - s.Turn
	n.Ply++
	n.Last = &a
	return n
}
func LegalChess(s ChessPosition) []ChessAction {
	out := []ChessAction{}
	for _, a := range chessPseudo(s) {
		if !chessCheck(chessTransition(s, a), s.Turn) {
			out = append(out, a)
		}
	}
	return out
}
func chessPositionKey(s ChessPosition) string {
	ep := -1
	if s.EP >= 0 {
		zero := s
		zero.Coins = [2]int{}
		for _, a := range chessPseudo(zero) {
			if a.From != nil && a.To == s.EP && strings.ToLower(s.Board[*a.From]) == "p" && *a.From%8 != a.To%8 && !chessCheck(chessTransition(s, a), s.Turn) {
				ep = s.EP
				break
			}
		}
	}
	board := strings.Builder{}
	for _, p := range s.Board {
		if p == "" {
			p = "."
		}
		board.WriteString(p)
	}
	key := fmt.Sprintf("%s/%d/%s/%d", board.String(), s.Turn, s.Rights, ep)
	if s.Mode == "elixer" {
		v := append([]int{}, s.Virgin...)
		sort.Ints(v)
		parts := []string{}
		for _, i := range v {
			parts = append(parts, fmt.Sprint(i))
		}
		key += fmt.Sprintf("/%d,%d/%s", s.Coins[0], s.Coins[1], strings.Join(parts, ","))
	}
	return key
}
func chessAdvance(s ChessPosition, a ChessAction) ChessPosition {
	n := chessTransition(s, a)
	n.Repeats = append([]string{}, s.Repeats...)
	if n.Half == 0 && s.Mode == "standard" {
		n.Repeats = []string{}
	}
	n.Repeats = append(n.Repeats, chessPositionKey(n))
	if len(n.Repeats) > 1001 {
		n.Repeats = n.Repeats[len(n.Repeats)-1001:]
	}
	return n
}
func chessSame(a, b ChessAction) bool {
	from := a.From == nil && b.From == nil
	if a.From != nil && b.From != nil {
		from = *a.From == *b.From
	}
	return from && a.To == b.To && a.Buy == b.Buy && a.Promotion == b.Promotion
}
func ApplyChess(s ChessPosition, a ChessAction) ChessPosition {
	for _, legal := range LegalChess(s) {
		if chessSame(a, legal) {
			return chessAdvance(s, legal)
		}
	}
	Fail(400, "ILLEGAL_MOVE", "That move or purchase is not legal.")
	return s
}
func chessInsufficient(s ChessPosition) bool {
	if s.Mode != "standard" {
		return false
	}
	pieces := []int{}
	for i, p := range s.Board {
		if p != "" && strings.ToLower(p) != "k" {
			pieces = append(pieces, i)
		}
	}
	if len(pieces) == 0 {
		return true
	}
	if len(pieces) == 1 && strings.Contains("bn", strings.ToLower(s.Board[pieces[0]])) {
		return true
	}
	color := -1
	for _, i := range pieces {
		if strings.ToLower(s.Board[i]) != "b" {
			return false
		}
		c := (i%8 + i/8) % 2
		if color >= 0 && color != c {
			return false
		}
		color = c
	}
	return true
}
func chessRepetition(s ChessPosition) int {
	k := chessPositionKey(s)
	n := 0
	for _, v := range s.Repeats {
		if v == k {
			n++
		}
	}
	return n
}
func chessCanMate(s ChessPosition, color int) bool {
	own := []string{}
	other := 0
	for _, p := range s.Board {
		if p != "" && strings.ToLower(p) != "k" {
			if chessColor(p) == color {
				own = append(own, p)
			} else {
				other++
			}
		}
	}
	if len(own) == 0 {
		return false
	}
	if len(own) == 1 && strings.Contains("bn", strings.ToLower(own[0])) && other == 0 {
		return false
	}
	return !chessInsufficient(s)
}
func chessOutcome(s ChessPosition) any {
	if len(LegalChess(s)) == 0 {
		if chessCheck(s, s.Turn) {
			return chessWinner(1-s.Turn, "checkmate")
		}
		return "Draw by stalemate"
	}
	if chessInsufficient(s) {
		return "Draw by insufficient material"
	}
	if s.Mode == "standard" && (s.Half >= 150 || chessRepetition(s) >= 5) {
		return "Draw by automatic rule"
	}
	if s.Ply >= 1000 {
		return "Draw by game length limit"
	}
	return nil
}
func chessWinner(color int, reason string) string {
	c := "Black"
	if color == 0 {
		c = "White"
	}
	return c + " wins by " + reason
}
func chessAI(s ChessPosition, difficulty string) *ChessAction {
	actions := LegalChess(s)
	if len(actions) == 0 {
		return nil
	}
	if difficulty == "Easy" {
		a := actions[gameRandom(len(actions))]
		return &a
	}
	value := func(p ChessPosition) float64 {
		score := 0.
		for _, piece := range p.Board {
			if piece != "" {
				sign := 1.
				if chessColor(piece) == 1 {
					sign = -1
				}
				score += sign * float64(chessCosts[strings.ToLower(piece)])
			}
		}
		if s.Turn == 1 {
			score = -score
		}
		return score + float64(p.Coins[s.Turn]-p.Coins[1-s.Turn])*.12
	}
	hint := func(a ChessAction) float64 {
		if a.Buy != "" {
			return .2
		}
		if a.Promotion != "" {
			return float64(chessCosts[strings.ToLower(s.Board[a.To])]) + 8
		}
		return float64(chessCosts[strings.ToLower(s.Board[a.To])])
	}
	sort.SliceStable(actions, func(i, j int) bool { return hint(actions[i]) > hint(actions[j]) })
	best, score := actions[0], math.Inf(-1)
	deadline := time.Now().Add(8 * time.Millisecond)
	for i, a := range actions {
		if i > 0 && time.Now().After(deadline) {
			break
		}
		next := chessAdvance(s, a)
		v := value(next)
		if chessCheck(next, next.Turn) {
			v += .3
		}
		if difficulty == "Hard" && i < 12 {
			replies := LegalChess(next)
			sort.SliceStable(replies, func(i, j int) bool {
				return chessCosts[strings.ToLower(next.Board[replies[i].To])] > chessCosts[strings.ToLower(next.Board[replies[j].To])]
			})
			for j, r := range replies {
				if j >= 12 || time.Now().After(deadline) {
					break
				}
				v = math.Min(v, value(chessAdvance(next, r)))
			}
		}
		if v > score {
			best, score = a, v
		}
	}
	return &best
}
