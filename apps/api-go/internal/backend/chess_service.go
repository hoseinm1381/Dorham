package backend

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

type ChessGame struct {
	ChannelID    *string          `json:"channelId"`
	OpenSeat     bool             `json:"openSeat"`
	ID           string           `json:"id"`
	ServerID     string           `json:"serverId"`
	WhiteID      string           `json:"whiteId"`
	BlackID      *string          `json:"blackId"`
	WhiteName    string           `json:"whiteName"`
	BlackName    string           `json:"blackName"`
	Difficulty   *string          `json:"difficulty"`
	Status       string           `json:"status"`
	Position     ChessPosition    `json:"position"`
	Revision     int64            `json:"revision"`
	Minutes      int              `json:"minutes"`
	Increment    int              `json:"increment"`
	Remaining    [2]int64         `json:"remaining"`
	RunningSince int64            `json:"runningSince"`
	PausedUntil  int64            `json:"pausedUntil"`
	Missing      []string         `json:"missing"`
	MissingAt    map[string]int64 `json:"missingAt"`
	Grace        [2]int64         `json:"grace"`
	Result       any              `json:"result"`
	DrawBy       *string          `json:"drawBy"`
	CreatedAt    int64            `json:"createdAt"`
	UpdatedAt    int64            `json:"updatedAt"`
	Log          []string         `json:"log"`
}

