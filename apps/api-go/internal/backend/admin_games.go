package backend

// The caller holds g.mu and commits account deletion and game changes together.
func (g *Games) deleteAccountFromGames(tx *DB, uid string) (games, chess []string) {
	for _, row := range tx.All("SELECT id,state FROM game_sessions WHERE host_id=? OR state LIKE ?", uid, "%"+JSON(uid)+"%") {
		state := Obj(Parse(Str(row, "state")))
		changed := false
		for _, raw := range Arr(state["seats"]) {
			seat := Obj(raw)
			if Str(seat, "id") == uid {
				seat["name"] = deletedAccountName
				changed = true
			}
		}
		if Str(state, "hostId") == uid {
			state["hostName"] = deletedAccountName
			changed = true
		}
		if !changed {
			continue
		}
		if seat := gameSeat(state, uid); seat >= 0 && Str(state, "status") != "finished" {
			g.remove(state, seat, g.now())
			gameReconcilePause(state, g.now())
		}
		state["revision"] = Num(state, "revision") + 1
		g.save(tx, state, true)
		games = append(games, Str(row, "id"))
	}
	tx.Run("DELETE FROM game_players WHERE user_id=?", uid)
	for _, row := range tx.All("SELECT id FROM chess_games WHERE white_id=? OR black_id=?", uid, uid) {
		id := Str(row, "id")
		game := g.chessLoad(tx, id)
		if game.WhiteID == uid {
			game.WhiteName = deletedAccountName
		}
		if chessString(game.BlackID) == uid {
			game.BlackName = deletedAccountName
		}
		if game.Status != "finished" {
			game.Status = "finished"
			game.Result = "Match ended because a player account was deleted"
			game.OpenSeat = false
			game.PausedUntil = 0
		}
		game.Revision++
		g.chessSave(tx, game)
		chess = append(chess, id)
	}
	return games, chess
}
