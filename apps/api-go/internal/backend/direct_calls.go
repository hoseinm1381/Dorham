package backend

import "sync"

const directCallPrefix = "dm-call-"
const directCallEvent = "dm:call-state"

type directCall struct {
	id, conversation, caller, callee, callerName, calleeName string
	callerSocket, calleeSocket                               string
	expires                                                  int64
}

type directCalls struct {
	mu   sync.Mutex
	byID map[string]*directCall
}

func (c *directCalls) forUser(uid string) *directCall {
	for _, call := range c.byID {
		if call.caller == uid || call.callee == uid {
			return call
		}
	}
	return nil
}

func (h *Hub) directCallBusy(uid string) bool {
	h.directCalls.mu.Lock()
	defer h.directCalls.mu.Unlock()
	return h.directCalls.forUser(uid) != nil
}

func (h *Hub) directCallActive(room string) bool {
	h.directCalls.mu.Lock()
	defer h.directCalls.mu.Unlock()
	for id, call := range h.directCalls.byID {
		if call.calleeSocket != "" && (room == "" || room == directCallPrefix+id) {
			return true
		}
	}
	return false
}

func directCallUser(tx *DB, uid string) M {
	return tx.One("SELECT id,display_name FROM users WHERE id=? AND guest=0 AND banned=0 AND must_change_password=0 AND deleted_at IS NULL", uid)
}

func (h *Hub) startDirectCall(p *peer, conversation string) {
	h.a.DB.Tx(func(tx *DB) any {
		cv := h.a.Service.Conversation(tx, p.uid, conversation, true)
		Check(Str(cv, "kind") == "dm", 400, "NOT_DM", "Open a direct message to call someone.")
		other := Str(tx.One("SELECT user_id FROM dm_members WHERE conversation_id=? AND user_id<>?", conversation, p.uid), "user_id")
		caller, callee := directCallUser(tx, p.uid), directCallUser(tx, other)
		Check(caller != nil && callee != nil, 403, "CALL_UNAVAILABLE", "Direct calls are unavailable for this conversation.")
		h.directCalls.mu.Lock()
		defer h.directCalls.mu.Unlock()
		Check(h.SessionForSocket(p.id) == p.session && h.Online(other), 409, "CALL_OFFLINE", "This person is offline.")
		Check(h.directCalls.forUser(p.uid) == nil && h.directCalls.forUser(other) == nil &&
			tx.One("SELECT 1 FROM voice_members WHERE user_id IN (?,?) LIMIT 1", p.uid, other) == nil,
			409, "CALL_BUSY", "One of you is already in a voice chat or call.")
		call := &directCall{id: ID(), conversation: conversation, caller: p.uid, callee: other, callerName: Str(caller, "display_name"),
			calleeName: Str(callee, "display_name"), callerSocket: p.id, expires: Now() + 30000}
		if h.directCalls.byID == nil {
			h.directCalls.byID = make(map[string]*directCall)
		}
		h.directCalls.byID[call.id] = call
		h.EmitSocket(p.id, directCallEvent, call.state("outgoing", call.calleeName))
		h.EmitUser(other, directCallEvent, call.state("incoming", call.callerName))
		return nil
	})
}

func (c *directCall) state(phase, name string) M {
	return M{"id": c.id, "conversationId": c.conversation, "phase": phase, "peerName": name, "expiresAt": c.expires}
}

func (h *Hub) acceptDirectCall(p *peer, id string) {
	h.a.DB.Tx(func(tx *DB) any {
		h.directCalls.mu.Lock()
		defer h.directCalls.mu.Unlock()
		call := h.directCalls.byID[id]
		Check(call != nil && call.callee == p.uid && call.calleeSocket == "" && call.expires > Now() &&
			h.SessionForSocket(p.id) == p.session && h.SessionForSocket(call.callerSocket) != "", 409, "CALL_ENDED", "This call is no longer available.")
		h.a.Service.Conversation(tx, p.uid, call.conversation, true)
		Check(directCallUser(tx, call.caller) != nil && directCallUser(tx, call.callee) != nil, 403, "CALL_UNAVAILABLE", "Direct calls are unavailable for this conversation.")
		Check(tx.One("SELECT 1 FROM voice_members WHERE user_id IN (?,?) LIMIT 1", call.caller, call.callee) == nil, 409, "CALL_BUSY", "One of you is already in a voice chat or call.")
		call.calleeSocket = p.id
		for _, target := range h.snapshot() {
			if target.uid == p.uid && target.id != p.id {
				h.EmitSocket(target.id, directCallEvent, call.state("ended", ""))
			}
		}
		for _, endpoint := range []struct{ socket, name string }{{call.callerSocket, call.calleeName}, {call.calleeSocket, call.callerName}} {
			h.EmitSocket(endpoint.socket, directCallEvent, call.state("active", endpoint.name))
		}
		return nil
	})
}