func chessString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
func chessPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
func chessCharge(c *ChessGame, now int64) {
	if c.Status != "playing" || c.PausedUntil != 0 {
		return
	}
	color := c.Position.Turn
	elapsed := now - c.RunningSince
	if elapsed < 0 {
		elapsed = 0
	}
	c.Remaining[color] -= elapsed
	if c.Remaining[color] < 0 {
		c.Remaining[color] = 0
	}
	c.RunningSince = now
	if c.Remaining[color] == 0 {
		c.Status = "finished"
		if c.Position.Mode == "standard" && !chessCanMate(c.Position, 1-color) {
			c.Result = "Draw by insufficient material"
		} else {
			c.Result = chessWinner(1-color, "timeout")
		}
	}
}
func chessExpire(c *ChessGame, now int64) {
	ttl := int64(120000)
	if c.OpenSeat {
		ttl = 600000
	}
	if c.Status == "pending" && (now >= c.CreatedAt+ttl || (c.PausedUntil != 0 && now >= c.PausedUntil)) {
		c.Status = "finished"
		c.Result = "Challenge expired"
	}
	if c.Status != "playing" {
		return
	}
	if c.PausedUntil != 0 && now >= c.PausedUntil {
		c.Status = "finished"
		c.Result = "Draw after both players disconnected"
		if len(c.Missing) <= 1 {
			color := 0
			if len(c.Missing) > 0 && c.Missing[0] == c.WhiteID {
				color = 1
			}
			c.Result = chessWinner(color, "disconnection")
		}
	} else {
		chessCharge(c, now)
	}
}
func (g *Games) chessLoad(tx *DB, id string) *ChessGame {
	r := tx.One("SELECT state FROM chess_games WHERE id=?", id)
	Check(r != nil, 404, "NOT_FOUND", "Chess match not found.")
	var c ChessGame
	if e := json.Unmarshal([]byte(S(r["state"])), &c); e != nil {
		panic(e)
	}
	if c.MissingAt == nil {
		c.MissingAt = map[string]int64{}
	}
	return &c
}
func (g *Games) chessSave(tx *DB, c *ChessGame) {
	c.UpdatedAt = g.now()
	tx.Run("INSERT INTO chess_games(id,server_id,white_id,black_id,status,updated_at,state,channel_id) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET black_id=excluded.black_id,channel_id=excluded.channel_id,status=excluded.status,updated_at=excluded.updated_at,state=excluded.state", c.ID, c.ServerID, c.WhiteID, c.BlackID, c.Status, c.UpdatedAt, JSON(c), c.ChannelID)
	g.markChessDeadlineDirty(c.ID)
}
func (g *Games) chessAllowed(tx *DB, uid string, c *ChessGame) {
	g.a.Service.Member(tx, uid, c.ServerID)
	for _, player := range []string{c.WhiteID, chessString(c.BlackID)} {
		if player != "" && !deletedChessPlayer(tx, c, player) {
			g.a.Service.Member(tx, player, c.ServerID)
		}
	}
	if c.ChannelID != nil && uid != c.WhiteID && uid != chessString(c.BlackID) {
		g.requireVoice(tx, uid, *c.ChannelID)
	}
}
func deletedChessPlayer(db *DB, c *ChessGame, player string) bool {
	return c.Status == "finished" && db.One("SELECT id FROM users WHERE id=? AND deleted_at IS NOT NULL", player) != nil
}
func (g *Games) ChessView(uid, id string) any {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.chessView(uid, id)
}
func (g *Games) chessView(uid, id string) M {
	return g.a.DB.Tx(func(tx *DB) any {
		c := g.chessLoad(tx, id)
		g.chessAllowed(tx, uid, c)
		now := g.now()
		chessCharge(c, now)
		ownTurn := (c.Position.Turn == 0 && uid == c.WhiteID) || (c.Position.Turn == 1 && uid == chessString(c.BlackID))
		voice := c.ChannelID == nil || tx.One("SELECT user_id FROM voice_members WHERE user_id=? AND channel_id=?", uid, chessString(c.ChannelID)) != nil
		actions := []ChessAction{}
		if c.Status == "playing" && c.PausedUntil == 0 && ownTurn && voice {
			actions = LegalChess(c.Position)
		}
		m := Obj(Parse(JSON(c)))
		return Merge(m, M{"serverNow": now, "actions": actions, "canPlay": c.OpenSeat && c.Status == "pending" && c.BlackID == nil && uid != c.WhiteID && voice && c.PausedUntil == 0, "check": chessCheck(c.Position, c.Position.Turn), "canClaimDraw": c.Position.Mode == "standard" && (c.Position.Half >= 100 || chessRepetition(c.Position) >= 3)})
	}).(M)
}
func (g *Games) ChessList(uid, channel string) any {
	ch := g.requireVoice(g.a.DB, uid, channel)
	out := []M{}
	for _, r := range g.a.DB.All("SELECT state FROM chess_games WHERE status<>'finished' AND (channel_id=? OR (channel_id IS NULL AND server_id=? AND (white_id=? OR black_id=?))) ORDER BY updated_at DESC LIMIT 60", channel, ch["server_id"], uid, uid) {
		var c ChessGame
		gameDecode(Parse(S(r["state"])), &c)
		out = append(out, M{"id": c.ID, "channelId": channel, "hostName": c.WhiteName, "whiteId": c.WhiteID, "blackId": c.BlackID, "status": c.Status, "openSeat": c.OpenSeat && c.BlackID == nil && c.Status == "pending", "mode": c.Position.Mode, "minutes": c.Minutes, "increment": c.Increment, "paused": c.PausedUntil != 0, "legacy": c.ChannelID == nil})
	}
	return out
}
func (g *Games) chessServerList(uid, server string) any {
	g.a.Service.Member(g.a.DB, uid, server)
	out := []M{}
	for _, r := range g.a.DB.All("SELECT state FROM chess_games WHERE server_id=? ORDER BY updated_at DESC LIMIT 30", server) {
		var c ChessGame
		gameDecode(Parse(S(r["state"])), &c)
		out = append(out, M{"id": c.ID, "whiteId": c.WhiteID, "blackId": c.BlackID, "whiteName": c.WhiteName, "blackName": c.BlackName, "status": c.Status, "mode": c.Position.Mode, "minutes": c.Minutes, "increment": c.Increment, "result": c.Result})
	}
	return out
}
func (g *Games) chessCreate(uid string, b M) any {
	g.mu.Lock()
	defer g.mu.Unlock()
	validateChessCreate(b)
	r := Obj(g.a.Service.Mutate(uid, S(b["requestId"]), "chess.create", b, func(tx *DB) any {
		Check(!g.busy(tx, uid, ""), 409, "CAPACITY", "Finish or leave your existing game first.")
		server, channel, opponent := S(b["serverId"]), S(b["channelId"]), S(b["opponentId"])
		if channel != "" {
			ch := g.requireVoice(tx, uid, channel)
			Check(S(ch["server_id"]) == server, 400, "INVALID_REQUEST", "The game must use your current voice channel.")
			Check(tx.One("SELECT id FROM chess_games WHERE white_id=? AND channel_id IS NOT NULL AND status<>'finished'", uid) == nil, 409, "CAPACITY", "Open your existing game or close it before creating another.")
		}
		names := []string{}
		for _, p := range []string{uid, opponent} {
			if p == "" {
				continue
			}
			g.a.Service.Member(tx, p, server)
			names = append(names, S(tx.One("SELECT display_name FROM users WHERE id=?", p)["display_name"]))
		}
		Check(opponent != uid, 400, "INVALID_REQUEST", "Choose another player.")
		if opponent != "" {
			Check(tx.One("SELECT user_id FROM user_blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)", uid, opponent, opponent, uid) == nil, 403, "FORBIDDEN", "This challenge is unavailable.")
		}
		active := N(tx.One("SELECT COUNT(*) AS n FROM chess_games WHERE status='playing' AND (white_id=? OR black_id=?)", uid, uid)["n"])
		pending := N(tx.One("SELECT COUNT(*) AS n FROM chess_games WHERE status='pending' AND (white_id=? OR black_id=?)", uid, uid)["n"])
		total := N(tx.One("SELECT (SELECT COUNT(*) FROM chess_games WHERE status<>'finished')+(SELECT COUNT(*) FROM game_sessions WHERE status<>'finished') AS n")["n"])
		Check(active < 1 && pending < 3 && total < 60, 409, "CAPACITY", "Finish your current game or pending challenges first.")
		now := g.now()
		name := S(b["difficulty"]) + " AI"
		if B(b["openSeat"]) {
			name = "Open seat"
		}
		if len(names) > 1 {
			name = names[1]
		}
		status := "playing"
		if opponent != "" || B(b["openSeat"]) {
			status = "pending"
		}
		minutes := gi(b["minutes"])
		c := &ChessGame{ChannelID: chessPtr(channel), OpenSeat: B(b["openSeat"]), ID: ID(), ServerID: server, WhiteID: uid, BlackID: chessPtr(opponent), WhiteName: names[0], BlackName: name, Difficulty: chessPtr(S(b["difficulty"])), Status: status, Position: InitialChess(S(b["mode"])), Revision: 1, Minutes: minutes, Increment: gi(b["increment"]), Remaining: [2]int64{int64(minutes) * 60000, int64(minutes) * 60000}, RunningSince: now, Missing: []string{}, MissingAt: map[string]int64{}, Grace: [2]int64{30000, 30000}, CreatedAt: now, UpdatedAt: now, Log: []string{}}
		tx.Run("DELETE FROM chess_games WHERE id IN (SELECT id FROM chess_games WHERE status='finished' ORDER BY updated_at DESC LIMIT 10000 OFFSET 999)")
		g.chessSave(tx, c)
		return M{"id": c.ID}
	}))
	g.chessChanged(S(r["id"]))
	if S(b["channelId"]) != "" {
		g.chessPresence(uid, g.online(uid))
	}
	return g.chessView(uid, S(r["id"]))
}
func (g *Games) chessCommand(uid, id string, b M) any {
	g.mu.Lock()
	defer g.mu.Unlock()
	validateChessCommand(b)
	g.a.Service.Mutate(uid, S(b["requestId"]), "chess.command", Merge(M{"id": id}, b), func(tx *DB) any {
		c := g.chessLoad(tx, id)
		g.chessAllowed(tx, uid, c)
		kind := S(b["kind"])
		joining := kind == "join" && c.OpenSeat && c.Status == "pending" && c.BlackID == nil && uid != c.WhiteID
		if kind == "join" {
			Check(joining, 409, "SEAT_TAKEN", "The seat is no longer open. You can keep watching.")
		}
		Check(joining || uid == c.WhiteID || uid == chessString(c.BlackID), 403, "FORBIDDEN", "Spectators cannot change a match.")
		Check(c.Revision == N(b["revision"]), 409, "STALE_GAME", "The board changed. Review the latest position.")
		now := g.now()
		chessExpire(c, now)
		Check(c.Status != "finished", 409, "GAME_FINISHED", "The match has ended.")
		if c.ChannelID != nil && kind != "resign" && kind != "cancel" {
			g.requireVoice(tx, uid, *c.ChannelID)
		}
		if c.Status == "pending" {
			if joining {
				Check(c.PausedUntil == 0, 409, "PAUSED", "Waiting for the host to return to voice.")
				g.requireVoice(tx, c.WhiteID, chessString(c.ChannelID))
				Check(tx.One("SELECT user_id FROM user_blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)", uid, c.WhiteID, c.WhiteID, uid) == nil, 403, "FORBIDDEN", "This challenge is unavailable.")
				Check(!g.busy(tx, uid, "") && !g.busy(tx, c.WhiteID, ""), 409, "CAPACITY", "A player already has an active game.")
				for _, p := range []string{uid, c.WhiteID} {
					Check(tx.One("SELECT id FROM chess_games WHERE id<>? AND (white_id=? OR black_id=?) AND (status='playing' OR (status='pending' AND channel_id IS NOT NULL))", id, p, p) == nil, 409, "CAPACITY", "A player already has an active match.")
				}
				c.BlackID = chessPtr(uid)
				c.BlackName = S(tx.One("SELECT display_name FROM users WHERE id=?", uid)["display_name"])
				c.OpenSeat = false
				c.Status = "playing"
				c.RunningSince = now
			} else if kind == "accept" && uid == chessString(c.BlackID) {
				Check(g.online(c.WhiteID) && g.online(chessString(c.BlackID)), 409, "OFFLINE", "Both players must be online to start.")
				Check(!g.busy(tx, uid, "") && !g.busy(tx, c.WhiteID, ""), 409, "CAPACITY", "A player already has an active game.")
				for _, p := range []string{c.WhiteID, chessString(c.BlackID)} {
					Check(tx.One("SELECT id FROM chess_games WHERE status='playing' AND (white_id=? OR black_id=?)", p, p) == nil, 409, "CAPACITY", "A player already has an active match.")
				}
				c.Status = "playing"
				c.RunningSince = now
			} else if (kind == "decline" && uid == chessString(c.BlackID)) || (kind == "cancel" && uid == c.WhiteID) {
				c.Status = "finished"
				c.Result = "Challenge cancelled"
			} else {
				Fail(400, "INVALID_REQUEST", "Accept, decline or cancel this challenge first.")
			}
		} else if kind == "resign" {
			c.Status = "finished"
			color := 0
			if uid == c.WhiteID {
				color = 1
			}
			c.Result = chessWinner(color, "resignation")
		} else {
			Check(c.PausedUntil == 0, 409, "PAUSED", "Waiting for reconnection.")
			chessCharge(c, now)
			ownTurn := (c.Position.Turn == 0 && uid == c.WhiteID) || (c.Position.Turn == 1 && uid == chessString(c.BlackID))
			switch kind {
			case "action":
				Check(ownTurn, 403, "WRONG_TURN", "Wait for your turn.")
				Check(b["action"] != nil, 400, "INVALID_REQUEST", "Choose a move.")
				var a ChessAction
				gameDecode(b["action"], &a)
				g.chessMove(c, a)
			case "offerDraw":
				Check(c.DrawBy == nil, 409, "DRAW_PENDING", "A draw offer is already pending.")
				c.DrawBy = chessPtr(uid)
			case "acceptDraw":
				Check(c.DrawBy != nil && *c.DrawBy != uid, 400, "INVALID_REQUEST", "That match action is unavailable.")
				c.Status = "finished"
				c.Result = "Draw by agreement"
			case "declineDraw":
				Check(c.DrawBy != nil && *c.DrawBy != uid, 400, "INVALID_REQUEST", "That match action is unavailable.")
				c.DrawBy = nil
			case "claimDraw":
				Check(ownTurn && c.Position.Mode == "standard" && (c.Position.Half >= 100 || chessRepetition(c.Position) >= 3), 400, "INVALID_REQUEST", "That match action is unavailable.")
				c.Status = "finished"
				c.Result = "Draw claimed by rule"
			default:
				Fail(400, "INVALID_REQUEST", "That match action is unavailable.")
			}
		}
		c.Revision++
		g.chessSave(tx, c)
		return M{"id": id}
	})
	g.chessChanged(id)
	if S(b["kind"]) == "join" {
		g.chessReconcile()
	}
	return g.chessView(uid, id)
}
func (g *Games) chessMove(c *ChessGame, a ChessAction) {
	color := c.Position.Turn
	c.Position = ApplyChess(c.Position, a)
	c.Remaining[color] += int64(c.Increment) * 1000
	c.DrawBy = nil
	entry := ""
	if a.Buy != "" {
		entry = strings.ToUpper(a.Buy) + " @ " + chessSquare(a.To)
	} else {
		entry = chessSquare(*a.From) + "–" + chessSquare(a.To)
		if a.Promotion != "" {
			entry += "=" + strings.ToUpper(a.Promotion)
		}
	}
	c.Log = append(c.Log, entry)
	if result := chessOutcome(c.Position); result != nil {
		c.Status = "finished"
		c.Result = result
	}
}
func (g *Games) chessInitialize(tx *DB) {
	for _, r := range tx.All("SELECT id FROM chess_games WHERE status<>'finished'") {
		c := g.chessLoad(tx, S(r["id"]))
		if c.Status == "playing" {
			now := g.now()
			chessExpire(c, now)
			if c.Status == "playing" {
				c.Missing = []string{c.WhiteID}
				if c.BlackID != nil {
					c.Missing = append(c.Missing, *c.BlackID)
				}
				c.MissingAt = map[string]int64{}
				for _, uid := range c.Missing {
					c.MissingAt[uid] = now
				}
				c.PausedUntil = now + 30000
				c.RunningSince = now
			}
			c.Revision++
			g.chessSave(tx, c)
		}
	}
}
func (g *Games) chessPresence(uid string, online bool) {
	for _, r := range g.a.DB.All("SELECT id FROM chess_games WHERE (status='playing' OR (status='pending' AND channel_id IS NOT NULL)) AND (white_id=? OR black_id=?)", uid, uid) {
		id := S(r["id"])
		changed := false
		g.a.DB.Tx(func(tx *DB) any {
			c := g.chessLoad(tx, id)
			if c.Status == "finished" {
				return nil
			}
			now := g.now()
			present := online && (c.ChannelID == nil || tx.One("SELECT user_id FROM voice_members WHERE user_id=? AND channel_id=?", uid, chessString(c.ChannelID)) != nil)
			chessExpire(c, now)
			color := 0
			if uid != c.WhiteID {
				color = 1
			}
			missing := Contains(c.Missing, uid)
			if present && missing {
				c.Grace[color] = int64(math.Max(0, float64(c.Grace[color]-(now-c.MissingAt[uid]))))
				out := []string{}
				for _, p := range c.Missing {
					if p != uid {
						out = append(out, p)
					}
				}
				c.Missing = out
				delete(c.MissingAt, uid)
			} else if !present && !missing {
				c.Missing = append(c.Missing, uid)
				c.MissingAt[uid] = now
			} else {
				return nil
			}
			c.PausedUntil = 0
			for _, p := range c.Missing {
				color := 0
				if p != c.WhiteID {
					color = 1
				}
				deadline := c.MissingAt[p] + c.Grace[color]
				if c.PausedUntil == 0 || deadline < c.PausedUntil {
					c.PausedUntil = deadline
				}
			}
			if c.PausedUntil == 0 {
				c.RunningSince = now
			}
			chessExpire(c, now)
			c.Revision++
			g.chessSave(tx, c)
			changed = true
			return nil
		})
		if changed {
			g.chessChanged(id)
		}
	}
}
func (g *Games) chessReconcile() {
	voice := map[string]string{}
	for _, r := range g.a.DB.All("SELECT user_id,channel_id FROM voice_members") {
		voice[S(r["user_id"])] = S(r["channel_id"])
	}
	for _, r := range g.a.DB.All("SELECT id FROM chess_games WHERE status<>'finished' AND channel_id IS NOT NULL") {
		c := g.chessLoad(g.a.DB, S(r["id"]))
		players := []string{c.WhiteID}
		if c.BlackID != nil {
			players = append(players, *c.BlackID)
		}
		for _, uid := range players {
			present := voice[uid] == chessString(c.ChannelID) && g.online(uid)
			if present == Contains(c.Missing, uid) {
				g.chessPresence(uid, present)
			}
		}
	}
}
func (g *Games) chessChanged(id string) {
	g.schedule()
	c := g.chessLoad(g.a.DB, id)
	previous := g.chessObserved[id]
	directory := previous == nil || previous.Status != c.Status || chessString(previous.BlackID) != chessString(c.BlackID) || (previous.PausedUntil != 0) != (c.PausedUntil != 0)
	if c.Status == "finished" {
		delete(g.chessObserved, id)
	} else {
		g.chessObserved[id] = c
	}
	members := map[string]bool{}
	for _, r := range g.a.DB.All("SELECT u.id AS user_id FROM users u JOIN servers s ON s.id=? LEFT JOIN members m ON m.server_id=s.id AND m.user_id=u.id WHERE u.banned=0 AND (u.instance_admin=1 OR (m.user_id IS NOT NULL AND (u.guest=0 OR s.allow_guests=1)))", c.ServerID) {
		members[S(r["user_id"])] = true
	}
	if (!members[c.WhiteID] && !deletedChessPlayer(g.a.DB, c, c.WhiteID)) ||
		(c.BlackID != nil && !members[*c.BlackID] && !deletedChessPlayer(g.a.DB, c, *c.BlackID)) {
		return
	}
	voice := map[string]bool{}
	if c.ChannelID != nil {
		for _, r := range g.a.DB.All("SELECT user_id FROM voice_members WHERE channel_id=?", *c.ChannelID) {
			voice[S(r["user_id"])] = true
		}
	}
	var challenge any
	if c.Status == "pending" {
		challenge = c.BlackID
	}
	for uid := range members {
		if c.ChannelID == nil || voice[uid] || uid == c.WhiteID || uid == chessString(c.BlackID) {
			g.a.Hub.EmitUser(uid, "chess:changed", M{"id": c.ID, "serverId": c.ServerID, "channelId": c.ChannelID, "directoryChanged": directory, "challengeTo": challenge})
		}
	}
	if c.Status == "playing" && c.PausedUntil == 0 && c.Difficulty != nil && c.BlackID == nil && c.Position.Turn == 1 {
		revision := c.Revision
		go func() {
			defer func() {
				if p := recover(); p != nil {
					fmt.Printf("chess AI task failed: %T\n", p)
				}
			}()
			g.mu.Lock()
			defer g.mu.Unlock()
			select {
			case <-g.stop:
				return
			default:
			}
			g.a.DB.Tx(func(tx *DB) any {
				c := g.chessLoad(tx, id)
				if c.Revision != revision || c.Status != "playing" || c.PausedUntil != 0 || c.Difficulty == nil || c.BlackID != nil || c.Position.Turn != 1 {
					return nil
				}
				chessExpire(c, g.now())
				if c.Status == "playing" {
					if a := chessAI(c.Position, *c.Difficulty); a != nil {
						chessCharge(c, g.now())
						if c.Status == "playing" {
							g.chessMove(c, *a)
						}
					}
				}
				c.Revision++
				g.chessSave(tx, c)
				return nil
			})
			g.chessChanged(id)
		}()
	}
}
func (g *Games) chessTick() {
	for _, r := range g.a.DB.All("SELECT id FROM chess_games WHERE status<>'finished'") {
		id := S(r["id"])
		changed := false
		g.a.DB.Tx(func(tx *DB) any {
			c := g.chessLoad(tx, id)
			chessExpire(c, g.now())
			if c.Status == "finished" {
				c.Revision++
				g.chessSave(tx, c)
				changed = true
			}
			return nil
		})
		if changed {
			g.chessChanged(id)
		}
	}
}

func chessDeadline(c *ChessGame) int64 {
	if c.Status == "pending" {
		ttl := int64(120000)
		if c.OpenSeat {
			ttl = 600000
		}
		d := c.CreatedAt + ttl
		if c.PausedUntil != 0 && c.PausedUntil < d {
			return c.PausedUntil
		}
		return d
	}
	if c.PausedUntil != 0 {
		return c.PausedUntil
	}
	return c.RunningSince + c.Remaining[c.Position.Turn]
}
