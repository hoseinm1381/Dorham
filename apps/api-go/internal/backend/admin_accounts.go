package backend

import (
	"path/filepath"
	"strconv"
)

const deletedAccountName = "Deleted account"

var accountAdminActions = []string{"ban", "unban", "revoke", "resetPassword", "setPassword", "delete"}

func (a *App) registerAdmin() {
	a.Route("GET", "/api/v1/admin/capabilities", true, func(r *Request) any {
		Administrator(a.DB, r.UID())
		return M{"version": 1, "userActions": accountAdminActions, "usersPagination": true, "deletionMode": "anonymizeKeepMessages", "featureManagement": true}
	})
	a.Route("GET", "/api/v1/admin/users", true, func(r *Request) any {
		Administrator(a.DB, r.UID())
		offset := int64(0)
		if raw := r.Query("offset"); raw != "" {
			value, err := strconv.ParseInt(raw, 10, 64)
			Check(err == nil && value >= 0 && value <= 1000000, 400, "VALIDATION", "Invalid user page offset.")
			offset = value
		}
		rows := []M{}
		for _, u := range a.DB.All("SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at,id LIMIT 250 OFFSET ?", offset) {
			rows = append(rows, PublicUser(u))
		}
		return M{"users": rows}
	})
	a.Route("GET", "/api/v1/admin/audit", true, func(r *Request) any {
		Administrator(a.DB, r.UID())
		before := Now() + 1
		if r.Query("before") != "" {
			v, e := strconv.ParseInt(r.Query("before"), 10, 64)
			Check(e == nil && v > 0, 400, "VALIDATION", "Invalid before")
			before = v
		}
		return M{"events": a.DB.All("SELECT * FROM audit_log WHERE created_at<? ORDER BY created_at DESC LIMIT 100", before)}
	})
	a.Route("GET", "/api/v1/admin/metrics", true, func(r *Request) any {
		Administrator(a.DB, r.UID())
		return a.metrics()
	})
	a.Route("POST", "/api/v1/admin/users/{id}", true, a.manageAccount)
}

func (a *App) manageAccount(r *Request) any {
	actor, target := r.UID(), VID(r.Param("id"))
	Administrator(a.DB, actor)
	action, rid := VEnum(r.Body, "action", accountAdminActions), RID(r.Body)
	temporary, encoded := "", ""
	switch action {
	case "resetPassword":
		temporary = Token()[:20]
		encoded = PasswordHash(temporary)
	case "setPassword":
		encoded = PasswordHash(VString(r.Body, "password", 8, 128, false))
	}

	var avatar string
	var gameIDs, chessIDs []string
	func() {
		if action == "delete" {
			// Match the game service's lock order before changing game state.
			a.Games.mu.Lock()
			defer a.Games.mu.Unlock()
		}
		a.DB.Tx(func(tx *DB) any {
			requireLiveSession(tx, r)
			Check(!Bool(Administrator(tx, actor), "must_change_password"), 403, "PASSWORD_CHANGE_REQUIRED", "Change your temporary password before continuing.")
			Check(tx.One("SELECT request_id FROM mutations WHERE user_id=? AND request_id=?", actor, rid) == nil, 409, "ALREADY_APPLIED", "Administrative action was already applied.")
			u := tx.One("SELECT * FROM users WHERE id=?", target)
			Check(u != nil && !Bool(u, "instance_admin"), 403, "PROTECTED_ACCOUNT", "The global administrator cannot be modified by this operation.")
			Check(u["deleted_at"] == nil, 409, "ACCOUNT_DELETED", "This account has already been deleted.")

			switch action {
			case "ban", "unban":
				tx.Run("UPDATE users SET banned=? WHERE id=?", action == "ban", target)
			case "resetPassword", "setPassword":
				Check(!Bool(u, "guest"), 400, "GUEST_ACCOUNT", "Guest accounts do not have passwords.")
				tx.Run("UPDATE users SET password_hash=?,must_change_password=1,recovery_prompt_seen=0 WHERE id=?", encoded, target)
				clearAccountRecovery(tx, target)
			case "delete":
				Check(Str(r.Body, "confirmUsername") == Str(u, "username"), 400, "CONFIRMATION_REQUIRED", "Type the exact username to delete the account.")
				gameIDs, chessIDs = a.Games.deleteAccountFromGames(tx, target)
				avatar = deleteManagedAccount(tx, u, actor)
			}
			if action != "unban" {
				tx.Run("DELETE FROM used_refresh WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?)", target)
				tx.Run("DELETE FROM sessions WHERE user_id=?", target)
				tx.Run("DELETE FROM voice_members WHERE user_id=?", target)
				ReconcileShares(tx, a.C)
			}
			// The receipt stores action and target only, never a password or its hash.
			fingerprint := Hash(`{"targetId":` + JSON(target) + `,"action":` + JSON(action) + `}`)
			tx.Run("INSERT INTO mutations(user_id,request_id,operation,fingerprint,response,created_at) VALUES(?,?,?,?,?,?)", actor, rid, "admin.user", fingerprint, `{"success":true}`, Now())
			Audit(tx, actor, "admin."+action, target, nil)
			return nil
		})
		for _, id := range gameIDs {
			a.Hub.safe(func() { a.Games.changed(id, nil) })
		}
		for _, id := range chessIDs {
			a.Hub.safe(func() { a.Games.chessChanged(id) })
		}
	}()
	if avatar != "" {
		mediaRetire(filepath.Join(a.C.DataDir, "avatars"), avatar)
	}
	if action != "unban" {
		a.Hub.DisconnectInvalid()
		a.Hub.safe(func() { a.Hub.Notify("voice:changed", M{}) })
	}
	a.Hub.Notify("state:changed", M{})
	result := M{"success": true}
	if temporary != "" {
		result["temporaryPassword"] = temporary
	}
	return result
}

