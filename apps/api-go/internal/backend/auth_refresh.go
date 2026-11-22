package backend

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
)

// Recovering an interrupted rotation requires both the consumed token and
// the per-request secret kept in the native credential store. No replacement
// token is kept in the database.
func (a *App) recoverableRefresh(r *Request) any {
	Strict(r.Body, "requestId", "refreshToken", "retryProof")
	id := RID(r.Body)
	old := VString(r.Body, "refreshToken", 20, 512, false)
	proof := VString(r.Body, "retryProof", 43, 43, false)
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(proof)
	Check(err == nil && len(decoded) == 32, 400, "VALIDATION", "Invalid refresh proof.")
	derive := func(purpose string) string {
		mac := hmac.New(sha256.New, []byte(old))
		_, _ = mac.Write([]byte("Dorham refresh v1\x00" + purpose + "\x00" + id + "\x00" + proof))
		return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	}
	fingerprint, retry := Hash(old), Hash(id+"\x00"+proof)
	access, refresh := derive("access"), derive("refresh")
	result := a.DB.Tx(func(tx *DB) any {
		now := Now()
		if consumed := tx.One("SELECT session_id FROM used_refresh WHERE hash=?", fingerprint); consumed != nil {
			previous := tx.One("SELECT proof,retry_until FROM refresh_recovery WHERE hash=?", fingerprint)
			if previous != nil && Equal(Str(previous, "proof"), retry) && Num(previous, "retry_until") >= now {
				session := tx.One("SELECT s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.refresh_hash=? AND s.access_hash=? AND s.access_expires>=? AND u.banned=0 AND u.deleted_at IS NULL", consumed["session_id"], Hash(refresh), Hash(access), now)
				if session != nil {
					return M{"accessToken": access, "refreshToken": refresh, "csrf": session["csrf"]}
				}
				return nil
			}
			tx.Run("DELETE FROM sessions WHERE id=?", consumed["session_id"])
			return nil
		}
		session := tx.One("SELECT s.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.refresh_hash=? AND s.native=1 AND s.expires_at>=? AND u.banned=0 AND u.deleted_at IS NULL", fingerprint, now)
		if session == nil {
			return nil
		}
		tx.Run("INSERT INTO used_refresh(hash,session_id,expires_at) VALUES(?,?,?)", fingerprint, session["id"], session["expires_at"])
		tx.Run("INSERT INTO refresh_recovery(hash,proof,retry_until) VALUES(?,?,?)", fingerprint, retry, now+5*60000)
		tx.Run("UPDATE sessions SET access_hash=?,refresh_hash=?,access_expires=?,expires_at=?,last_seen=? WHERE id=?", Hash(access), Hash(refresh), now+15*60000, now+30*86400000, now, session["id"])
		return M{"accessToken": access, "refreshToken": refresh, "csrf": session["csrf"]}
	})
	Check(result != nil, 401, "REFRESH_INVALID", "Session expired. Sign in again.")
	return result
}
