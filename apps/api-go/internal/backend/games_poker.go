package backend

import (
	"fmt"
	"sort"
	"strings"
)

func pokerRankFive(cards []int) []int {
	ranks := []int{}
	counts := map[int]int{}
	flush := true
	for _, c := range cards {
		r := c%13 + 2
		ranks = append(ranks, r)
		counts[r]++
		if c/13 != cards[0]/13 {
			flush = false
		}
	}
	sort.Sort(sort.Reverse(sort.IntSlice(ranks)))
	groups := [][2]int{}
	for r, n := range counts {
		groups = append(groups, [2]int{r, n})
	}
	sort.Slice(groups, func(i, j int) bool {
		if groups[i][1] != groups[j][1] {
			return groups[i][1] > groups[j][1]
		}
		return groups[i][0] > groups[j][0]
	})
	straight := 0
	if len(counts) == 5 {
		if ranks[0]-ranks[4] == 4 {
			straight = ranks[0]
		} else if ranks[0] == 14 && ranks[1] == 5 && ranks[2] == 4 && ranks[3] == 3 && ranks[4] == 2 {
			straight = 5
		}
	}
	if flush && straight > 0 {
		return []int{8, straight}
	}
	if groups[0][1] == 4 {
		return []int{7, groups[0][0], groups[1][0]}
	}
	if groups[0][1] == 3 && groups[1][1] == 2 {
		return []int{6, groups[0][0], groups[1][0]}
	}
	if flush {
		return append([]int{5}, ranks...)
	}
	if straight > 0 {
		return []int{4, straight}
	}
	if groups[0][1] == 3 {
		return []int{3, groups[0][0], groups[1][0], groups[2][0]}
	}
	if groups[0][1] == 2 && groups[1][1] == 2 {
		return []int{2, groups[0][0], groups[1][0], groups[2][0]}
	}
	if groups[0][1] == 2 {
		return []int{1, groups[0][0], groups[1][0], groups[2][0], groups[3][0]}
	}
	return append([]int{0}, ranks...)
}
func pokerCompare(a, b []int) int {
	n := len(a)
	if len(b) > n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		x, y := 0, 0
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y {
			return x - y
		}
	}
	return 0
}
func pokerRank(cards []any) []int {
	gameInsist(len(cards) >= 5 && len(cards) <= 7)
	seen := map[int]bool{}
	c := []int{}
	for _, v := range cards {
		n := gi(v)
		gameInsist(n >= 0 && n < 52 && !seen[n])
		seen[n] = true
		c = append(c, n)
	}
	best := []int{}
	for a := 0; a < len(c)-4; a++ {
		for b := a + 1; b < len(c)-3; b++ {
			for d := b + 1; d < len(c)-2; d++ {
				for e := d + 1; e < len(c)-1; e++ {
					for f := e + 1; f < len(c); f++ {
						r := pokerRankFive([]int{c[a], c[b], c[d], c[e], c[f]})
						if pokerCompare(r, best) > 0 {
							best = r
						}
					}
				}
			}
		}
	}
	return best
}
func pokerLive(s M) []any {
	out := []any{}
	dep := Arr(s["departed"])
	for i, v := range Arr(s["stack"]) {
		if gi(v) > 0 && !B(dep[i]) {
			out = append(out, i)
		}
	}
	return out
}
func pokerMinimum(s M) int {
	if gi(s["bet"]) < gi(s["blind"]) {
		return gi(s["blind"])
	}
	return gi(s["bet"]) + gi(s["lastRaise"])
}
func pokerAfter(s M, p int, available []any) int {
	for i := 1; i <= len(Arr(s["stack"])); i++ {
		q := (p + i) % len(Arr(s["stack"]))
		if gameContains(available, q) {
			return q
		}
	}
	return -1
}
func pokerPay(s M, p, amount int) {
	stack, street, committed := Arr(s["stack"]), Arr(s["street"]), Arr(s["committed"])
	paid := amount
	if gi(stack[p]) < paid {
		paid = gi(stack[p])
	}
	stack[p] = gi(stack[p]) - paid
	street[p] = gi(street[p]) + paid
	committed[p] = gi(committed[p]) + paid
}
func pokerLog(s M, msg string) { s["log"] = gameTail(append(Arr(s["log"]), msg), 60) }
func pokerFinish(s M, now int64, showdown bool) {
	stack, folded, committed := Arr(s["stack"]), Arr(s["folded"]), Arr(s["committed"])
	contenders := []any{}
	levels := []int{}
	for i, v := range stack {
		_ = v
		if !B(folded[i]) {
			contenders = append(contenders, i)
		}
		level := gi(committed[i])
		if level > 0 {
			found := false
			for _, l := range levels {
				if l == level {
					found = true
				}
			}
			if !found {
				levels = append(levels, level)
			}
		}
	}
	sort.Ints(levels)
	payouts := gameArray(len(stack), 0)
	ranks := map[int][]int{}
	if showdown {
		for _, p := range contenders {
			i := gi(p)
			ranks[i] = pokerRank(append(append([]any{}, Arr(Arr(s["holes"])[i])...), Arr(s["board"])...))
		}
	}
	pots := []any{}
	previous := 0
	for _, level := range levels {
		contributors, eligible := []any{}, []any{}
		for i, n := range committed {
			if gi(n) >= level {
				contributors = append(contributors, i)
				if gameContains(contenders, i) {
					eligible = append(eligible, i)
				}
			}
		}
		amount := (level - previous) * len(contributors)
		previous = level
		if len(contributors) == 1 {
			p := gi(contributors[0])
			payouts[p] = gi(payouts[p]) + amount
			continue
		}
		if len(eligible) == 0 {
			for _, p := range contributors {
				i := gi(p)
				payouts[i] = gi(payouts[i]) + amount/len(contributors)
			}
			continue
		}
		if showdown {
			best := ranks[gi(eligible[0])]
			for _, p := range eligible {
				if pokerCompare(ranks[gi(p)], best) > 0 {
					best = ranks[gi(p)]
				}
			}
			w := []any{}
			for _, p := range eligible {
				if pokerCompare(ranks[gi(p)], best) == 0 {
					w = append(w, p)
				}
			}
			eligible = w
		}
		share := amount / len(eligible)
		for _, p := range eligible {
			i := gi(p)
			payouts[i] = gi(payouts[i]) + share
		}
		odd, p := amount-share*len(eligible), gi(s["dealer"])
		for ; odd > 0; odd-- {
			p = pokerAfter(s, p, eligible)
			payouts[p] = gi(payouts[p]) + 1
		}
		pots = append(pots, M{"amount": amount, "winners": eligible})
	}
	result := []string{}
	for i, n := range stack {
		stack[i] = gi(n) + gi(payouts[i])
		if gi(payouts[i]) > 0 {
			result = append(result, fmt.Sprintf("Player %d: +%d", i+1, gi(payouts[i])))
		}
	}
	s["payouts"] = payouts
	s["pots"] = pots
	s["showdown"] = showdown
	s["phase"] = "between"
	s["deadline"] = now + 300000
	s["turn"] = -1
	s["handResult"] = strings.Join(result, " · ")
	live := pokerLive(s)
	if len(live) <= 1 {
		s["phase"] = "ended"
		s["result"] = "Table closed"
		if len(live) > 0 {
			s["result"] = fmt.Sprintf("Player %d wins", gi(live[0])+1)
		}
		s["deadline"] = 0
	}
}
func pokerAdvance(s M, now int64) {
	stack, folded := Arr(s["stack"]), Arr(s["folded"])
	contenders, able, needed := []any{}, []any{}, []any{}
	for i := range stack {
		if !B(folded[i]) {
			contenders = append(contenders, i)
			if gi(stack[i]) > 0 {
				able = append(able, i)
				if !B(Arr(s["acted"])[i]) || gi(Arr(s["street"])[i]) < gi(s["bet"]) {
					needed = append(needed, i)
				}
			}
		}
	}
	if len(contenders) <= 1 {
		pokerFinish(s, now, false)
		return
	}
	if len(needed) > 0 && (len(able) > 1 || gi(Arr(s["street"])[gi(able[0])]) < gi(s["bet"])) {
		s["turn"] = pokerAfter(s, gi(s["turn"]), needed)
		s["deadline"] = now + 30000
		return
	}
	board := Arr(s["board"])
	if len(board) == 5 {
		pokerFinish(s, now, true)
		return
	}
	deck := Arr(s["deck"])
	deck = deck[:len(deck)-1]
	count := 1
	if len(board) == 0 {
		count = 3
	}
	for i := 0; i < count; i++ {
		board = append(board, deck[len(deck)-1])
		deck = deck[:len(deck)-1]
	}
	s["deck"] = deck
	s["board"] = board
	s["street"] = gameArray(len(stack), 0)
	s["acted"] = gameArray(len(stack), false)
	s["reopen"] = gameArray(len(stack), 0)
	s["bet"] = 0
	s["lastRaise"] = s["blind"]
	if len(able) <= 1 {
		pokerAdvance(s, now)
		return
	}
	s["turn"] = pokerAfter(s, gi(s["dealer"]), able)
	s["deadline"] = now + 30000
}
func pokerHand(s M, now int64) {
	seats := pokerLive(s)
	gameInsist(len(seats) >= 2, "Two players with chips are required.")
	s["dealer"] = pokerAfter(s, gi(s["dealer"]), seats)
	s["hand"] = gi(s["hand"]) + 1
	deck := gameShuffle(gameInts(52))
	stack := Arr(s["stack"])
	holes, folded := []any{}, []any{}
	for i, v := range stack {
		holes = append(holes, []any{})
		folded = append(folded, gi(v) == 0 || B(Arr(s["departed"])[i]))
	}
	s["board"] = []any{}
	s["holes"] = holes
	s["folded"] = folded
	s["street"] = gameArray(len(stack), 0)
	s["committed"] = gameArray(len(stack), 0)
	s["acted"] = gameArray(len(stack), false)
	s["reopen"] = gameArray(len(stack), 0)
	s["log"] = []any{}
	s["pots"] = []any{}
	s["payouts"] = []any{}
	s["showdown"] = false
	s["handResult"] = nil
	s["phase"] = "betting"
	s["result"] = nil
	p := gi(s["dealer"])
	for r := 0; r < 2; r++ {
		for range seats {
			p = pokerAfter(s, p, seats)
			holes[p] = append(Arr(holes[p]), deck[len(deck)-1])
			deck = deck[:len(deck)-1]
		}
	}
	s["deck"] = deck
	small := gi(s["dealer"])
	if len(seats) != 2 {
		small = pokerAfter(s, small, seats)
	}
	big := pokerAfter(s, small, seats)
	pokerPay(s, small, gi(s["blind"])/2)
	pokerPay(s, big, gi(s["blind"]))
	s["bet"] = s["blind"]
	s["lastRaise"] = s["blind"]
	s["turn"] = big
	s["deadline"] = now + 30000
	pokerAdvance(s, now)
}
func pokerStart(n int, settings M, now int64) M {
	s := M{"phase": "between", "deadline": 0, "result": nil, "stack": gameArray(n, settings["chips"]), "departed": gameArray(n, false), "blind": settings["blind"], "dealer": -1, "hand": 0}
	pokerHand(s, now)
	return s
}
func pokerJoin(s, settings M, index int) {
	gameInsist(S(s["phase"]) == "between")
	for k, v := range (M{"stack": settings["chips"], "departed": false, "holes": []any{}, "folded": true, "street": 0, "committed": 0, "acted": false, "reopen": 0, "payouts": 0}) {
		a := Arr(s[k])
		for len(a) <= index {
			a = append(a, nil)
		}
		a[index] = v
		s[k] = a
	}
}
func pokerAction(s M, seat int, a M, now int64) {
	kind := S(a["type"])
	if kind == "next" {
		gameInsist(S(s["phase"]) == "between")
		pokerHand(s, now)
		return
	}
	stack, street, acted, reopen := Arr(s["stack"]), Arr(s["street"]), Arr(s["acted"]), Arr(s["reopen"])
	gameInsist(S(s["phase"]) == "betting" && gi(s["turn"]) == seat && !B(Arr(s["folded"])[seat]) && gi(stack[seat]) > 0, "Wait for your turn.")
	owed := gi(s["bet"]) - gi(street[seat])
	if owed < 0 {
		owed = 0
	}
	switch kind {
	case "fold":
		Arr(s["folded"])[seat] = true
		pokerLog(s, fmt.Sprintf("Player %d folded", seat+1))
	case "check":
		gameInsist(owed == 0, "Call or fold.")
		pokerLog(s, fmt.Sprintf("Player %d checked", seat+1))
	case "call":
		gameInsist(owed > 0, "You can check.")
		pokerPay(s, seat, owed)
		pokerLog(s, fmt.Sprintf("Player %d called", seat+1))
	default:
		gameInsist(kind == "raise")
		to := gameInt(a["to"], gi(s["bet"])+1, gi(street[seat])+gi(stack[seat]))
		gameInsist(!B(acted[seat]) || gi(s["bet"]) >= gi(reopen[seat]), "A short all-in did not reopen raising.")
		increase := to - gi(s["bet"])
		if gi(s["bet"]) < gi(s["blind"]) {
			increase = to
		}
		full := to >= pokerMinimum(s)
		gameInsist(full || to == gi(street[seat])+gi(stack[seat]), "Raise at least the minimum, or go all-in.")
		pokerPay(s, seat, to-gi(street[seat]))
		s["bet"] = to
		if full {
			s["lastRaise"] = increase
			for i := range acted {
				acted[i] = false
			}
		}
		pokerLog(s, fmt.Sprintf("Player %d raised to %d", seat+1, to))
	}
	acted[seat] = true
	reopen[seat] = gi(s["bet"]) + gi(s["lastRaise"])
	pokerAdvance(s, now)
}
func pokerView(s M, seat int) M {
	acting := seat >= 0 && S(s["phase"]) == "betting" && gi(s["turn"]) == seat
	holes, ranks := []any{}, []any{}
	for i, h := range Arr(s["holes"]) {
		hand := Arr(h)
		visible := i == seat || (B(s["showdown"]) && !B(Arr(s["folded"])[i]))
		if visible {
			holes = append(holes, hand)
		} else {
			holes = append(holes, gameArray(len(hand), -1))
		}
		if len(hand) == 2 && len(Arr(s["board"])) >= 3 && visible {
			ranks = append(ranks, pokerRank(append(append([]any{}, hand...), Arr(s["board"])...))[0])
		} else {
			ranks = append(ranks, nil)
		}
	}
	var controls any
	if acting {
		street, stack, bet := gi(Arr(s["street"])[seat]), gi(Arr(s["stack"])[seat]), gi(s["bet"])
		call := bet - street
		if call < 0 {
			call = 0
		}
		amount := call
		if amount > stack {
			amount = stack
		}
		controls = M{"call": amount, "canCheck": call == 0, "canRaise": street+stack > bet && (!B(Arr(s["acted"])[seat]) || bet >= gi(Arr(s["reopen"])[seat])), "minRaise": pokerMinimum(s), "maxRaise": street + stack}
	}
	return M{"phase": s["phase"], "stack": s["stack"], "departed": s["departed"], "board": s["board"], "holes": holes, "handRanks": ranks, "folded": s["folded"], "street": s["street"], "committed": s["committed"], "dealer": s["dealer"], "turn": s["turn"], "hand": s["hand"], "blind": s["blind"], "bet": s["bet"], "pots": s["pots"], "payouts": s["payouts"], "handResult": s["handResult"], "log": s["log"], "controls": controls}
}
func pokerTimeout(s M, now int64) {
	kind := "fold"
	if gi(Arr(s["street"])[gi(s["turn"])]) >= gi(s["bet"]) {
		kind = "check"
	}
	pokerAction(s, gi(s["turn"]), M{"type": kind}, now)
}
func pokerDepart(s M, seat int, now int64) {
	Arr(s["departed"])[seat] = true
	folded := Arr(s["folded"])
	folded[seat] = true
	n := 0
	for _, v := range folded {
		if !B(v) {
			n++
		}
	}
	if S(s["phase"]) == "betting" && (gi(s["turn"]) == seat || n <= 1) {
		pokerAdvance(s, now)
	} else if S(s["phase"]) == "between" && len(pokerLive(s)) < 2 {
		s["phase"] = "ended"
		s["result"] = "Table closed"
		if live := pokerLive(s); len(live) > 0 {
			s["result"] = fmt.Sprintf("Player %d wins", gi(live[0])+1)
		}
		s["deadline"] = 0
	}
}
