package backend

import (
	"net/http"
	"strings"
)

var featureNames = []string{"screen1080", "ttsPlus", "profilePlus", "emojiPlus", "soundboardPlus", "uploadsPlus", "communityPlus"}
var rankBadges = []string{"none", "plus", "pro", "ultra", "max"}
var featurePlatforms = []string{"all", "web", "windows", "android"}
var screenVisibility = []string{"hidden", "selected", "locked"}

func featureSetting(db *DB, id string) M {
	if row := db.One("SELECT value FROM feature_settings WHERE id=?", id); row != nil {
		return Obj(Parse(Str(row, "value")))
	}
	return M{}
}

func writeFeatureSetting(db *DB, id string, value M) {
	db.Run("INSERT INTO feature_settings(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,revision=feature_settings.revision+1", id, JSON(value))
}

func featureGranted(db *DB, uid, feature string) bool {
	return db.One("SELECT user_id FROM account_features WHERE user_id=? AND feature=? AND (expires_at=0 OR expires_at>?)", uid, feature, Now()) != nil
}

func communityGranted(db *DB, server string) bool {
	return server != "" && db.One("SELECT server_id FROM community_features WHERE server_id=? AND feature='communityPlus' AND (expires_at=0 OR expires_at>?)", server, Now()) != nil
}

func featureAdmin(r *Request, fn func(*DB) any) any {
	return r.A.DB.Tx(func(tx *DB) any {
		requireLiveSession(tx, r)
		Check(!Bool(Administrator(tx, r.UID()), "must_change_password"), 403, "PASSWORD_CHANGE_REQUIRED", "Change your temporary password before continuing.")
		return fn(tx)
	})
}

func accountFeatureView(db *DB, uid string) M {
	row := db.One("SELECT rank_badge,speech_plus FROM users WHERE id=? AND deleted_at IS NULL", uid)
	Check(row != nil, 404, "NOT_FOUND", "Account not found.")
	grants := M{}
	for _, g := range db.All("SELECT feature,expires_at FROM account_features WHERE user_id=? AND (expires_at=0 OR expires_at>?)", uid, Now()) {
		grants[Str(g, "feature")] = N(g["expires_at"])
	}
	rank := Str(row, "rank_badge")
	if rank == "" {
		rank = "none"
	}
	return M{"rank": rank, "grants": grants, "plusSelected": Bool(row, "speech_plus")}
}

func (a *App) featureChanged(uid string) {
	if uid == "" {
		a.Hub.emit("features:changed", M{})
	} else {
		a.Hub.EmitUser(uid, "features:changed", M{})
	}
}