func (h *Hub) admitDirectCall(uid, id string) bool {
	return h.a.DB.Tx(func(tx *DB) any {
		h.directCalls.mu.Lock()
		defer h.directCalls.mu.Unlock()
		call := h.directCalls.byID[id]
		if call == nil || call.calleeSocket == "" || (call.caller != uid && call.callee != uid) {
			return false
		}
		if !voiceSessionActive(tx, h.SessionForSocket(call.callerSocket), Now()) || !voiceSessionActive(tx, h.SessionForSocket(call.calleeSocket), Now()) {
			return false
		}
		return mediaSafe(func() { h.a.Service.Conversation(tx, uid, call.conversation, true) })
	}).(bool)
}

func (h *Hub) directCallCredentials(p *peer, id string) M {
	return h.a.DB.Tx(func(tx *DB) any {
		h.directCalls.mu.Lock()
		defer h.directCalls.mu.Unlock()
		call := h.directCalls.byID[id]
		Check(call != nil && call.calleeSocket != "" && (call.callerSocket == p.id || call.calleeSocket == p.id),
			403, "CALL_ENDED", "This call is no longer available.")
		h.a.Service.Conversation(tx, p.uid, call.conversation, true)
		c := h.a.C
		return M{"url": c.LivekitURL, "token": mediaJWT(c.LivekitKey, c.LivekitSecret, p.uid+":"+id,
			M{"roomJoin": true, "room": directCallPrefix + id, "canSubscribe": true, "canPublish": true,
				"canPublishSources": []string{"microphone"}, "canPublishData": false, "canUpdateOwnMetadata": false}, 30)}
	}).(M)
}

// The caller holds directCalls.mu. SFU I/O runs after dropping the lock.
func (h *Hub) finishDirectCall(call *directCall) string {
	delete(h.directCalls.byID, call.id)
	state := call.state("ended", "")
	h.EmitSocket(call.callerSocket, directCallEvent, state)
	if call.calleeSocket == "" {
		h.EmitUser(call.callee, directCallEvent, state)
		return ""
	}
	h.EmitSocket(call.calleeSocket, directCallEvent, state)
	return directCallPrefix + call.id
}

func (h *Hub) endDirectCall(p *peer, id string) {
	room := func() string {
		h.directCalls.mu.Lock()
		defer h.directCalls.mu.Unlock()
		call := h.directCalls.byID[id]
		if call == nil || !(call.callerSocket == p.id || call.calleeSocket == p.id || (call.callee == p.uid && call.calleeSocket == "")) {
			return ""
		}
		return h.finishDirectCall(call)
	}()
	if room != "" {
		h.safe(func() { h.a.Media.deleteDirectCallRoom(room) })
	}
}

func (h *Hub) maintainDirectCalls() {
	h.directCalls.mu.Lock()
	hasCalls := len(h.directCalls.byID) != 0
	h.directCalls.mu.Unlock()
	if !hasCalls {
		return
	}
	var rooms []string
	h.a.DB.Tx(func(tx *DB) any {
		h.directCalls.mu.Lock()
		defer h.directCalls.mu.Unlock()
		for _, call := range h.directCalls.byID {
			if (call.calleeSocket == "" && call.expires <= Now()) ||
				directCallUser(tx, call.caller) == nil || directCallUser(tx, call.callee) == nil ||
				!mediaSafe(func() { h.a.Service.Conversation(tx, call.caller, call.conversation, true) }) {
				if room := h.finishDirectCall(call); room != "" {
					rooms = append(rooms, room)
				}
			}
		}
		return nil
	})
	for _, room := range rooms {
		h.safe(func() { h.a.Media.deleteDirectCallRoom(room) })
	}
}

func (h *Hub) directCallDisconnected(p *peer) {
	h.directCalls.mu.Lock()
	call := h.directCalls.forUser(p.uid)
	var room string
	if call != nil && (call.callerSocket == p.id || call.calleeSocket == p.id || (call.callee == p.uid && call.calleeSocket == "" && !h.Online(p.uid))) {
		room = h.finishDirectCall(call)
	}
	h.directCalls.mu.Unlock()
	if room != "" {
		h.safe(func() { h.a.Media.deleteDirectCallRoom(room) })
	}
}
