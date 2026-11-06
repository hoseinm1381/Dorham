package backend

func communityEnabled(tx *DB, server string) bool {
	return featureSetting(tx, "features")["communityPlus"] != false && communityGranted(tx, server)
}

func (a *App) registerCommunityBranding() {
	a.Route("PUT", "/api/v1/admin/features/communityBranding/{id}", true, func(r *Request) any {
		Strict(r.Body, "bannerId", "blurb", "emojiSlots", "requestId")
		id := r.Param("id")
		banner := VString(r.Body, "bannerId", 0, 80, true)
		blurb := VString(r.Body, "blurb", 0, 240, true)
		slots := VInt(r.Body, "emojiSlots", 8, 64)
		result := featureAdmin(r, func(tx *DB) any {
			Check(communityEnabled(tx, id), 403, "FEATURE_REQUIRED", "Grant Community Plus first.")
			if banner != "" {
				item := tx.One("SELECT * FROM feature_catalog WHERE id=? AND kind='banner' AND active=1 AND (server_id IS NULL OR server_id=?)", VID(banner), id)
				Check(item != nil, 404, "NOT_FOUND", "Publish the community banner first.")
				banner = catalogURL(item)
			}
			tx.Run("UPDATE servers SET community_banner=?,invite_blurb=?,community_emoji_slots=? WHERE id=?", banner, blurb, slots, id)
			Audit(tx, r.UID(), "feature.community.branding", id, nil)
			return M{"success": true}
		})
		a.Hub.Notify("state:changed", M{})
		return result
	})
	a.Route("GET", "/api/v1/features/invite", false, func(r *Request) any {
		r.Header("Cache-Control", "no-store")
		code := VString(M{"code": r.Query("code")}, "code", 10, 100, false)
		return a.DB.Tx(func(tx *DB) any {
			row := tx.One("SELECT s.id,s.name,s.community_banner,s.invite_blurb FROM servers s JOIN invites i ON i.server_id=s.id WHERE i.hash=? AND i.expires_at>? AND i.remaining>0", Hash(code), Now())
			Check(row != nil && communityEnabled(tx, Str(row, "id")), 404, "NOT_FOUND", "Invite branding is unavailable.")
			return M{"name": row["name"], "banner": row["community_banner"], "blurb": row["invite_blurb"]}
		})
	})
}
