package backend

func screenHDAllowed(db *DB, uid string, settings M) bool {
	return Str(settings, "visibility") != "" && Str(settings, "visibility") != "hidden" && featureAvailable(db, uid, "screen1080")
}

func screenHDAdmission(db *DB, uid string, c Config) int64 {
	settings := featureSetting(db, "screen")
	Check(screenHDAllowed(db, uid, settings), 403, "FEATURE_REQUIRED", "1080p screen sharing is unavailable.")
	Check(db.One("SELECT id FROM share_leases WHERE quality_height=1080 AND user_id<>? AND expires_at>=?", uid, Now()) == nil, 409, "SHARE_LIMIT", "The 1080p sharing slot is busy. Try 720p.")
	return min(N(settings["bitrate"]), int64(c.ScreenMaxBitrate))
}

func reconcileHD(db *DB, c Config) {
	active := db.One("SELECT id,user_id,quality_bitrate FROM share_leases WHERE quality_height=1080 LIMIT 1")
	if active == nil {
		return
	}
	settings := featureSetting(db, "screen")
	if !screenHDAllowed(db, Str(active, "user_id"), settings) {
		db.Run("UPDATE share_leases SET quality_height=720,quality_bitrate=0,policy_revision=policy_revision+1 WHERE id=?", active["id"])
	} else if bitrate := min(N(settings["bitrate"]), int64(c.ScreenMaxBitrate)); bitrate != N(active["quality_bitrate"]) {
		db.Run("UPDATE share_leases SET quality_bitrate=?,policy_revision=policy_revision+1 WHERE id=?", bitrate, active["id"])
	}
}

func (a *App) refreshHDPolicy() {
	changed := a.DB.Tx(func(tx *DB) any {
		active := tx.One("SELECT id FROM share_leases WHERE quality_height=1080 LIMIT 1")
		if active == nil {
			return false
		}
		reconcileHD(tx, a.C)
		return true
	})
	if changed == true {
		a.Hub.Notify("voice:changed", M{})
	}
}