func (a *App) registerFeatures() {
	a.Route("GET", "/api/v1/features", true, func(r *Request) any {
		r.Header("Cache-Control", "private, no-store")
		return a.DB.Tx(func(tx *DB) any {
			requireLiveSession(tx, r)
			self := accountFeatureView(tx, r.UID())
			settings := featureSetting(tx, "features")
			grants := Obj(self["grants"])
			for _, name := range featureNames {
				if enabled, present := settings[name]; present && !B(enabled) {
					delete(grants, name)
				}
			}
			screen := featureSetting(tx, "screen")
			visibility := Str(screen, "visibility")
			if visibility == "" {
				visibility = "hidden"
			}
			_, hd := grants["screen1080"]
			if visibility == "selected" && !hd {
				visibility = "hidden"
			}
			if visibility == "hidden" {
				delete(grants, "screen1080")
			}
			announcements := []M{}
			platform, version := r.Query("platform"), r.Query("version")
			now := Now()
			var announcementBoundary int64
			for _, notice := range tx.All("SELECT * FROM feature_announcements WHERE ends_at>? AND (platform='all' OR platform=?) AND (app_version='' OR app_version=?) ORDER BY starts_at LIMIT 32", now, platform, version) {
				start, end := N(notice["starts_at"]), N(notice["ends_at"])
				boundary := end
				if start > now {
					boundary = start
				} else {
					announcements = append(announcements, M{"id": notice["id"], "en": notice["text_en"], "fa": notice["text_fa"]})
				}
				if announcementBoundary == 0 || boundary < announcementBoundary {
					announcementBoundary = boundary
				}
			}
			voices := []M{}
			if _, allowed := grants["ttsPlus"]; allowed {
				if speech := featureSetting(tx, "speech"); speechEnabled(speech) {
					voices = append(voices, M{"id": "plus", "label": speech["label"]})
				}
			}
			community := map[string]bool{}
			var communityBoundary int64
			if settings["communityPlus"] != false {
				for _, row := range tx.All("SELECT f.server_id,f.expires_at FROM community_features f JOIN members m ON m.server_id=f.server_id WHERE m.user_id=? AND f.feature='communityPlus' AND (f.expires_at=0 OR f.expires_at>?)", r.UID(), now) {
					community[Str(row, "server_id")] = true
					if expires := N(row["expires_at"]); expires > 0 && (communityBoundary == 0 || expires < communityBoundary) {
						communityBoundary = expires
					}
				}
			}
			response := M{"grants": grants, "screen": visibility, "voices": voices, "plusSelected": len(voices) > 0 && Bool(tx.One("SELECT speech_plus FROM users WHERE id=?", r.UID()), "speech_plus"), "announcements": announcements, "announcementBoundary": announcementBoundary, "communityBoundary": communityBoundary, "soundboard": settings["soundboard"] != false}
			memberships := map[string]bool{}
			for _, member := range tx.All("SELECT server_id FROM members WHERE user_id=?", r.UID()) {
				memberships[Str(member, "server_id")] = true
			}
			revision := N(tx.One("SELECT revision FROM feature_settings WHERE id='catalogRevision'")["revision"])
			catalogVersion := Hash(JSON([]any{a.C.PublicURL, revision, grants, community, memberships}))[:24]
			response["catalogVersion"] = catalogVersion
			if r.Query("catalogVersion") != catalogVersion {
				response["catalog"] = featureCatalogView(tx, r.UID(), grants, community, memberships)
			}
			return response
		})
	})
	a.Route("GET", "/api/v1/admin/features", true, func(r *Request) any {
		return featureAdmin(r, func(tx *DB) any {
			return M{"features": featureNames, "settings": featureSetting(tx, "features"), "screen": featureSetting(tx, "screen"), "uploads": featureSetting(tx, "uploads"), "speech": featureSetting(tx, "speech"), "catalog": tx.All("SELECT id,kind,label,pack,access,server_id,free_slot,active,published,bytes,digest FROM feature_catalog ORDER BY kind,label"), "announcements": tx.All("SELECT * FROM feature_announcements ORDER BY starts_at DESC LIMIT 100"), "communities": tx.All("SELECT s.id,s.name,s.community_banner,s.invite_blurb,s.community_emoji_slots,f.expires_at FROM servers s LEFT JOIN community_features f ON f.server_id=s.id AND f.feature='communityPlus' ORDER BY s.name LIMIT 250")}
		})
	})
	a.Route("GET", "/api/v1/admin/features/users/{id}", true, func(r *Request) any {
		r.Header("Cache-Control", "private, no-store")
		return featureAdmin(r, func(tx *DB) any {
			uid := r.Param("id")
			view := accountFeatureView(tx, uid)
			view["ttsPlusUsage"] = speechMeterView(tx, uid, speechMeterMonth())
			return view
		})
	})
	a.Route("PUT", "/api/v1/admin/features/users/{id}", true, func(r *Request) any {
		Strict(r.Body, "rank", "feature", "enabled", "expiresAt", "selectTtsPlus", "requestId")
		uid := r.Param("id")
		result := featureAdmin(r, func(tx *DB) any {
			accountFeatureView(tx, uid)
			if _, found := r.Body["rank"]; found {
				rank := VEnum(r.Body, "rank", rankBadges)
				tx.Run("UPDATE users SET rank_badge=? WHERE id=?", rank, uid)
				Audit(tx, r.UID(), "feature.rank", uid, M{"rank": rank})
			}
			if _, found := r.Body["feature"]; found {
				feature := VEnum(r.Body, "feature", featureNames)
				enabled := VBool(r.Body, "enabled")
				expires := VInt(r.Body, "expiresAt", 0, 4102444800000, true)
				if enabled {
					Check(expires == 0 || expires > Now(), 400, "VALIDATION", "Expiry must be in the future.")
					tx.Run("INSERT INTO account_features(user_id,feature,expires_at) VALUES(?,?,?) ON CONFLICT(user_id,feature) DO UPDATE SET expires_at=excluded.expires_at", uid, feature, expires)
				} else {
					tx.Run("DELETE FROM account_features WHERE user_id=? AND feature=?", uid, feature)
					if feature == "ttsPlus" {
						tx.Run("UPDATE users SET speech_plus=0 WHERE id=?", uid)
					}
				}
				Audit(tx, r.UID(), "feature.account", uid, M{"feature": feature, "enabled": enabled, "expiresAt": expires})
			}
			if _, found := r.Body["selectTtsPlus"]; found {
				Check(VBool(r.Body, "selectTtsPlus"), 400, "VALIDATION", "Use selectTtsPlus to enable the AI voice.")
				Check(featureGranted(tx, uid, "ttsPlus"), 403, "FEATURE_REQUIRED", "Grant TTS Plus before enabling the AI voice.")
				Check(featureSetting(tx, "features")["ttsPlus"] != false && speechEnabled(featureSetting(tx, "speech")), 409, "SPEECH_PROVIDER_UNAVAILABLE", "Configure and enable the speech provider before granting the AI voice.")
				tx.Run("UPDATE users SET speech_plus=1 WHERE id=? AND speech_plus=0", uid)
				Audit(tx, r.UID(), "feature.speech.selected", uid, M{"voice": "plus"})
			}
			return accountFeatureView(tx, uid)
		})
		a.featureChanged(uid)
		if r.Body["feature"] == "screen1080" {
			a.refreshHDPolicy()
		}
		if r.Body["rank"] != nil {
			a.Hub.Notify("state:changed", M{})
			a.Hub.Notify("voice:state:changed", M{})
		}
		return result
	})
	a.Route("PUT", "/api/v1/admin/features/communities/{id}", true, func(r *Request) any {
		Strict(r.Body, "enabled", "expiresAt", "requestId")
		id := r.Param("id")
		enabled := VBool(r.Body, "enabled")
		expires := VInt(r.Body, "expiresAt", 0, 4102444800000, true)
		result := featureAdmin(r, func(tx *DB) any {
			Check(tx.One("SELECT id FROM servers WHERE id=?", id) != nil, 404, "NOT_FOUND", "Community not found.")
			if enabled {
				Check(expires == 0 || expires > Now(), 400, "VALIDATION", "Expiry must be in the future.")
				tx.Run("INSERT INTO community_features(server_id,feature,expires_at) VALUES(?,'communityPlus',?) ON CONFLICT(server_id,feature) DO UPDATE SET expires_at=excluded.expires_at", id, expires)
			} else {
				tx.Run("DELETE FROM community_features WHERE server_id=? AND feature='communityPlus'", id)
			}
			Audit(tx, r.UID(), "feature.community", id, M{"enabled": enabled, "expiresAt": expires})
			return M{"success": true}
		})
		a.featureChanged("")
		a.Hub.Notify("state:changed", M{})
		return result
	})
	a.registerCommunityBranding()
	a.Route("PUT", "/api/v1/admin/features/settings/{id}", true, a.setFeatureSettings)
	a.Route("POST", "/api/v1/admin/features/announcements", true, a.saveAnnouncement)
	a.Route("DELETE", "/api/v1/admin/features/announcements/{id}", true, func(r *Request) any {
		result := featureAdmin(r, func(tx *DB) any {
			id := r.Param("id")
			tx.Run("DELETE FROM feature_announcements WHERE id=?", id)
			Audit(tx, r.UID(), "feature.announcement.remove", id, nil)
			return M{"success": true}
		})
		a.featureChanged("")
		return result
	})
	a.registerCatalog()
	a.registerSoundboard()
	a.registerSpeechPlus()
}

