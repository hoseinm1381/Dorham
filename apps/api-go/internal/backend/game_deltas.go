package backend

// Only diff already-authorized projections for the same watcher. A revision
// gap or permission change results in the client's normal authorized reload.
func (h *Hub) gameDelta(sid, id string, notice M, view func(string) M) {
	h.mu.RLock()
	p := h.peers[sid]
	h.mu.RUnlock()
	if p == nil {
		return
	}
	p.mu.Lock()
	previous, version := p.gameView, p.gameVersion
	p.mu.Unlock()
	if previous == nil || Str(previous, "id") != id {
		return
	}
	var current M
	serviceAttempt(func() { current = view(version) })
	if current == nil {
		return
	}
	p.mu.Lock()
	if p.gameWatching != id || p.gameView == nil || Num(p.gameView, "revision") != Num(previous, "revision") {
		p.mu.Unlock()
		return
	}
	p.gameView = current
	p.mu.Unlock()
	prior := Num(previous, "revision")
	if Num(current, "revision") != prior+1 {
		return
	}
	changed, removed := gameFields(previous, current, "state")
	state, stateRemoved := gameFields(Obj(previous["state"]), Obj(current["state"]), "")
	notice["delta"] = M{"from": prior, "changed": changed, "removed": removed, "state": state, "stateRemoved": stateRemoved}
}

func gameFields(previous, current M, skip string) (M, []string) {
	changed, removed := M{}, []string{}
	for name, value := range current {
		if before, exists := previous[name]; name != skip && (!exists || JSON(value) != JSON(before)) {
			changed[name] = value
		}
	}
	for name := range previous {
		if _, exists := current[name]; !exists && name != skip {
			removed = append(removed, name)
		}
	}
	return changed, removed
}
