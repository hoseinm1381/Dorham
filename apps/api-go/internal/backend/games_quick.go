package backend

import (
	"fmt"
	"strings"
)

const (
	quickRoundCount    = 5
	quickPickTime      = 20000
	quickRevealTime    = 5000
	quickWatchTime     = 6000
	quickPairTime      = 2000
	quickTurnTime      = 20000
	quickGridSize      = 5
	quickTreasureCount = 5
)

func isQuickGame(kind string) bool {
	switch kind {
	case "rps", "high-low", "target-dice", "odd-one", "color-sequence", "memory-match", "number-hunt", "treasure-grid":
		return true
	}
	return false
}

func quickRoundGame(kind string) bool {
	return kind != "memory-match" && kind != "number-hunt" && kind != "treasure-grid"
}

func quickStart(kind string, n int, now int64) M {
	s := M{
		"phase": "quick-turn", "deadline": now + quickTurnTime, "result": nil,
		"active": gameArray(n, true), "scores": gameArray(n, 0), "turn": 0, "idle": 0, "move": 0,
	}
	switch kind {
	case "memory-match":
		s["cards"] = gameShuffle(append(gameInts(12), gameInts(12)...))
		s["matched"], s["flipped"] = gameArray(24, false), []any{}
	case "number-hunt":
		s["low"], s["high"], s["secret"], s["last"] = 1, 50, gameRandom(50)+1, nil
	case "treasure-grid":
		s["treasures"] = gameShuffle(gameInts(quickGridSize * quickGridSize))[:quickTreasureCount]
		s["tiles"], s["remaining"], s["last"] = gameArray(quickGridSize*quickGridSize, nil), quickTreasureCount, -1
	default:
		quickNextRound(kind, s, now)
	}
	return s
}

func quickNextRound(kind string, s M, now int64) {
	round := gi(s["round"]) + 1
	n := len(Arr(s["active"]))
	s["round"], s["token"] = round, fmt.Sprintf("quick-%d", round)
	s["entries"], s["gains"], s["revealed"] = gameArray(n, nil), gameArray(n, 0), false
	s["phase"], s["deadline"] = "quick-pick", now+quickPickTime
	switch kind {
	case "high-low":
		ranks := gameShuffle(gameInts(13))
		s["rank"], s["answer"] = gi(ranks[0])+1, gi(ranks[1])+1
	case "target-dice":
		s["dice"] = []any{gameRandom(6) + 1, gameRandom(6) + 1}
	case "odd-one":
		kinds := gameShuffle(gameInts(8))
		symbols := gameArray(8+2*round, kinds[0])
		answer := gameRandom(len(symbols))
		symbols[answer] = kinds[1]
		s["symbols"], s["answer"] = symbols, answer
	case "color-sequence":
		sequence := make([]byte, round+2)
		for i := range sequence {
			sequence[i] = byte('1' + gameRandom(4))
		}
		s["sequence"] = string(sequence)
		s["phase"], s["deadline"] = "quick-watch", now+quickWatchTime
	}
}

func quickEnd(s M, result string) {
	s["phase"], s["deadline"], s["result"] = "ended", 0, result
}

func quickFinishScores(s M) {
	high, winner, tied := 0, -1, false
	scores := Arr(s["scores"])
	for i, active := range Arr(s["active"]) {
		if !B(active) {
			continue
		}
		score := gi(scores[i])
		if score > high {
			high, winner, tied = score, i, false
		} else if score == high {
			tied = true
		}
	}
	switch {
	case high == 0:
		quickEnd(s, "No points scored")
	case tied:
		quickEnd(s, "Game tied")
	default:
		quickEnd(s, fmt.Sprintf("Player %d wins", winner+1))
	}
}

func quickDiceScores(s M, entries, gains []any) {
	dice := Arr(s["dice"])
	base := gi(dice[0]) + gi(dice[1])
	rolls, totals := gameArray(len(entries), nil), gameArray(len(entries), nil)
	best := 0
	for i, entry := range entries {
		if entry == nil {
			continue
		}
		total := base
		if gi(entry) == 1 {
			roll := gameRandom(6) + 1
			rolls[i], total = roll, base+roll
		}
		totals[i] = total
		if total <= 12 {
			best = max(best, total)
		}
	}
	for i, total := range totals {
		if best > 0 && gi(total) == best {
			gains[i] = 1
		}
	}
	s["rolls"], s["totals"] = rolls, totals
}