func clearAccountRecovery(tx *DB, uid string) {
	tx.Run("DELETE FROM recovery_codes WHERE user_id=?", uid)
	tx.Run("DELETE FROM recovery_questions WHERE user_id=?", uid)
}

func deleteManagedAccount(tx *DB, user M, actor string) string {
	uid := Str(user, "id")
	now := Now()
	for _, server := range tx.All("SELECT id FROM servers WHERE owner_id=?", uid) {
		tx.Run("UPDATE servers SET owner_id=? WHERE id=?", actor, server["id"])
		tx.Run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES(?,?,'owner',?) ON CONFLICT(server_id,user_id) DO UPDATE SET role='owner'", server["id"], actor, now)
	}
	clearAccountRecovery(tx, uid)
	for _, table := range []string{"members", "user_tags", "voice_restrictions", "server_timeouts", "server_bans", "read_cursors", "mutations", "reactions", "message_mentions"} {
		tx.Run("DELETE FROM "+table+" WHERE user_id=?", uid)
	}
	tx.Run("DELETE FROM invites WHERE created_by=?", uid)
	tx.Run("DELETE FROM user_blocks WHERE user_id=? OR blocked_id=?", uid, uid)
	tx.Run("DELETE FROM recovery_attempts WHERE subject=?", Hash(Str(user, "username")))
	tx.Run("UPDATE dm_members SET hidden=1 WHERE user_id=?", uid)
	// The original ID stays available to message and attachment foreign keys.
	// A reserved internal username cannot be used to sign in on older binaries.
	tx.Run("UPDATE users SET username=?,display_name=?,bio='',avatar=NULL,rank_badge='',profile_frame='',profile_banner='',profile_accent='',profile_badge='',profile_badge_award='',catalog_avatar='',speech_plus=0,status='offline',guest=0,banned=1,must_change_password=0,password_hash='!deleted',language='',recovery_prompt_seen=0,deleted_at=? WHERE id=?",
		"!deleted:"+uid, deletedAccountName, now, uid)
	retireMessageSnapshots(tx, uid)
	avatar := Str(user, "avatar")
	if avatar != "" && tx.One("SELECT avatar FROM users WHERE avatar=? UNION ALL SELECT icon FROM servers WHERE icon=? LIMIT 1", avatar, avatar) == nil {
		return avatar
	}
	return ""
}

func deletedAccountView(uid string) M {
	return M{"id": uid, "username": "", "displayName": deletedAccountName, "bio": "", "avatar": nil, "status": "offline", "deleted": true}
}

// Retained events and message mutation receipts contain denormalized profiles.
// Update those copies atomically without changing content, IDs or sequences.
func retireMessageSnapshots(tx *DB, uid string) {
	match := "%" + JSON(uid) + "%"
	const batch = 200
	for after := ""; ; {
		rows := tx.All("SELECT id,payload FROM events WHERE id>? AND kind='message' AND payload LIKE ? ORDER BY id LIMIT ?", after, match, batch)
		for _, event := range rows {
			after = Str(event, "id")
			payload := Obj(Parse(Str(event, "payload")))
			if retireMessageProfile(payload, uid) {
				tx.Run("UPDATE events SET payload=? WHERE id=?", JSON(payload), after)
			}
		}
		if len(rows) < batch {
			break
		}
	}
	for user, request := "", ""; ; {
		rows := tx.All("SELECT user_id,request_id,response FROM mutations WHERE (user_id,request_id)>(?,?) AND operation IN ('message.send','message.change') AND response LIKE ? ORDER BY user_id,request_id LIMIT ?", user, request, match, batch)
		for _, receipt := range rows {
			user, request = Str(receipt, "user_id"), Str(receipt, "request_id")
			response := Obj(Parse(Str(receipt, "response")))
			if retireMessageProfile(Obj(response["payload"]), uid) {
				tx.Run("UPDATE mutations SET response=? WHERE user_id=? AND request_id=?", JSON(response), user, request)
			}
		}
		if len(rows) < batch {
			break
		}
	}
}

func retireMessageProfile(message M, uid string) bool {
	changed := false
	if Str(Obj(message["author"]), "id") == uid {
		message["author"] = deletedAccountView(uid)
		changed = true
	}
	mentions := Arr(message["mentions"])
	kept := make([]any, 0, len(mentions))
	for _, mention := range mentions {
		if Str(Obj(mention), "userId") != uid {
			kept = append(kept, mention)
		}
	}
	if len(kept) != len(mentions) {
		message["mentions"] = kept
		changed = true
	}
	reactions := Arr(message["reactions"])
	kept = make([]any, 0, len(reactions))
	for _, raw := range reactions {
		reaction := Obj(raw)
		ids := Arr(reaction["userIds"])
		users := make([]any, 0, len(ids))
		for _, id := range ids {
			if S(id) != uid {
				users = append(users, id)
			}
		}
		if len(users) != len(ids) {
			reaction["userIds"] = users
			changed = true
		}
		if len(users) != 0 {
			kept = append(kept, reaction)
		}
	}
	if changed {
		message["reactions"] = kept
	}
	return changed
}
