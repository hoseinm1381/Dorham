package backend

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

type detachedVoice struct {
	uid, session, channel, epoch string
	until                        int64
	native                       bool
}

func voiceSessionActive(db *DB, session string, now int64) bool {
	return db.One("SELECT s.id FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.id=? AND s.expires_at>=? AND s.access_expires>=? AND u.banned=0 AND u.must_change_password=0 AND u.deleted_at IS NULL", session, now, now) != nil
}

func nativeVoiceSessionActive(db *DB, uid, session string, now int64) bool {
	return db.One("SELECT s.id FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.id=? AND s.user_id=? AND s.native=1 AND s.expires_at>=? AND u.banned=0 AND u.must_change_password=0 AND u.deleted_at IS NULL", session, uid, now) != nil
}

func (h *Hub) signNativeVoice(uid, session, channel, epoch string) string {
	mac := hmac.New(sha256.New, []byte(h.voiceResumeKey))
	mac.Write([]byte(JSON([]string{"android-voice-heartbeat", uid, session, channel, epoch})))
	return hex.EncodeToString(mac.Sum(nil))
}

func (h *Hub) nativeVoiceHeartbeat(r *Request) any {
	Strict(r.Body, "userId", "channelId", "epoch", "token", "sharing")
	uid := VString(r.Body, "userId", 1, 80, false)
	channel := VString(r.Body, "channelId", 1, 80, false)
	epoch := VString(r.Body, "epoch", 1, 80, false)
	session, signature, found := strings.Cut(VString(r.Body, "token", 66, 145, false), ".")
	Check(found && len(session) <= 80 && len(signature) == 64 && Equal(signature, h.signNativeVoice(uid, session, channel, epoch)),
		403, "VOICE_SESSION_ENDED", "Voice session is no longer active.")
	h.a.DB.Tx(func(tx *DB) any {
		now := Now()
		Check(nativeVoiceSessionActive(tx, uid, session, now), 401, "UNAUTHENTICATED", "Session expired.")
		member := tx.One("SELECT epoch FROM voice_members WHERE user_id=? AND channel_id=? AND epoch=? AND heartbeat>=?", uid, channel, epoch, now-30000)
		Check(member != nil, 409, "VOICE_SESSION_ENDED", "Voice session is no longer active.")
		access := h.a.Service.Channel(tx, uid, channel)
		Check(N(access["timeoutUntil"]) <= now, 403, "TIMED_OUT", "You are timed out in this server.")
		tx.Run("UPDATE voice_members SET heartbeat=? WHERE user_id=? AND epoch=?", now, uid, epoch)
		if B(r.Body["sharing"]) {
			tx.Run("UPDATE share_leases SET expires_at=? WHERE user_id=? AND channel_id=? AND expires_at>=?", now+30000, uid, channel, now)
		}
		h.a.Service.MaintainRoom(tx, channel, false)
		return nil
	})
	h.mu.Lock()
	if detached, ok := h.detachedVoice[epoch]; ok && detached.native && detached.session == session {
		detached.until = Now() + 30000
		h.detachedVoice[epoch] = detached
	}
	h.mu.Unlock()
	return M{"alive": true}
}

func (h *Hub) cancelDetachedVoice(session string) {
	h.mu.Lock()
	var cancelled []detachedVoice
	for epoch, voice := range h.detachedVoice {
		if voice.session == session {
			cancelled = append(cancelled, voice)
			delete(h.detachedVoice, epoch)
		}
	}
	h.mu.Unlock()
	for _, voice := range cancelled {
		h.safe(func() { h.a.Service.CancelVoiceResume(voice.uid, voice.channel, voice.epoch) })
	}
}

func (h *Hub) checkDetachedVoice() {
	now := Now()
	h.mu.Lock()
	active := []detachedVoice{}
	for epoch, voice := range h.detachedVoice {
		if voice.until <= now {
			delete(h.detachedVoice, epoch)
		} else {
			active = append(active, voice)
		}
	}
	h.mu.Unlock()
	for _, voice := range active {
		h.safe(func() {
			valid := voice.native && nativeVoiceSessionActive(h.a.DB, voice.uid, voice.session, now) ||
				!voice.native && voiceSessionActive(h.a.DB, voice.session, now)
			if !valid {
				h.cancelDetachedVoice(voice.session)
			}
		})
	}
}

func transientVoiceDisconnect(reason string) bool {
	switch reason {
	case "transport error", "transport close", "ping timeout":
		return true
	default:
		return false
	}
}

func (h *Hub) bindVoice(p *peer, channel, epoch string, recoverable, native bool) {
	p.mu.Lock()
	p.voiceChannel = channel
	p.voiceEpoch = epoch
	p.voiceRecoverable = recoverable
	p.voiceNativeKeepalive = native
	p.roomKey = ""
	p.mu.Unlock()
	h.mu.Lock()
	if h.peers[p.id] == p {
		delete(h.detachedVoice, epoch)
	}
	h.mu.Unlock()
}

func (h *Hub) voiceResumeToken(p *peer, channel, epoch string) string {
	mac := hmac.New(sha256.New, []byte(h.voiceResumeKey))
	mac.Write([]byte(JSON([]string{p.uid, p.session, channel, epoch})))
	return hex.EncodeToString(mac.Sum(nil))
}

func (h *Hub) validateVoiceResume(p *peer, b M) (string, string) {
	channel := VString(b, "channelId", 1, 80, false)
	epoch := VString(b, "epoch", 1, 80, false)
	token := VString(b, "resumeToken", 64, 64, false)
	Check(Equal(token, h.voiceResumeToken(p, channel, epoch)), 403, "VOICE_SESSION_ENDED", "Voice session is no longer active.")
	return channel, epoch
}

func (s *Service) ResumeVoice(uid, session, socket, channel, epoch string) M {
	return serviceResult(s.DB.Tx(func(tx *DB) any {
		now := Now()
		Check(voiceSessionActive(tx, session, now), 401, "UNAUTHENTICATED", "Session expired.")
		member := tx.One("SELECT epoch FROM voice_members WHERE user_id=? AND channel_id=? AND epoch=? AND heartbeat>=?", uid, channel, epoch, now-30000)
		Check(member != nil, 409, "VOICE_SESSION_ENDED", "Voice session is no longer active.")
		access := s.Channel(tx, uid, channel)
		Check(N(access["timeoutUntil"]) <= now, 403, "TIMED_OUT", "You are timed out in this server.")
		tx.Run("UPDATE voice_members SET socket_id=?,heartbeat=? WHERE user_id=? AND epoch=?", socket, now, uid, epoch)
		ReconcileShares(tx, s.C)
		return M{"room": s.RoomView(tx, channel), "epoch": epoch}
	}))
}

func (s *Service) CancelVoiceResume(uid, channel, epoch string) {
	changed := s.DB.Tx(func(tx *DB) any {
		if tx.One("SELECT epoch FROM voice_members WHERE user_id=? AND channel_id=? AND epoch=?", uid, channel, epoch) == nil {
			return false
		}
		tx.Run("DELETE FROM voice_members WHERE user_id=? AND epoch=?", uid, epoch)
		s.MaintainRoom(tx, channel)
		return true
	}).(bool)
	if changed {
		s.Notify("voice:changed", M{})
	}
}