func quickRevealRound(kind string, s M, now int64) {
	entries, gains := Arr(s["entries"]), Arr(s["gains"])
	for i, active := range Arr(s["active"]) {
		if !B(active) {
			entries[i] = nil
		}
	}
	if kind == "target-dice" {
		quickDiceScores(s, entries, gains)
	} else {
		for i, entry := range entries {
			if entry == nil {
				continue
			}
			switch kind {
			case "rps":
				wins := 0
				for _, other := range entries {
					if other != nil && (gi(entry)-gi(other)+3)%3 == 1 {
						wins++
					}
				}
				gains[i] = wins
			case "high-low":
				if (gi(entry) == 1) == (gi(s["answer"]) > gi(s["rank"])) {
					gains[i] = 1
				}
			case "odd-one":
				if gi(entry) == gi(s["answer"]) {
					gains[i] = 1
				}
			case "color-sequence":
				if S(entry) == S(s["sequence"]) {
					gains[i] = 1
				}
			}
		}
	}
	scores := Arr(s["scores"])
	for i, score := range scores {
		scores[i] = gi(score) + gi(gains[i])
	}
	s["revealed"] = true
	s["phase"], s["deadline"] = "quick-reveal", now+quickRevealTime
}

func quickEveryonePicked(s M) bool {
	entries := Arr(s["entries"])
	for i, active := range Arr(s["active"]) {
		if B(active) && entries[i] == nil {
			return false
		}
	}
	return true
}

func quickNextTurn(s M, now int64) {
	active := Arr(s["active"])
	turn := (gi(s["turn"]) + 1) % len(active)
	for !B(active[turn]) {
		turn = (turn + 1) % len(active)
	}
	s["turn"], s["phase"], s["deadline"] = turn, "quick-turn", now+quickTurnTime
}

func quickSkipTurn(s M, now int64) {
	count := 0
	for _, active := range Arr(s["active"]) {
		if B(active) {
			count++
		}
	}
	s["idle"] = gi(s["idle"]) + 1
	if gi(s["idle"]) >= count {
		quickEnd(s, "Game ended after inactivity")
	} else {
		quickNextTurn(s, now)
	}
}

func quickPickRound(kind string, s M, seat int, a M, now int64) {
	entries := Arr(s["entries"])
	gameInsist(S(s["phase"]) == "quick-pick" && S(a["token"]) == S(s["token"]) && entries[seat] == nil)
	if kind == "color-sequence" {
		sequence := S(a["text"])
		gameInsist(len(sequence) == len(S(s["sequence"])) && strings.Trim(sequence, "1234") == "")
		entries[seat] = sequence
	} else {
		limit := 1
		switch kind {
		case "rps":
			limit = 2
		case "odd-one":
			limit = len(Arr(s["symbols"])) - 1
		}
		entries[seat] = gameInt(a["choice"], 0, limit)
	}
	if quickEveryonePicked(s) {
		quickRevealRound(kind, s, now)
	}
}

func quickFlipCard(s M, seat int, a M, now int64) {
	cards, matched, flipped := Arr(s["cards"]), Arr(s["matched"]), Arr(s["flipped"])
	choice := gameInt(a["choice"], 0, len(cards)-1)
	gameInsist(!B(matched[choice]) && !gameContains(flipped, choice))
	flipped = append(flipped, choice)
	s["flipped"] = flipped
	if len(flipped) == 2 {
		first := gi(flipped[0])
		if gi(cards[first]) == gi(cards[choice]) {
			matched[first], matched[choice] = true, true
			quickPoint(s, seat)
		}
		s["phase"], s["deadline"] = "quick-pair", now+quickPairTime
	}
}

func quickPoint(s M, seat int) {
	scores := Arr(s["scores"])
	scores[seat] = gi(scores[seat]) + 1
}

func quickGuessNumber(s M, seat int, a M, now int64) {
	choice := gameInt(a["choice"], gi(s["low"]), gi(s["high"]))
	hint := "found"
	switch secret := gi(s["secret"]); {
	case choice < secret:
		hint, s["low"] = "higher", choice+1
		quickNextTurn(s, now)
	case choice > secret:
		hint, s["high"] = "lower", choice-1
		quickNextTurn(s, now)
	default:
		quickPoint(s, seat)
		quickEnd(s, fmt.Sprintf("Player %d wins", seat+1))
	}
	s["last"] = M{"seat": seat, "choice": choice, "hint": hint}
}

func quickDig(s M, seat int, a M, now int64) {
	tiles, treasures := Arr(s["tiles"]), Arr(s["treasures"])
	choice := gameInt(a["choice"], 0, len(tiles)-1)
	gameInsist(tiles[choice] == nil)
	s["last"] = choice
	if gameContains(treasures, choice) {
		tiles[choice] = -1
		quickPoint(s, seat)
		s["remaining"] = gi(s["remaining"]) - 1
	} else {
		neighbors := 0
		row, col := choice/quickGridSize, choice%quickGridSize
		for _, item := range treasures {
			tile := gi(item)
			tr, tc := tile/quickGridSize, tile%quickGridSize
			if tr >= row-1 && tr <= row+1 && tc >= col-1 && tc <= col+1 {
				neighbors++
			}
		}
		tiles[choice] = neighbors
	}
	if gi(s["remaining"]) == 0 {
		quickFinishScores(s)
	} else {
		quickNextTurn(s, now)
	}
}