func (a *App) setFeatureSettings(r *Request) any {
	id := r.Param("id")
	result := featureAdmin(r, func(tx *DB) any {
		value := M{}
		switch id {
		case "features":
			Strict(r.Body, append(append([]string{}, featureNames...), "soundboard", "requestId")...)
			value = featureSetting(tx, id)
			for key := range r.Body {
				if key != "requestId" {
					value[key] = VBool(r.Body, key)
				}
			}
		case "screen":
			Strict(r.Body, "visibility", "bitrate", "requestId")
			value = M{"visibility": VEnum(r.Body, "visibility", screenVisibility), "bitrate": VInt(r.Body, "bitrate", 500000, 4000000)}
		case "uploads":
			Strict(r.Body, "enabled", "dailyMiB", "requestId")
			value = M{"enabled": VBool(r.Body, "enabled"), "dailyMiB": VInt(r.Body, "dailyMiB", 300, 1024)}
		case "speech":
			value = validateSpeechSettings(r.Body)
			if previous := featureSetting(tx, id); len(previous) > 0 {
				writeFeatureSetting(tx, "previousSpeech", previous)
			}
		case "restoreSpeech":
			Strict(r.Body, "requestId")
			value = featureSetting(tx, "previousSpeech")
			Check(len(value) > 0, 409, "UNAVAILABLE", "No previous speech settings are available.")
			id = "speech"
			writeFeatureSetting(tx, "previousSpeech", featureSetting(tx, id))
		default:
			Fail(http.StatusNotFound, "NOT_FOUND", "Settings not found.")
		}
		writeFeatureSetting(tx, id, value)
		Audit(tx, r.UID(), "feature.settings", id, nil)
		return value
	})
	a.featureChanged("")
	if id == "speech" {
		a.Media.speech.plusStats.retryAfter.Store(0)
	}
	if id == "features" {
		a.Hub.Notify("state:changed", M{})
	}
	if id == "features" || id == "screen" {
		a.refreshHDPolicy()
	}
	return result
}

