package backend

import (
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"
)

// Games serializes engine lifecycle transitions; all persisted operations also
// use the shared DB transaction and mutation receipt so HTTP retries are safe.
type Games struct {
	a             *App
	mu            sync.Mutex
	stop          chan struct{}
	wake          chan struct{}
	wg            sync.WaitGroup
	once          sync.Once
	online        func(string) bool
	now           func() int64
	rates         map[string][2]int64
	observed      map[string]M
	chessObserved map[string]*ChessGame
	deadlineDirty map[string]bool
}

var gameLimits = map[string][2]int{"poker": {2, 8}, "domino": {2, 4}, "telephone": {3, 8}, "drawing": {2, 8}, "words": {4, 8}, "ludo": {2, 4}, "four": {2, 2}}

func NewGames(a *App) *Games {
	g := &Games{a: a, online: a.Hub.Online, now: gamesNow, stop: make(chan struct{}), wake: make(chan struct{}, 1), rates: map[string][2]int64{}, observed: map[string]M{}, chessObserved: map[string]*ChessGame{}}
	g.initialize()
	g.wg.Add(1)
	go g.loop()
	return g
}
func (g *Games) Close() { g.once.Do(func() { close(g.stop); g.wg.Wait(); g.mu.Lock(); g.mu.Unlock() }) }
func (g *Games) schedule() {
	select {
	case g.wake <- struct{}{}:
	default:
	}
}

func (g *Games) markGameDeadlineDirty(id string) {
	if g.deadlineDirty == nil {
		g.deadlineDirty = map[string]bool{}
	}
	g.deadlineDirty["game:"+id] = true
	g.schedule()
}
func (g *Games) markChessDeadlineDirty(id string) {
	if g.deadlineDirty == nil {
		g.deadlineDirty = map[string]bool{}
	}
	g.deadlineDirty["chess:"+id] = true
	g.schedule()
}