func quickAction(kind string, s M, seat int, a M, now int64) {
	active := Arr(s["active"])
	gameInsist(S(a["type"]) == "quick-pick" && seat >= 0 && seat < len(active) && B(active[seat]))
	if quickRoundGame(kind) {
		quickPickRound(kind, s, seat, a, now)
		return
	}
	gameInsist(S(s["phase"]) == "quick-turn" && gi(s["turn"]) == seat)
	switch kind {
	case "memory-match":
		quickFlipCard(s, seat, a, now)
	case "number-hunt":
		quickGuessNumber(s, seat, a, now)
	case "treasure-grid":
		quickDig(s, seat, a, now)
	}
	s["idle"], s["move"] = 0, gi(s["move"])+1
}

func quickTimeout(kind string, s M, now int64) {
	switch S(s["phase"]) {
	case "quick-watch":
		s["phase"], s["deadline"] = "quick-pick", now+quickPickTime
	case "quick-pick":
		quickRevealRound(kind, s, now)
	case "quick-reveal":
		if gi(s["round"]) >= quickRoundCount {
			quickFinishScores(s)
		} else {
			quickNextRound(kind, s, now)
		}
	case "quick-pair":
		s["flipped"] = []any{}
		for _, matched := range Arr(s["matched"]) {
			if !B(matched) {
				quickNextTurn(s, now)
				return
			}
		}
		quickFinishScores(s)
	case "quick-turn":
		if kind == "memory-match" {
			s["flipped"] = []any{}
		}
		quickSkipTurn(s, now)
	}
}

func quickDepart(kind string, s M, seat int, now int64) {
	if S(s["phase"]) == "quick-pick" && quickEveryonePicked(s) {
		quickRevealRound(kind, s, now)
	}
	if S(s["phase"]) == "quick-turn" && gi(s["turn"]) == seat {
		if kind == "memory-match" {
			s["flipped"] = []any{}
		}
		quickNextTurn(s, now)
	}
}

func quickRoundProject(kind string, s M, seat int, view M) {
	entries, active := Arr(s["entries"]), Arr(s["active"])
	submitted := make([]any, len(entries))
	for i, entry := range entries {
		submitted[i] = B(active[i]) && entry != nil
	}
	view["round"], view["roundCount"], view["token"] = s["round"], quickRoundCount, s["token"]
	view["submitted"], view["ownEntry"] = submitted, nil
	if seat >= 0 && seat < len(entries) {
		view["ownEntry"] = entries[seat]
	}
	reveal := B(s["revealed"])
	if reveal {
		view["entries"], view["gains"] = entries, s["gains"]
	}
	switch kind {
	case "high-low":
		view["rank"] = s["rank"]
		if reveal {
			view["answer"] = s["answer"]
		}
	case "target-dice":
		view["dice"] = s["dice"]
		if reveal {
			view["rolls"], view["totals"] = s["rolls"], s["totals"]
		}
	case "odd-one":
		view["symbols"] = s["symbols"]
		if reveal {
			view["answer"] = s["answer"]
		}
	case "color-sequence":
		view["length"] = len(S(s["sequence"]))
		if reveal || S(s["phase"]) == "quick-watch" {
			view["sequence"] = s["sequence"]
		}
	}
}

func quickProject(kind string, s M, seat int) M {
	view := M{"phase": s["phase"], "scores": s["scores"]}
	if quickRoundGame(kind) {
		quickRoundProject(kind, s, seat, view)
		return view
	}
	view["turn"], view["move"] = s["turn"], s["move"]
	switch kind {
	case "memory-match":
		cards, matched, flipped := Arr(s["cards"]), Arr(s["matched"]), Arr(s["flipped"])
		shown := gameArray(len(cards), nil)
		for i, card := range cards {
			if B(matched[i]) || gameContains(flipped, i) {
				shown[i] = card
			}
		}
		view["cards"], view["matched"], view["flipped"] = shown, matched, flipped
	case "number-hunt":
		view["low"], view["high"], view["last"] = s["low"], s["high"], s["last"]
	case "treasure-grid":
		view["tiles"], view["remaining"], view["last"] = s["tiles"], s["remaining"], s["last"]
	}
	return view
}
