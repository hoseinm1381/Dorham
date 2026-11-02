package backend

import "fmt"

func fourAction(s M, seat int, a M, now int64) {
	gameInsist(S(s["phase"]) == "turn" && seat == gi(s["turn"]) && S(a["type"]) == "drop")
	col := gameInt(a["column"], 0, 6)
	board := Arr(s["board"])
	row := 5
	for row >= 0 && gi(board[row*7+col]) != -1 {
		row--
	}
	gameInsist(row >= 0, "That column is full.")
	index := row*7 + col
	board[index] = seat
	s["moves"] = gi(s["moves"]) + 1
	s["last"] = index
	for _, v := range [][2]int{{1, 0}, {0, 1}, {1, 1}, {1, -1}} {
		line := []any{index}
		for _, sign := range []int{-1, 1} {
			for d := 1; d < 4; d++ {
				x, y := col+v[0]*d*sign, row+v[1]*d*sign
				if x < 0 || x > 6 || y < 0 || y > 5 || gi(board[y*7+x]) != seat {
					break
				}
				line = append(line, y*7+x)
			}
		}
		if len(line) >= 4 {
			s["result"] = fmt.Sprintf("Player %d wins", seat+1)
			s["phase"] = "ended"
			s["winner"] = seat
			s["winning"] = line
		}
	}
	if s["result"] == nil && gi(s["moves"]) == 42 {
		s["result"] = "Draw"
		s["phase"] = "ended"
	}
	s["turn"] = 1 - seat
	s["deadline"] = now + 60000
	if s["result"] != nil {
		s["deadline"] = 0
	}
}

var dominoTiles = func() [][2]int {
	r := [][2]int{}
	for a := 0; a <= 6; a++ {
		for b := a; b <= 6; b++ {
			r = append(r, [2]int{a, b})
		}
	}
	return r
}()

