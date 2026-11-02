package backend

import (
	"fmt"
	"strings"
	"unicode"
)

func drawingTurn(s, settings M, now int64) {
	order, active := Arr(s["order"]), Arr(s["active"])
	round := gi(s["round"])
	for round < len(order) && len(active) > gi(order[round]) && !B(active[gi(order[round])]) {
		round++
	}
	s["round"] = round
	if round >= len(order) {
		s["phase"] = "ended"
		s["result"] = "Drawing rounds complete"
		s["deadline"] = 0
		return
	}
	words := Arr(s["words"])
	s["drawer"] = order[round]
	s["word"] = words[round%len(words)]
	s["picture"] = gamePicture()
	s["guessed"] = []any{}
	s["guesses"] = []any{}
	s["phase"] = "drawing"
	s["token"] = fmt.Sprintf("draw-%d", round)
	s["started"] = now
	s["deadline"] = now + N(settings["seconds"])*1000
}
func drawingReveal(s M, now int64) {
	s["phase"] = "reveal"
	s["token"] = fmt.Sprintf("reveal-%d", gi(s["round"]))
	s["deadline"] = now + 5000
}
func drawingEveryone(s M, now int64) {
	if S(s["phase"]) != "drawing" {
		return
	}
	active := Arr(s["active"])
	for i := range Arr(s["scores"]) {
		if i != gi(s["drawer"]) && (len(active) <= i || B(active[i])) && !gameContains(Arr(s["guessed"]), i) {
			return
		}
	}
	drawingReveal(s, now)
}
func drawingAction(s M, seat int, a, settings M, now int64) {
	gameInsist(S(s["phase"]) == "drawing" && S(a["token"]) == S(s["token"]), "The drawing round has changed.")
	kind := S(a["type"])
	if kind == "stroke" || kind == "clear" || kind == "undo" {
		gameInsist(seat == gi(s["drawer"]), "Only the drawer can draw.")
		if kind == "clear" {
			s["picture"] = gamePicture()
		} else if kind == "undo" {
			gameUndo(Obj(s["picture"]))
		} else {
			gameStroke(Obj(s["picture"]), Obj(a["stroke"]))
		}
		return
	}
	gameInsist(kind == "guess" && seat != gi(s["drawer"]) && !gameContains(Arr(s["guessed"]), seat), "Wait for the next drawing.")
	answer := gameText(a["text"], 80)
	correct := gameNormalize(answer) == gameNormalize(S(s["word"]))
	if correct {
		s["guessed"] = append(Arr(s["guessed"]), seat)
		score := 100 - int((now-N(s["started"]))/1000)
		if score < 20 {
			score = 20
		}
		scores := Arr(s["scores"])
		scores[seat] = gi(scores[seat]) + score
		drawer := gi(s["drawer"])
		scores[drawer] = gi(scores[drawer]) + 10
		s["guesses"] = append(Arr(s["guesses"]), M{"seat": seat, "correct": true})
		drawingEveryone(s, now)
	} else {
		s["guesses"] = append(Arr(s["guesses"]), M{"seat": seat, "text": answer, "correct": false})
	}
	s["guesses"] = gameTail(Arr(s["guesses"]), 30)
}
func drawingTick(s, settings M, now int64) {
	if S(s["phase"]) == "drawing" {
		drawingReveal(s, now)
	} else if S(s["phase"]) == "reveal" {
		s["round"] = gi(s["round"]) + 1
		drawingTurn(s, settings, now)
	}
}
func drawingView(s M, seat int) M {
	var word any
	if S(s["phase"]) != "drawing" || seat == gi(s["drawer"]) || gameContains(Arr(s["guessed"]), seat) {
		word = s["word"]
	}
	return M{"phase": s["phase"], "token": s["token"], "round": gi(s["round"]) + 1, "total": len(Arr(s["order"])), "drawer": s["drawer"], "word": word, "wordLength": len([]rune(S(s["word"]))), "picture": s["picture"], "scores": s["scores"], "guesses": s["guesses"], "guessed": s["guessed"]}
}
func phoneAdvance(s, settings M, now int64) {
	albums := Arr(s["albums"])
	n, step := len(albums), gi(s["step"])
	for seat := 0; seat < n; seat++ {
		chain := (seat - step%n + n) % n
		var entry M
		if step%2 == 1 {
			entry = M{"author": seat, "type": "picture", "picture": Arr(s["pictures"])[seat]}
		} else {
			text := S(Obj(s["answers"])[fmt.Sprint(seat)])
			if text == "" {
				text = "…"
			}
			entry = M{"author": seat, "type": "text", "text": text}
		}
		albums[chain] = append(Arr(albums[chain]), entry)
	}
	step++
	s["step"] = step
	done, pictures := []any{}, []any{}
	active := Arr(s["active"])
	for i := 0; i < n; i++ {
		if len(active) > i && !B(active[i]) {
			done = append(done, i)
		}
		pictures = append(pictures, gamePicture())
	}
	s["done"] = done
	s["answers"] = M{}
	s["pictures"] = pictures
	if step >= n {
		s["phase"] = "reveal"
		s["deadline"] = 0
		s["result"] = "Albums ready"
	} else {
		s["phase"] = "describe"
		if step%2 == 1 {
			s["phase"] = "draw"
		}
		s["token"] = fmt.Sprintf("phone-%d", step)
		s["deadline"] = now + N(settings["seconds"])*1000
	}
}
func phoneAction(s M, seat int, a, settings M, now int64) {
	gameInsist(S(s["phase"]) != "reveal" && S(a["token"]) == S(s["token"]) && !gameContains(Arr(s["done"]), seat), "This page has already been submitted.")
	kind := S(a["type"])
	if kind == "stroke" || kind == "clear" || kind == "undo" {
		gameInsist(S(s["phase"]) == "draw")
		pictures := Arr(s["pictures"])
		if kind == "clear" {
			pictures[seat] = gamePicture()
		} else if kind == "undo" {
			gameUndo(Obj(pictures[seat]))
		} else {
			gameStroke(Obj(pictures[seat]), Obj(a["stroke"]))
		}
		return
	}
	gameInsist(kind == "submit")
	if S(s["phase"]) != "draw" {
		Obj(s["answers"])[fmt.Sprint(seat)] = gameText(a["text"], 180)
	}
	s["done"] = append(Arr(s["done"]), seat)
	if len(Arr(s["done"])) == len(Arr(s["albums"])) {
		phoneAdvance(s, settings, now)
	}
}
func phoneView(s M, seat int) M {
	albums := Arr(s["albums"])
	if S(s["phase"]) == "reveal" {
		return M{"phase": s["phase"], "step": s["step"], "total": len(albums), "albums": albums, "done": s["done"]}
	}
	var previous, picture any
	if seat >= 0 {
		chain := (seat - gi(s["step"])%len(albums) + len(albums)) % len(albums)
		entries := Arr(albums[chain])
		if len(entries) > 0 {
			p := Obj(entries[len(entries)-1])
			if S(p["type"]) == "text" {
				previous = M{"type": "text", "text": p["text"]}
			} else {
				previous = M{"type": "picture", "picture": p["picture"]}
			}
		}
		picture = Arr(s["pictures"])[seat]
	}
	return M{"phase": s["phase"], "token": s["token"], "step": s["step"], "total": len(albums), "done": s["done"], "previous": previous, "picture": picture, "submitted": seat >= 0 && gameContains(Arr(s["done"]), seat)}
}
func wordsSwitch(s, settings M, now int64) {
	s["team"] = 1 - gi(s["team"])
	s["phase"] = "clue"
	s["clue"] = nil
	s["guesses"] = 0
	s["turns"] = gi(s["turns"]) + 1
	s["token"] = fmt.Sprintf("words-%d", gi(s["turns"]))
	s["deadline"] = now + N(settings["seconds"])*1000
	if gi(s["turns"]) >= 100 {
		s["phase"] = "ended"
		s["result"] = "Round limit reached"
		s["deadline"] = 0
	}
}
func wordsAction(s M, seat int, a, settings M, now int64) {
	team := gi(s["team"])
	gameInsist(seat%2 == team, "It is the other team’s turn.")
	captains := Arr(s["captains"])
	kind := S(a["type"])
	revealed, roles, board := Arr(s["revealed"]), Arr(s["roles"]), Arr(s["board"])
	if kind == "clue" {
		gameInsist(S(s["phase"]) == "clue" && gi(captains[team]) == seat, "Only your captain can give a clue.")
		clue := gameText(a["text"], 40)
		gameInsist(strings.IndexFunc(clue, unicode.IsSpace) < 0, "Use a single word for the clue.")
		for i, w := range board {
			gameInsist(B(revealed[i]) || gameNormalize(S(w)) != gameNormalize(clue), "Do not use an unrevealed board word.")
		}
		count := gameInt(a["count"], 1, 9)
		s["clue"] = M{"text": clue, "count": count}
		s["guesses"] = count + 1
		s["phase"] = "guess"
		s["deadline"] = now + N(settings["seconds"])*1000
		s["history"] = gameTail(append(Arr(s["history"]), M{"team": team, "text": clue, "count": count}), 40)
		return
	}
	gameInsist(S(s["phase"]) == "guess" && gi(captains[team]) != seat, "Guessers choose the words.")
	if kind == "pass" {
		wordsSwitch(s, settings, now)
		return
	}
	gameInsist(kind == "word")
	i := gameInt(a["index"], 0, 24)
	gameInsist(!B(revealed[i]), "That word is already revealed.")
	revealed[i] = true
	s["guesses"] = gi(s["guesses"]) - 1
	if gi(roles[i]) == 3 {
		s["result"] = fmt.Sprintf("Team %d wins", 2-team)
		s["phase"] = "ended"
		s["deadline"] = 0
		return
	}
	for t := 0; t < 2; t++ {
		all := true
		for i, r := range roles {
			if gi(r) == t && !B(revealed[i]) {
				all = false
			}
		}
		if all {
			s["result"] = fmt.Sprintf("Team %d wins", t+1)
			s["phase"] = "ended"
			s["deadline"] = 0
			return
		}
	}
	if gi(roles[i]) != team || gi(s["guesses"]) == 0 {
		wordsSwitch(s, settings, now)
	}
}
func wordsView(s M, seat int) M {
	captain := gameContains(Arr(s["captains"]), seat)
	roles := []any{}
	remaining := []any{0, 0}
	for i, r := range Arr(s["roles"]) {
		if captain || B(Arr(s["revealed"])[i]) || S(s["phase"]) == "ended" {
			roles = append(roles, r)
		} else {
			roles = append(roles, nil)
		}
		if gi(r) < 2 && !B(Arr(s["revealed"])[i]) {
			remaining[gi(r)] = gi(remaining[gi(r)]) + 1
		}
	}
	return M{"phase": s["phase"], "token": s["token"], "team": s["team"], "captains": s["captains"], "board": s["board"], "roles": roles, "revealed": s["revealed"], "clue": s["clue"], "guesses": s["guesses"], "history": s["history"], "remaining": remaining}
}