func (a *App) saveAnnouncement(r *Request) any {
	Strict(r.Body, "en", "fa", "platform", "version", "startsAt", "endsAt", "requestId")
	en, fa := VString(r.Body, "en", 0, 360, true), VString(r.Body, "fa", 0, 360, true)
	Check(en != "" || fa != "", 400, "VALIDATION", "Enter an announcement.")
	platform := VEnum(r.Body, "platform", featurePlatforms)
	version := VString(r.Body, "version", 0, 40, true)
	Check(!strings.ContainsAny(version, " \t\n"), 400, "VALIDATION", "Enter an exact app version.")
	start := VInt(r.Body, "startsAt", 1, 4102444800000)
	end := VInt(r.Body, "endsAt", start+1, 4102444800000)
	result := featureAdmin(r, func(tx *DB) any {
		Check(N(tx.One("SELECT COUNT(*) AS count FROM feature_announcements")["count"]) < 100, 409, "LIMIT", "Retire old announcements before adding another.")
		id := ID()
		tx.Run("INSERT INTO feature_announcements(id,text_en,text_fa,platform,app_version,starts_at,ends_at) VALUES(?,?,?,?,?,?,?)", id, en, fa, platform, version, start, end)
		Audit(tx, r.UID(), "feature.announcement", id, nil)
		return M{"id": id}
	})
	a.featureChanged("")
	return result
}
