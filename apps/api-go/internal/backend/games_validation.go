package backend

import "encoding/json"

func gameKeys(m M, keys ...string) {
	allowed := map[string]bool{}
	for _, k := range keys {
		allowed[k] = true
	}
	for k := range m {
		Check(allowed[k], 400, "VALIDATION", "Unknown game field: "+k)
	}
}
func gameValidString(v any, min, max int) bool {
	s, ok := v.(string)
	n := TextLen(s)
	return ok && n >= min && n <= max
}
func gameValidInt(v any, min, max int) bool {
	switch v.(type) {
	case float64, int, int64, json.Number:
	default:
		return false
	}
	n := F(v)
	return n == float64(gi(v)) && n >= float64(min) && n <= float64(max)
}
func gameOne(v any, values ...any) bool {
	for _, x := range values {
		if JSON(v) == JSON(x) {
			return true
		}
	}
	return false
}
func gameBase(b M) {
	Check(requestUUID.MatchString(S(b["requestId"])), 400, "VALIDATION", "Invalid request identifier.")
}
func validateGameCreate(b M) {
	gameKeys(b, "requestId", "channelId", "kind", "settings")
	gameBase(b)
	Check(gameValidString(b["channelId"], 1, 100), 400, "VALIDATION", "Choose a voice channel.")
	limit, ok := gameLimits[S(b["kind"])]
	Check(ok, 400, "VALIDATION", "Choose a game.")
	settings := Obj(b["settings"])
	Check(settings != nil, 400, "VALIDATION", "Choose game settings.")
	gameKeys(settings, "maxPlayers", "seconds", "rounds", "language", "domino", "chips", "blind")
	for k, v := range (M{"seconds": 60, "rounds": 1, "language": "en", "domino": "draw", "chips": 1000, "blind": 20}) {
		if _, ok := settings[k]; !ok {
			settings[k] = v
		}
	}
	Check(gameValidInt(settings["maxPlayers"], limit[0], limit[1]) && gameOne(settings["seconds"], 45, 60, 90) && gameValidInt(settings["rounds"], 1, 3) && gameOne(settings["language"], "en", "fa") && gameOne(settings["domino"], "draw", "block") && gameOne(settings["chips"], 1000, 2000) && gameOne(settings["blind"], 10, 20, 50), 400, "VALIDATION", "Choose valid game settings.")
}
func validateGameCommand(b M) {
	gameKeys(b, "requestId", "revision", "kind", "action")
	gameBase(b)
	Check(gameValidInt(b["revision"], 1, 2147483647) && gameOne(b["kind"], "join", "start", "leave", "close", "action"), 400, "VALIDATION", "Invalid game command.")
	if v, ok := b["action"]; ok {
		a := Obj(v)
		Check(a != nil, 400, "VALIDATION", "Invalid game action.")
		gameKeys(a, "type", "token", "piece", "column", "tile", "end", "to", "index", "count", "text", "stroke")
		Check(gameOne(a["type"], "drop", "tile", "draw", "pass", "next", "roll", "token", "fold", "check", "call", "raise", "stroke", "clear", "undo", "guess", "submit", "clue", "word"), 400, "VALIDATION", "Invalid game action.")
		for k, bounds := range map[string][2]int{"piece": {0, 3}, "column": {0, 6}, "tile": {0, 27}, "to": {0, 1000000}, "index": {0, 24}, "count": {1, 9}} {
			if v, ok := a[k]; ok {
				Check(gameValidInt(v, bounds[0], bounds[1]), 400, "VALIDATION", "Invalid game action number.")
			}
		}
		if v, ok := a["end"]; ok {
			Check(gameOne(v, "left", "right"), 400, "VALIDATION", "Invalid domino end.")
		}
		for k, max := range map[string]int{"token": 40, "text": 180} {
			if v, ok := a[k]; ok {
				Check(gameValidString(v, 0, max), 400, "VALIDATION", "Invalid game action text.")
			}
		}
		if v, ok := a["stroke"]; ok {
			p := Obj(v)
			Check(p != nil, 400, "VALIDATION", "Invalid stroke.")
			gameKeys(p, "color", "width", "points")
			Check(gameValidString(p["color"], 0, 7) && gameValidInt(p["width"], -2147483648, 2147483647), 400, "VALIDATION", "Invalid drawing tool.")
			points := Arr(p["points"])
			Check(len(points) >= 1 && len(points) <= 100, 400, "VALIDATION", "Invalid drawing points.")
			for _, v := range points {
				xy := Arr(v)
				Check(len(xy) == 2 && gameValidInt(xy[0], 0, 1000) && gameValidInt(xy[1], 0, 1000), 400, "VALIDATION", "Invalid drawing point.")
			}
		}
	}
}
func validateChessCreate(b M) {
	gameKeys(b, "requestId", "serverId", "channelId", "openSeat", "opponentId", "difficulty", "mode", "minutes", "increment")
	gameBase(b)
	Check(gameValidString(b["serverId"], 1, 100) && gameOne(b["mode"], "standard", "elixer") && gameOne(b["minutes"], 3, 5, 10, 15) && gameOne(b["increment"], 0, 2, 5, 10), 400, "VALIDATION", "Invalid chess settings.")
	for _, k := range []string{"channelId", "opponentId"} {
		if v, ok := b[k]; ok {
			Check(gameValidString(v, 1, 100), 400, "VALIDATION", "Invalid chess participant.")
		}
	}
	if v, ok := b["openSeat"]; ok {
		Check(v == true, 400, "VALIDATION", "Invalid open seat.")
	}
	if v, ok := b["difficulty"]; ok {
		Check(gameOne(v, "Easy", "Medium", "Hard"), 400, "VALIDATION", "Choose a difficulty.")
	}
	n := 0
	for _, k := range []string{"opponentId", "difficulty", "openSeat"} {
		if B(b[k]) || S(b[k]) != "" {
			n++
		}
	}
	Check(n == 1 && (!B(b["openSeat"]) || S(b["channelId"]) != "") && (S(b["channelId"]) == "" || S(b["opponentId"]) == ""), 400, "VALIDATION", "Choose an open voice seat or AI.")
}
func validateChessCommand(b M) {
	gameKeys(b, "requestId", "revision", "kind", "action")
	gameBase(b)
	Check(gameValidInt(b["revision"], 1, 2147483647) && gameOne(b["kind"], "join", "accept", "decline", "cancel", "action", "resign", "offerDraw", "acceptDraw", "declineDraw", "claimDraw"), 400, "VALIDATION", "Invalid chess command.")
	if v, ok := b["action"]; ok {
		a := Obj(v)
		Check(a != nil, 400, "VALIDATION", "Invalid chess action.")
		gameKeys(a, "from", "to", "buy", "promotion")
		Check(gameValidInt(a["to"], 0, 63), 400, "VALIDATION", "Choose a chess square.")
		if v, ok := a["from"]; ok {
			Check(gameValidInt(v, 0, 63), 400, "VALIDATION", "Choose a chess square.")
		}
		if v, ok := a["buy"]; ok {
			Check(gameOne(v, "p", "n", "b", "r", "q"), 400, "VALIDATION", "Choose a piece.")
		}
		if v, ok := a["promotion"]; ok {
			Check(gameOne(v, "q", "r", "b", "n"), 400, "VALIDATION", "Choose a promotion.")
		}
	}
}