func dominoRound(s M, n int, now int64) {
	deck := gameShuffle(gameInts(28))
	hands := []any{}
	active := Arr(s["active"])
	for i := 0; i < n; i++ {
		if len(active) > i && !B(active[i]) {
			hands = append(hands, []any{})
		} else {
			hands = append(hands, append([]any{}, deck[:7]...))
			deck = deck[7:]
		}
	}
	s["hands"] = hands
	s["boneyard"] = deck
	s["chain"] = []any{}
	s["passes"] = 0
	s["phase"] = "turn"
	s["roundResult"] = nil
	s["opening"] = -1
	dominoOpening(s)
	s["deadline"] = now + 60000
	s["round"] = gi(s["round"]) + 1
}
func dominoOpening(s M) {
	best, leader := -1, 0
	s["opening"] = -1
	active := Arr(s["active"])
	for p, h := range Arr(s["hands"]) {
		if len(active) > p && !B(active[p]) {
			continue
		}
		for _, t := range Arr(h) {
			pair := dominoTiles[gi(t)]
			w := pair[0] + pair[1]
			if pair[0] == pair[1] {
				w = 100 + pair[0]
			}
			if w > best {
				best, leader = w, p
				s["opening"] = gi(t)
			}
		}
	}
	s["turn"] = leader
	s["passes"] = 0
}
func dominoLegal(s M, seat int) []any {
	out := []any{}
	hands := Arr(s["hands"])
	if seat < 0 || seat >= len(hands) {
		return out
	}
	chain := Arr(s["chain"])
	for _, tile := range Arr(hands[seat]) {
		if len(chain) == 0 {
			if gi(tile) == gi(s["opening"]) {
				out = append(out, M{"tile": tile, "end": "right"})
			}
			continue
		}
		left, right := gi(Arr(chain[0])[0]), gi(Arr(chain[len(chain)-1])[1])
		pair := dominoTiles[gi(tile)]
		if pair[0] == left || pair[1] == left {
			out = append(out, M{"tile": tile, "end": "left"})
		}
		if pair[0] == right || pair[1] == right {
			out = append(out, M{"tile": tile, "end": "right"})
		}
	}
	return out
}
func dominoScore(s M, now int64) {
	hands, active := Arr(s["hands"]), Arr(s["active"])
	sums := make([]int, len(hands))
	low := 100000
	for i, h := range hands {
		for _, t := range Arr(h) {
			p := dominoTiles[gi(t)]
			sums[i] += p[0] + p[1]
		}
		if (len(active) <= i || B(active[i])) && sums[i] < low {
			low = sums[i]
		}
	}
	winners := []int{}
	for i, v := range sums {
		if v == low && (len(active) <= i || B(active[i])) {
			winners = append(winners, i)
		}
	}
	s["roundResult"] = "Round drawn"
	s["phase"] = "between"
	if len(winners) == 1 {
		w := winners[0]
		s["roundResult"] = fmt.Sprintf("Player %d wins the round", w+1)
		scores := Arr(s["scores"])
		sum := 0
		for i, v := range sums {
			if i != w {
				sum += v
			}
		}
		scores[w] = gi(scores[w]) + sum
		if gi(scores[w]) >= 100 {
			s["result"] = fmt.Sprintf("Player %d wins", w+1)
			s["phase"] = "ended"
		}
	}
	s["deadline"] = now + 300000
}
func dominoAction(s M, seat int, a M, now int64) {
	kind := S(a["type"])
	if kind == "next" {
		gameInsist(S(s["phase"]) == "between")
		dominoRound(s, len(Arr(s["hands"])), now)
		return
	}
	gameInsist(S(s["phase"]) == "turn" && seat == gi(s["turn"]), "Wait for your turn.")
	legal := dominoLegal(s, seat)
	hands := Arr(s["hands"])
	if kind == "draw" {
		yard := Arr(s["boneyard"])
		gameInsist(S(s["mode"]) == "draw" && len(legal) == 0 && len(yard) > 0, "You must play an available tile.")
		hands[seat] = append(Arr(hands[seat]), yard[len(yard)-1])
		s["boneyard"] = yard[:len(yard)-1]
		s["deadline"] = now + 60000
		return
	}
	if kind == "pass" {
		gameInsist(len(legal) == 0 && (S(s["mode"]) == "block" || len(Arr(s["boneyard"])) == 0), "Play or draw a tile first.")
		s["passes"] = gi(s["passes"]) + 1
	} else {
		gameInsist(kind == "tile")
		tile := gameInt(a["tile"], 0, 27)
		valid := false
		for _, v := range legal {
			m := Obj(v)
			if gi(m["tile"]) == tile && S(m["end"]) == S(a["end"]) {
				valid = true
			}
		}
		gameInsist(valid, "That tile does not fit.")
		p := dominoTiles[tile]
		chain := Arr(s["chain"])
		if len(chain) > 0 {
			if S(a["end"]) == "left" {
				if p[1] != gi(Arr(chain[0])[0]) {
					p[0], p[1] = p[1], p[0]
				}
			} else if p[0] != gi(Arr(chain[len(chain)-1])[1]) {
				p[0], p[1] = p[1], p[0]
			}
		}
		pair := []any{p[0], p[1]}
		if S(a["end"]) == "left" {
			s["chain"] = append([]any{pair}, chain...)
		} else {
			s["chain"] = append(chain, pair)
		}
		hands[seat] = gameRemove(Arr(hands[seat]), tile)
		s["passes"] = 0
	}
	count := 0
	for _, v := range Arr(s["active"]) {
		if B(v) {
			count++
		}
	}
	if count == 0 {
		count = len(hands)
	}
	if len(Arr(hands[seat])) == 0 || gi(s["passes"]) >= count {
		dominoScore(s, now)
	} else {
		turn := gi(s["turn"])
		for {
			turn = (turn + 1) % len(hands)
			active := Arr(s["active"])
			if len(active) <= turn || B(active[turn]) {
				break
			}
		}
		s["turn"] = turn
		s["deadline"] = now + 60000
	}
}
func dominoView(s M, seat int) M {
	hands := Arr(s["hands"])
	hand := []any{}
	if seat >= 0 {
		hand = Arr(hands[seat])
	}
	counts := []any{}
	for _, h := range hands {
		counts = append(counts, len(Arr(h)))
	}
	legal := []any{}
	if S(s["phase"]) == "turn" && seat == gi(s["turn"]) {
		legal = dominoLegal(s, seat)
	}
	return M{"phase": s["phase"], "turn": s["turn"], "chain": s["chain"], "hand": hand, "counts": counts, "boneyard": len(Arr(s["boneyard"])), "scores": s["scores"], "round": s["round"], "roundResult": s["roundResult"], "legal": legal, "mode": s["mode"]}
}
func ludoOffset(s M, seat int) int {
	if len(Arr(s["tokens"])) == 2 {
		return seat * 26
	}
	return seat * 13
}
func ludoNext(s M, seat int) int {
	n := len(Arr(s["tokens"]))
	active := Arr(s["active"])
	for i := 1; i <= n; i++ {
		p := (seat + i) % n
		if len(active) <= p || B(active[p]) {
			return p
		}
	}
	return seat
}
func ludoLegal(s M) []any {
	out := []any{}
	for i, v := range Arr(Arr(s["tokens"])[gi(s["turn"])]) {
		value, die := gi(v), gi(s["die"])
		if (value == -1 && die == 6) || (value >= 0 && value < 56 && value+die <= 56) {
			out = append(out, i)
		}
	}
	return out
}
func ludoAction(s M, seat int, a M, now int64, roll func() int) {
	gameInsist(seat == gi(s["turn"]), "Wait for your turn.")
	if S(a["type"]) == "roll" {
		gameInsist(S(s["phase"]) == "roll")
		die := roll()
		s["die"] = die
		s["rolls"] = gi(s["rolls"]) + 1
		previous := gi(s["sixes"])
		s["sixes"] = 0
		if die == 6 {
			s["sixes"] = previous + 1
		}

		if gi(s["sixes"]) == 3 {
			s["turn"] = ludoNext(s, seat)
			s["sixes"] = 0
			s["phase"] = "roll"
		} else if len(ludoLegal(s)) > 0 {
			s["phase"] = "move"
		} else {
			s["turn"] = ludoNext(s, seat)
			s["sixes"] = 0
		}
	} else {
		gameInsist(S(a["type"]) == "token" && S(s["phase"]) == "move")
		token := gameInt(a["piece"], 0, 3)
		gameInsist(gameContains(ludoLegal(s), token), "That token cannot move.")
		tokens := Arr(s["tokens"])
		hand := Arr(tokens[seat])
		value := gi(hand[token])
		if value == -1 {
			value = 0
		} else {
			value += gi(s["die"])
		}
		hand[token] = value
		if value < 51 {
			cell := (value + ludoOffset(s, seat)) % 52
			safe := map[int]bool{0: true, 8: true, 13: true, 21: true, 26: true, 34: true, 39: true, 47: true}
			if !safe[cell] {
				for p, h := range tokens {
					if p == seat {
						continue
					}
					for i, v := range Arr(h) {
						n := gi(v)
						if n >= 0 && n < 51 && (n+ludoOffset(s, p))%52 == cell {
							Arr(h)[i] = -1
						}
					}
				}
			}
		}
		won := true
		for _, v := range hand {
			if gi(v) != 56 {
				won = false
			}
		}
		if won {
			s["result"] = fmt.Sprintf("Player %d wins", seat+1)
			s["phase"] = "ended"
			s["winner"] = seat
		} else {
			s["phase"] = "roll"
			if gi(s["die"]) != 6 {
				s["turn"] = ludoNext(s, seat)
				s["sixes"] = 0
			}
		}
	}
	s["deadline"] = now + 60000
	if s["result"] != nil {
		s["deadline"] = 0
	}
}