// Observations contain only fields needed for deadline scheduling and directory
// change detection. Pictures/albums, private game data and permission decisions
// stay out of this cache; transitions always load the persisted full state.
func gameObservation(s M) M {
	seats := []any{}
	for _, p := range gameSeats(s) {
		seats = append(seats, M{"id": p["id"], "left": false})
	}
	var state any
	if s["state"] != nil {
		engine := Obj(s["state"])
		state = M{"phase": engine["phase"], "deadline": engine["deadline"]}
	}
	return M{"id": s["id"], "status": s["status"], "hostId": s["hostId"], "kind": s["kind"], "createdAt": s["createdAt"], "updatedAt": s["updatedAt"], "pausedUntil": s["pausedUntil"], "seats": seats, "state": state}
}
func (g *Games) nearest() (nearest int64) {
	defer func() {
		if e := recover(); e != nil {
			log.Printf("game deadline query: %v", e)
			nearest = g.now() + 1000
		}
	}()
	g.mu.Lock()
	defer g.mu.Unlock()
	// Drawing changes wake this timer up to twenty times a second. The observed
	// snapshots are already updated after committed transitions; scheduling must
	// not reload/decode every drawing album just to read its deadline. Lightweight
	// ID reads retain FK-cascade cleanup and recover a cold cache without caching
	// any authorization decision. Actual due transitions still reload inside Tx.
	seenGames := map[string]bool{}
	for _, r := range g.a.DB.All("SELECT id,updated_at FROM game_sessions WHERE status<>'finished'") {
		id := S(r["id"])
		state := g.observed[id]
		if state == nil || g.deadlineDirty["game:"+id] || N(state["updatedAt"]) != N(r["updated_at"]) {
			row := g.a.DB.One("SELECT state FROM game_sessions WHERE id=? AND status<>'finished'", id)
			if row == nil {
				delete(g.deadlineDirty, "game:"+id)
				continue
			}
			state = gameObservation(Obj(Parse(S(row["state"]))))
			g.observed[id] = state
			delete(g.deadlineDirty, "game:"+id)
		}
		seenGames[id] = true
		d := gameDeadline(state)
		if nearest == 0 || d < nearest {
			nearest = d
		}
	}
	for id := range g.observed {
		if !seenGames[id] {
			delete(g.observed, id)
			delete(g.deadlineDirty, "game:"+id)
		}
	}
	seenChess := map[string]bool{}
	for _, r := range g.a.DB.All("SELECT id,updated_at FROM chess_games WHERE status<>'finished'") {
		id := S(r["id"])
		c := g.chessObserved[id]
		if c == nil || g.deadlineDirty["chess:"+id] || c.UpdatedAt != N(r["updated_at"]) {
			row := g.a.DB.One("SELECT state FROM chess_games WHERE id=? AND status<>'finished'", id)
			if row == nil {
				delete(g.deadlineDirty, "chess:"+id)
				continue
			}
			c = &ChessGame{}
			gameDecode(Parse(S(row["state"])), c)
			g.chessObserved[id] = c
			delete(g.deadlineDirty, "chess:"+id)
		}
		seenChess[id] = true
		d := chessDeadline(c)
		if nearest == 0 || d < nearest {
			nearest = d
		}
	}
	for id := range g.chessObserved {
		if !seenChess[id] {
			delete(g.chessObserved, id)
			delete(g.deadlineDirty, "chess:"+id)
		}
	}
	for key := range g.deadlineDirty {
		if strings.HasPrefix(key, "game:") && !seenGames[strings.TrimPrefix(key, "game:")] || strings.HasPrefix(key, "chess:") && !seenChess[strings.TrimPrefix(key, "chess:")] {
			delete(g.deadlineDirty, key)
		}
	}
	return nearest
}
func (g *Games) loop() {
	defer g.wg.Done()
	for {
		select {
		case <-g.stop:
			return
		default:
		}
		nearest := g.nearest()
		var timer *time.Timer
		var ch <-chan time.Time
		if nearest != 0 {
			wait := nearest - g.now()
			if wait < 1 {
				wait = 1
			}
			timer = time.NewTimer(time.Duration(wait) * time.Millisecond)
			ch = timer.C
		}
		select {
		case <-g.stop:
			if timer != nil {
				timer.Stop()
			}
			return
		case <-g.wake:
			if timer != nil {
				timer.Stop()
			}
		case <-ch:
			func() {
				defer func() {
					if e := recover(); e != nil {
						log.Printf("game timer: %v", e)
						select {
						case <-g.stop:
						case <-time.After(time.Second):
						}
					}
				}()
				g.mu.Lock()
				defer g.mu.Unlock()
				g.tick()
			}()
		}
	}
}
func (g *Games) requireVoice(tx *DB, uid, channel string) M {
	c := g.a.Service.Channel(tx, uid, channel)
	Check(S(c["kind"]) == "voice" && tx.One("SELECT user_id FROM voice_members WHERE user_id=? AND channel_id=?", uid, channel) != nil, 403, "VOICE_REQUIRED", "Join this voice channel to play or watch.")
	return c
}
func gameSeats(s M) []M {
	out := []M{}
	for _, v := range Arr(s["seats"]) {
		p := Obj(v)
		if !B(p["left"]) {
			out = append(out, p)
		}
	}
	return out
}
func gameSeat(s M, uid string) int {
	for i, v := range Arr(s["seats"]) {
		p := Obj(v)
		if S(p["id"]) == uid && !B(p["left"]) {
			return i
		}
	}
	return -1
}
func (g *Games) load(tx *DB, id string) M {
	r := tx.One("SELECT state FROM game_sessions WHERE id=?", id)
	Check(r != nil, 404, "NOT_FOUND", "Game not found.")
	return Obj(Parse(S(r["state"])))
}
func (g *Games) save(tx *DB, s M, roster bool) {
	s["updatedAt"] = g.now()
	state := JSON(s)
	Check(len(state) <= 768*1024, 413, "CAPACITY", "This game has reached its drawing limit.")
	tx.Run("INSERT INTO game_sessions(id,server_id,channel_id,host_id,kind,status,updated_at,state) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET host_id=excluded.host_id,status=excluded.status,updated_at=excluded.updated_at,state=excluded.state", s["id"], s["serverId"], s["channelId"], s["hostId"], s["kind"], s["status"], s["updatedAt"], state)
	if roster {
		tx.Run("DELETE FROM game_players WHERE game_id=?", s["id"])
		for _, p := range gameSeats(s) {
			tx.Run("INSERT INTO game_players(game_id,user_id) VALUES(?,?)", s["id"], p["id"])
		}
	}
	// Invalidation is safe before commit: nearest cannot pass the lifecycle
	// mutex until this transaction completes, then reloads committed data. A
	// rollback only causes one harmless reread, never a phantom deadline.
	g.markGameDeadlineDirty(S(s["id"]))
}
func (g *Games) allowed(tx *DB, uid string, s M) {
	g.a.Service.Member(tx, uid, S(s["serverId"]))
	if gameSeat(s, uid) < 0 {
		g.requireVoice(tx, uid, S(s["channelId"]))
	}
}
func (g *Games) summary(s M, uid string) M {
	return M{"id": s["id"], "channelId": s["channelId"], "kind": s["kind"], "hostId": s["hostId"], "hostName": s["hostName"], "status": s["status"], "players": len(gameSeats(s)), "maxPlayers": Obj(s["settings"])["maxPlayers"], "minPlayers": gameLimits[S(s["kind"])][0], "paused": N(s["pausedUntil"]) != 0, "seated": gameSeat(s, uid) >= 0}
}
func gameJoinable(s M) bool {
	return S(s["status"]) == "waiting" || (S(s["status"]) == "playing" && S(s["kind"]) == "poker" && S(Obj(s["state"])["phase"]) == "between")
}
func (g *Games) List(uid, channel string) any {
	g.requireVoice(g.a.DB, uid, channel)
	out := []M{}
	for _, r := range g.a.DB.All("SELECT state FROM game_sessions WHERE channel_id=? AND status<>'finished' ORDER BY updated_at DESC LIMIT 60", channel) {
		out = append(out, g.summary(Obj(Parse(S(r["state"]))), uid))
	}
	return out
}
func (g *Games) View(uid, id string) any {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.tickGame(id)
	return g.view(uid, id)
}
func (g *Games) view(uid, id string) M {
	return g.a.DB.Tx(func(tx *DB) any {
		s := g.load(tx, id)
		g.allowed(tx, uid, s)
		self := gameSeat(s, uid)
		voice := tx.One("SELECT user_id FROM voice_members WHERE user_id=? AND channel_id=?", uid, s["channelId"]) != nil
		state := Obj(s["state"])
		project := M{"phase": "lobby"}
		deadline := N(state["deadline"])
		if s["state"] != nil {
			project = gameProject(S(s["kind"]), state, self)
		}
		if S(s["status"]) == "waiting" {
			deadline = N(s["createdAt"]) + 600000
		}
		return Merge(g.summary(s, uid), M{"revision": s["revision"], "seats": s["seats"], "settings": s["settings"], "self": self, "canPlay": self < 0 && voice && N(s["pausedUntil"]) == 0 && gameJoinable(s) && len(gameSeats(s)) < gi(Obj(s["settings"])["maxPlayers"]), "canStart": S(s["status"]) == "waiting" && uid == S(s["hostId"]) && voice && N(s["pausedUntil"]) == 0 && len(gameSeats(s)) >= gameLimits[S(s["kind"])][0], "deadline": deadline, "serverNow": g.now(), "pausedUntil": s["pausedUntil"], "result": s["result"], "state": project})
	}).(M)
}
func (g *Games) busy(tx *DB, uid, except string) bool {
	return tx.One("SELECT p.user_id FROM game_players p JOIN game_sessions g ON g.id=p.game_id WHERE p.user_id=? AND g.status<>'finished' AND g.id<>?", uid, except) != nil
}
func (g *Games) free(tx *DB, uid, except string) {
	Check(!g.busy(tx, uid, except) && tx.One("SELECT id FROM chess_games WHERE status<>'finished' AND (white_id=? OR black_id=?)", uid, uid) == nil, 409, "CAPACITY", "Finish or leave your existing game first.")
}
func (g *Games) create(uid string, b M) any {
	g.mu.Lock()
	defer g.mu.Unlock()
	validateGameCreate(b)
	r := Obj(g.a.Service.Mutate(uid, S(b["requestId"]), "game.create", b, func(tx *DB) any {
		channel := g.requireVoice(tx, uid, S(b["channelId"]))
		g.free(tx, uid, "")
		total := tx.One("SELECT (SELECT COUNT(*) FROM game_sessions WHERE status<>'finished')+(SELECT COUNT(*) FROM chess_games WHERE status<>'finished') AS n")
		Check(N(total["n"]) < 60, 409, "CAPACITY", "The game limit is reached. Try again later.")
		user := tx.One("SELECT display_name FROM users WHERE id=?", uid)
		now := g.now()
		s := M{"id": ID(), "serverId": channel["server_id"], "channelId": b["channelId"], "hostId": uid, "hostName": user["display_name"], "kind": b["kind"], "settings": b["settings"], "seats": []any{M{"id": uid, "name": user["display_name"], "left": false, "grace": 30000, "missingAt": 0}}, "status": "waiting", "revision": 1, "createdAt": now, "updatedAt": now, "pausedUntil": 0, "pauseStarted": 0, "result": nil, "state": nil}
		tx.Run("DELETE FROM game_sessions WHERE id IN (SELECT id FROM game_sessions WHERE status='finished' ORDER BY updated_at DESC LIMIT 10000 OFFSET 99)")
		g.save(tx, s, true)
		return M{"id": s["id"]}
	}))
	g.changed(S(r["id"]), nil)
	g.reconcile()
	return g.view(uid, S(r["id"]))
}
func (g *Games) command(uid, id string, b M) any {
	g.mu.Lock()
	defer g.mu.Unlock()
	validateGameCommand(b)
	now := g.now()
	rate := g.rates[uid]
	if now-rate[0] > 1000 {
		rate = [2]int64{now, 1}
	} else {
		rate[1]++
	}
	g.rates[uid] = rate
	Check(rate[1] <= 20, 429, "RATE_LIMIT", "Slow down a little.")
	g.tickGame(id)
	r := Obj(g.a.Service.Mutate(uid, S(b["requestId"]), "game.command", Merge(M{"id": id}, b), func(tx *DB) any {
		s := g.load(tx, id)
		g.allowed(tx, uid, s)
		Check(S(s["status"]) != "finished", 409, "GAME_FINISHED", "This game has ended.")
		a, state := Obj(b["action"]), Obj(s["state"])
		concurrent := (S(s["kind"]) == "drawing" || S(s["kind"]) == "telephone") && S(b["kind"]) == "action" && a != nil && S(a["token"]) == S(state["token"])
		Check(N(s["revision"]) == N(b["revision"]) || concurrent, 409, "STALE_GAME", "The game changed. Review the latest state.")
		roster := false
		seat := gameSeat(s, uid)
		kind := S(b["kind"])
		if kind != "leave" && kind != "close" {
			g.requireVoice(tx, uid, S(s["channelId"]))
		}
		if kind == "join" {
			Check(seat < 0, 409, "SEAT_TAKEN", "You already have a seat.")
			Check(gameJoinable(s) && N(s["pausedUntil"]) == 0 && len(gameSeats(s)) < gi(Obj(s["settings"])["maxPlayers"]), 409, "SEAT_TAKEN", "Seats are unavailable now. You can keep watching.")
			g.free(tx, uid, id)
			for _, p := range gameSeats(s) {
				Check(tx.One("SELECT user_id FROM user_blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)", uid, p["id"], p["id"], uid) == nil, 403, "FORBIDDEN", "This game is unavailable.")
			}
			user := tx.One("SELECT display_name FROM users WHERE id=?", uid)
			seats := Arr(s["seats"])
			seat = len(seats)
			for i, v := range seats {
				if B(Obj(v)["left"]) {
					seat = i
					break
				}
			}
			person := M{"id": uid, "name": user["display_name"], "left": false, "grace": 30000, "missingAt": 0}
			if seat == len(seats) {
				seats = append(seats, person)
			} else {
				seats[seat] = person
			}
			s["seats"] = seats
			if s["state"] != nil {
				pokerJoin(state, Obj(s["settings"]), seat)
				active := Arr(state["active"])
				for len(active) <= seat {
					active = append(active, false)
				}
				active[seat] = true
				state["active"] = active
			}
			roster = true
		} else {
			Check(seat >= 0, 403, "FORBIDDEN", "Spectators cannot change a game.")
			switch kind {
			case "close":
				Check(S(s["hostId"]) == uid && S(s["status"]) == "waiting", 403, "FORBIDDEN", "Only the host can close the waiting game.")
				s["status"] = "finished"
				s["result"] = "Lobby closed"
			case "leave":
				g.remove(s, seat, g.now())
				gameReconcilePause(s, g.now())
				roster = true
			case "start":
				Check(S(s["hostId"]) == uid && S(s["status"]) == "waiting" && N(s["pausedUntil"]) == 0 && len(gameSeats(s)) >= gameLimits[S(s["kind"])][0], 409, "NOT_READY", "Wait for enough players to join.")
				seats := []any{}
				for _, p := range gameSeats(s) {
					g.requireVoice(tx, S(p["id"]), S(s["channelId"]))
					seats = append(seats, p)
				}
				s["seats"] = seats
				s["state"] = startGameEngine(S(s["kind"]), len(seats), Obj(s["settings"]), g.now())
				s["status"] = "playing"
				roster = true
			default:
				Check(S(s["status"]) == "playing" && N(s["pausedUntil"]) == 0, 409, "PAUSED", "Wait for the players to return to voice.")
				Check(S(a["type"]) != "next" || uid == S(s["hostId"]), 403, "FORBIDDEN", "Only the host can start the next round.")
				gameAct(S(s["kind"]), state, seat, a, Obj(s["settings"]), g.now())
				gameComplete(s)
			}
		}
		s["revision"] = N(s["revision"]) + 1
		g.save(tx, s, roster)
		r := M{"id": id}
		if kind == "action" && (S(a["type"]) == "stroke" || S(a["type"]) == "clear") {
			canvas := M{"id": id, "revision": s["revision"], "serverNow": g.now(), "token": a["token"], "seat": seat, "requestId": b["requestId"], "type": a["type"]}
			if a["stroke"] != nil {
				canvas["stroke"] = a["stroke"]
			}
			r["canvas"] = canvas
		}
		return r
	}))
	var canvas M
	if r["canvas"] != nil {
		canvas = Obj(r["canvas"])
	}
	g.changed(id, canvas)
	if S(b["kind"]) == "join" || S(b["kind"]) == "start" {
		g.reconcile()
	}
	if S(b["kind"]) == "leave" {
		return M{"left": true, "id": id}
	}
	return g.view(uid, id)
}
func gameComplete(s M) {
	if state := Obj(s["state"]); s["state"] != nil && state["result"] != nil {
		s["status"] = "finished"
		s["result"] = state["result"]
		s["pausedUntil"] = 0
	}
}
func (g *Games) remove(s M, seat int, now int64) {
	person := Obj(Arr(s["seats"])[seat])
	person["left"] = true
	person["missingAt"] = 0
	if state := Obj(s["state"]); s["state"] != nil {
		previous := N(state["deadline"])
		gameDepart(S(s["kind"]), state, seat, Obj(s["settings"]), now)
		if N(s["pauseStarted"]) != 0 && N(state["deadline"]) != previous {
			s["pauseStarted"] = now
		}
	}
	gameComplete(s)
	remaining := gameSeats(s)
	if len(remaining) == 0 {
		s["status"] = "finished"
		s["result"] = "Game closed"
		s["pausedUntil"] = 0
	} else if S(person["id"]) == S(s["hostId"]) {
		host := remaining[0]
		for _, p := range remaining {
			if N(p["missingAt"]) == 0 {
				host = p
				break
			}
		}
		s["hostId"] = host["id"]
		s["hostName"] = host["name"]
	}
}
func gameReconcilePause(s M, now int64) {
	until := int64(0)
	for _, p := range gameSeats(s) {
		if N(p["missingAt"]) != 0 {
			d := N(p["missingAt"]) + N(p["grace"])
			if until == 0 || d < until {
				until = d
			}
		}
	}
	s["pausedUntil"] = until
	if until == 0 && N(s["pauseStarted"]) != 0 {
		elapsed := now - N(s["pauseStarted"])
		state := Obj(s["state"])
		if N(state["deadline"]) != 0 {
			state["deadline"] = N(state["deadline"]) + elapsed
		}
		if N(state["started"]) != 0 {
			state["started"] = N(state["started"]) + elapsed
		}
		s["pauseStarted"] = 0
	} else if until != 0 && N(s["pauseStarted"]) == 0 {
		s["pauseStarted"] = now
	}
}
func gameDeadline(s M) int64 {
	if S(s["status"]) == "waiting" {
		d := N(s["createdAt"]) + 600000
		if p := N(s["pausedUntil"]); p != 0 && p < d {
			return p
		}
		return d
	}
	if p := N(s["pausedUntil"]); p != 0 {
		return p
	}
	if d := N(Obj(s["state"])["deadline"]); d != 0 {
		return d
	}
	return N(s["updatedAt"]) + 7200000
}
func (g *Games) tickGame(id string) {
	r := g.a.DB.One("SELECT state FROM game_sessions WHERE id=? AND status<>'finished'", id)
	if r == nil {
		delete(g.observed, id)
		delete(g.deadlineDirty, "game:"+id)
		return
	}
	s := Obj(Parse(S(r["state"])))
	if gameDeadline(s) > g.now() {
		// A due wake can race a newer committed deadline. Use the fresh row and
		// repair scheduling instead of repeatedly waking at its stale deadline.
		g.observed[id] = gameObservation(s)
		delete(g.deadlineDirty, "game:"+id)
		return
	}
	g.a.DB.Tx(func(tx *DB) any {
		s = g.load(tx, id)
		now := g.now()
		if S(s["status"]) == "finished" || gameDeadline(s) > now {
			return nil
		}
		roster := false
		if S(s["status"]) == "waiting" && now >= N(s["createdAt"])+600000 {
			s["status"] = "finished"
			s["result"] = "Lobby expired"
		} else if N(s["pausedUntil"]) != 0 {
			for i, p := range Arr(s["seats"]) {
				seat := Obj(p)
				if !B(seat["left"]) && N(seat["missingAt"]) != 0 && now >= N(seat["missingAt"])+N(seat["grace"]) {
					g.remove(s, i, now)
					roster = true
				}
			}
			gameReconcilePause(s, now)
		} else if state := Obj(s["state"]); s["state"] != nil {
			gameTimeout(S(s["kind"]), state, Obj(s["settings"]), now)
			gameComplete(s)
		}
		s["revision"] = N(s["revision"]) + 1
		g.save(tx, s, roster)
		return nil
	})
	g.changed(id, nil)
}
func (g *Games) tick() {
	for _, r := range g.a.DB.All("SELECT id FROM game_sessions WHERE status<>'finished'") {
		g.tickGame(S(r["id"]))
	}
	g.chessTick()
	for uid, r := range g.rates {
		if g.now()-r[0] > 60000 {
			delete(g.rates, uid)
		}
	}
}
func (g *Games) initialize() {
	games := map[string]M{}
	chess := map[string]*ChessGame{}
	g.a.DB.Tx(func(tx *DB) any {
		for _, r := range tx.All("SELECT state FROM game_sessions WHERE status<>'finished'") {
			s := Obj(Parse(S(r["state"])))
			if S(s["status"]) != "playing" {
				games[S(s["id"])] = gameObservation(s)
				continue
			}
			now := g.now()
			if N(s["pauseStarted"]) == 0 || N(s["pauseStarted"]) > now {
				s["pauseStarted"] = now
			}
			for _, p := range gameSeats(s) {
				if N(p["missingAt"]) != 0 {
					grace := N(p["grace"]) - (now - N(p["missingAt"]))
					if grace < 0 {
						grace = 0
					}
					p["grace"] = grace
				}
				p["missingAt"] = now
			}
			gameReconcilePause(s, now)
			s["revision"] = N(s["revision"]) + 1
			g.save(tx, s, false)
			games[S(s["id"])] = gameObservation(s)
		}
		g.chessInitialize(tx)
		for _, r := range tx.All("SELECT state FROM chess_games WHERE status<>'finished'") {
			c := &ChessGame{}
			gameDecode(Parse(S(r["state"])), c)
			chess[c.ID] = c
		}
		return nil
	})
	// Publish only after commit. A failed/rolled-back save must not change the
	// deadline seen by the timer. Every subsequent save is published by changed
	// or chessChanged after its owning transaction has committed.
	g.observed = games
	g.chessObserved = chess
	g.deadlineDirty = map[string]bool{}
}
func (g *Games) ReconcileVoice() {
	g.mu.Lock()
	defer g.mu.Unlock()
	select {
	case <-g.stop:
		return
	default:
	}
	g.reconcile()
}
func (g *Games) reconcile() {
	voice := map[string]string{}
	for _, r := range g.a.DB.All("SELECT user_id,channel_id FROM voice_members") {
		voice[S(r["user_id"])] = S(r["channel_id"])
	}
	for _, r := range g.a.DB.All("SELECT id FROM game_sessions WHERE status<>'finished'") {
		id := S(r["id"])
		g.tickGame(id)
		changed := false
		g.a.DB.Tx(func(tx *DB) any {
			s := g.load(tx, id)
			if S(s["status"]) == "finished" {
				return nil
			}
			now := g.now()
			for _, p := range gameSeats(s) {
				present := voice[S(p["id"])] == S(s["channelId"]) && g.online(S(p["id"]))
				if present && N(p["missingAt"]) != 0 {
					grace := N(p["grace"]) - (now - N(p["missingAt"]))
					if grace < 0 {
						grace = 0
					}
					p["grace"] = grace
					p["missingAt"] = 0
					changed = true
				} else if !present && N(p["missingAt"]) == 0 {
					p["missingAt"] = now
					changed = true
				}
			}
			if changed {
				gameReconcilePause(s, now)
				s["revision"] = N(s["revision"]) + 1
				g.save(tx, s, false)
			}
			return nil
		})
		if changed {
			g.changed(id, nil)
		}
	}
	g.chessReconcile()
}
func (g *Games) Presence(uid string, online bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	select {
	case <-g.stop:
		return
	default:
	}
	g.chessPresence(uid, online)
	g.reconcile()
}
func (g *Games) changed(id string, canvas M) {
	g.schedule()
	r := g.a.DB.One("SELECT state FROM game_sessions WHERE id=?", id)
	if r == nil {
		delete(g.observed, id)
		delete(g.deadlineDirty, "game:"+id)
		return
	}
	s := Obj(Parse(S(r["state"])))
	previous := g.observed[id]
	roster := func(s M) []any {
		out := []any{}
		for _, p := range gameSeats(s) {
			out = append(out, p["id"])
		}
		return out
	}
	directory := previous == nil || S(s["status"]) != S(previous["status"]) || S(s["hostId"]) != S(previous["hostId"]) || JSON(roster(s)) != JSON(roster(previous)) || (N(s["pausedUntil"]) != 0) != (N(previous["pausedUntil"]) != 0) || (S(s["kind"]) == "poker" && (S(Obj(s["state"])["phase"]) == "between") != (S(Obj(previous["state"])["phase"]) == "between"))
	if S(s["status"]) == "finished" {
		delete(g.observed, id)
	} else {
		g.observed[id] = gameObservation(s)
	}
	delete(g.deadlineDirty, "game:"+id)
	audience := map[string]bool{}
	for _, r := range g.a.DB.All("SELECT user_id FROM voice_members WHERE channel_id=?", s["channelId"]) {
		audience[S(r["user_id"])] = true
	}
	for _, v := range Arr(s["seats"]) {
		audience[S(Obj(v)["id"])] = true
	}
	for _, viewer := range g.a.Hub.Viewers() {
		uid := S(viewer["userId"])
		if !audience[uid] {
			continue
		}
		if canvas == nil {
			g.a.Hub.EmitSocket(S(viewer["socketId"]), "game:changed", M{"id": id, "channelId": s["channelId"], "revision": s["revision"], "directoryChanged": directory})
		} else if S(viewer["gameWatching"]) == id && (S(s["kind"]) != "telephone" || S(Obj(Arr(s["seats"])[gi(canvas["seat"])])["id"]) == uid) {
			g.a.Hub.EmitSocket(S(viewer["socketId"]), "game:canvas", canvas)
		}
	}
}
func (g *Games) RegisterRoutes() {
	a := g.a
	a.Route("GET", "/api/v1/games", true, func(r *Request) any {
		c := r.Query("channelId")
		return M{"games": g.List(r.UID(), c), "chess": g.ChessList(r.UID(), c)}
	})
	a.Route("POST", "/api/v1/games", true, func(r *Request) any { return g.create(r.UID(), r.Body) })
	a.Route("GET", "/api/v1/games/{id}", true, func(r *Request) any { return g.View(r.UID(), r.Param("id")) })
	a.Route("POST", "/api/v1/games/{id}", true, func(r *Request) any { return g.command(r.UID(), r.Param("id"), r.Body) })
	a.Route("GET", "/api/v1/chess", true, func(r *Request) any {
		if c := r.Query("channelId"); c != "" {
			return M{"games": g.ChessList(r.UID(), c)}
		}
		return M{"games": g.chessServerList(r.UID(), r.Query("serverId"))}
	})
	a.Route("POST", "/api/v1/chess", true, func(r *Request) any { return g.chessCreate(r.UID(), r.Body) })
	a.Route("GET", "/api/v1/chess/{id}", true, func(r *Request) any { return g.ChessView(r.UID(), r.Param("id")) })
	a.Route("POST", "/api/v1/chess/{id}", true, func(r *Request) any { return g.chessCommand(r.UID(), r.Param("id"), r.Body) })
}
func gameDecode(v any, out any) {
	if err := json.Unmarshal([]byte(JSON(v)), out); err != nil {
		Fail(400, "VALIDATION", "Invalid game data.")
	}
}

var gamesEpoch = time.Now()

func gamesNow() int64 { return gamesEpoch.UnixMilli() + time.Since(gamesEpoch).Milliseconds() }
