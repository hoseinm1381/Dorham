package backend

import (
	"math/rand/v2"
	"slices"
)

type musicAccess struct {
	dj, moderator, manage, request bool
	name                           string
}

func (m *Music) access(tx *DB, r *Request, channel string, policy musicPolicy) musicAccess {
	ch := m.a.Service.Channel(tx, r.UID(), channel)
	Check(Str(ch, "kind") == "voice", 404, "NOT_FOUND", "Voice channel not found.")
	vm := tx.One("SELECT socket_id FROM voice_members WHERE channel_id=? AND user_id=? AND heartbeat>=?", channel, r.UID(), Now()-30000)
	Check(vm != nil && m.a.Hub.SessionForSocket(Str(vm, "socket_id")) == Str(r.Session, "id"), 403, "MUSIC_MEMBERSHIP", "Join this voice channel to use Music.")
	member := m.a.Service.Member(tx, r.UID(), Str(ch, "server_id"))
	Check(N(member["timeout_until"]) <= Now(), 403, "FORBIDDEN", "Music controls are unavailable during a timeout.")
	permissions := Obj(ch["permissions"])
	guest := B(r.User["guest"])
	moderator := !guest && B(permissions["moderate"])
	manage := !guest && B(permissions["manageChannels"])
	dj := moderator || manage
	if policy.DJRole != "" && !guest {
		for _, role := range tx.All("SELECT role_id AS id FROM member_roles WHERE user_id=? AND server_id=?", r.UID(), Str(ch, "server_id")) {
			if Str(role, "id") == policy.DJRole {
				dj = true
				break
			}
		}
	}
	return musicAccess{dj: dj, moderator: moderator || manage, manage: manage, request: !guest && (dj || policy.Mode != "dj"), name: Str(r.User, "display_name")}
}

func (m *Music) register() {
	base := "/api/v1/voice/{channel}/music"
	m.registerMemberMusic(base)
	m.a.Route("GET", base, true, func(r *Request) any {
		Check(m.enabled(), 409, "MUSIC_UNAVAILABLE", "Music is unavailable on this server.")
		r.Header("Cache-Control", "no-store")
		m.mu.Lock()
		defer m.mu.Unlock()
		ch := r.Param("channel")
		return m.a.DB.Tx(func(tx *DB) any {
			s := m.read(tx, ch)
			p := m.access(tx, r, ch, s.Policy)
			s.Position = musicPosition(s, m.processes[ch], Now())
			var playlists []musicPlaylist
			for _, list := range s.Playlists {
				if list.Shared || list.Owner == r.UID() {
					list.Manageable = !list.Original && (list.Owner == r.UID() || list.Shared && p.dj)
					list.Editable = p.request && (list.Manageable || list.Shared && list.Collaborative)
					list.Owner = ""
					playlists = append(playlists, list)
				}
			}
			s.Playlists = playlists
			canUndo, canUnshuffle := len(s.Undo) > 0, len(s.PreviousOrder) > 0
			s.Undo = nil
			s.PreviousOrder = nil
			threshold, count, voted := musicVotes(m.humanMembers(tx, ch), s.Votes, r.UID())
			s.Votes = nil
			if !p.dj {
				s.Pending = slices.DeleteFunc(s.Pending, func(e musicEntry) bool { return e.Requester != r.UID() })
			}
			var roles []M
			if p.manage {
				roles = tx.All("SELECT id,name FROM custom_roles WHERE server_id=(SELECT server_id FROM channels WHERE id=?) ORDER BY name", ch)
			}
			return M{"state": s, "library": m.library(tx, ch, s), "roles": roles, "serverDeafened": true, "canDJ": p.dj, "canModerate": p.moderator, "canManage": p.manage, "canRequest": p.request, "canVote": !B(r.User["guest"]), "canUndo": canUndo, "canUnshuffle": canUnshuffle, "canUpload": p.request && s.Policy.AllowUploads && m.ffprobe != "", "votes": count, "skipThreshold": threshold, "voted": voted}
		})
	})
	m.a.Route("POST", base, true, m.command)
	m.a.Route("POST", base+"/upload", true, m.upload)
}

func musicVotes(members []M, votes []string, uid string) (threshold, count int, voted bool) {
	total := 0
	for _, member := range members {
		if B(member["guest"]) {
			continue
		}
		total++
		id := Str(member, "user_id")
		if slices.Contains(votes, id) {
			count++
			voted = voted || id == uid
		}
	}
	return total/2 + 1, count, voted
}

func (m *Music) command(r *Request) any {
	Check(m.enabled(), 409, "MUSIC_UNAVAILABLE", "Music is unavailable on this server.")
	channel, uid := r.Param("channel"), r.UID()
	rid := RID(r.Body)
	action := VString(r.Body, "action", 1, 30, false)
	var direct []musicResolvedLink
	if action == "addLink" {
		source := VString(r.Body, "url", 8, 2048, true)
		m.a.DB.Tx(func(tx *DB) any {
			s := m.read(tx, channel)
			Check(m.access(tx, r, channel, s.Policy).request && !s.Policy.Disabled, 403, "MUSIC_REQUEST", "Track requests are disabled for your role.")
			return nil
		})
		for _, a := range m.catalog {
			if a.URL == source {
				direct = []musicResolvedLink{{URL: a.URL, Title: a.Title}}
				break
			}
		}
		if len(direct) == 0 {
			direct = m.followMusicLink(r.R.Context(), source)
		}
	}
	var saved musicState
	var restart, changed, requested bool
	var removedPublisher string
	defer func() {
		if changed {
			m.notify(channel)
		}
		if removedPublisher != "" {
			m.removePublisher(channel, removedPublisher)
		}
	}()
	m.mu.Lock()
	defer m.mu.Unlock()
	Check(!m.closed, 503, "MUSIC_UNAVAILABLE", "Music is unavailable on this server.")
	out := m.a.Service.Mutate(uid, rid, "music."+action, M{"channel": channel, "command": r.Body}, func(tx *DB) any {
		s := m.read(tx, channel)
		p := m.access(tx, r, channel, s.Policy)
		Check(!s.Policy.Disabled || action == "policy", 403, "MUSIC_DISABLED", "Music is disabled in this channel.")
		position := musicPosition(s, m.processes[channel], Now())
		s.Message = ""
		if action != "add" && action != "addLink" && action != "import" && action != "vote" && action != "stop" && action != "remove" && action != "savePlaylist" && action != "updatePlaylist" && action != "deletePlaylist" && action != "policy" {
			Check(p.dj, 403, "MUSIC_DJ", "Only a DJ can use this control.")
		}
		switch action {
		case "add", "addLink", "import":
			Check(p.request, 403, "MUSIC_REQUEST", "Track requests are disabled for your role.")
			key := channel + ":" + uid
			Check(p.dj || Now()-m.lastRequest[key] >= 2000, 429, "MUSIC_COOLDOWN", "Wait a moment before requesting another track.")
			var ids []string
			if action == "add" {
				ids = []string{VString(r.Body, "track", 1, 80, false)}
			} else if action == "addLink" {
				for i, item := range direct {
					ids = append(ids, m.insertMusicLink(tx, uid, "", item, Now()+int64(i)).ID)
				}
			} else if id := Str(r.Body, "memberList"); id != "" {
				list := tx.One("SELECT l.id FROM music_member_lists l JOIN users u ON u.id=l.owner_id WHERE l.id=? AND (l.public=1 OR l.owner_id=?) AND u.banned=0 AND u.deleted_at IS NULL", id, uid)
				Check(list != nil, 404, "MUSIC_PLAYLIST", "Playlist was not found.")
				for _, track := range tx.All("SELECT id FROM music_member_tracks WHERE list_id=? ORDER BY created_at,id LIMIT 100", id) {
					ids = append(ids, Str(track, "id"))
				}
			} else {
				if playlist := Str(r.Body, "playlist"); playlist != "" {
					list := getPlaylist(s, playlist)
					Check(list != nil && (list.Shared || list.Owner == uid), 404, "MUSIC_PLAYLIST", "Playlist was not found.")
					ids = list.Tracks
					if selection, exists := r.Body["tracks"]; exists {
						ids = slices.DeleteFunc(slices.Clone(musicIDs(selection)), func(id string) bool { return !slices.Contains(list.Tracks, id) })
					}
				} else {
					ids = musicIDs(r.Body["tracks"])
				}
			}
			seen := map[string]bool{}
			own := 0
			for _, e := range append(slices.Clone(s.Queue), s.Pending...) {
				seen[e.Track.ID] = true
				if e.Requester == uid {
					own++
				}
			}
			added, skipped := 0, 0
			playNext := p.dj && B(r.Body["next"])
			for _, id := range ids {
				a, ok := m.asset(tx, channel, id, uid)
				if !ok || (!s.Policy.AllowExplicit && a.Explicit) || (!s.Policy.AllowUploads && a.Source == "upload") || (!B(r.Body["duplicates"]) && (s.Current != nil && s.Current.Track.ID == id || seen[id])) || len(s.Queue)+len(s.Pending) >= 100 || (!p.dj && own >= 12) {
					skipped++
					if action == "addLink" {
						tx.Run("DELETE FROM music_member_tracks WHERE id=? AND list_id IS NULL", id)
					}
					continue
				}
				e := musicEntry{ID: ID(), Track: a.musicTrack, Requester: uid, Name: p.name}
				switch {
				case s.Policy.Mode == "approval" && !p.dj:
					s.Pending = append(s.Pending, e)
				case s.Current == nil:
					m.selectTrack(&s, e)
					restart = true
				case playNext:
					s.Queue = slices.Insert(s.Queue, min(added, len(s.Queue)), e)
				default:
					s.Queue = append(s.Queue, e)
				}
				seen[id] = true
				own++
				added++
			}
			Check(added > 0, 409, "MUSIC_NO_TRACKS", "No tracks were added. They may be unavailable, already queued, or over the queue limit.")
			requested = true
			if s.Policy.Fair && !playNext {
				s.Queue = fairMusic(s.Queue, s.Current)
			}
			s.PreviousOrder = nil
			saved = s
			saved.Revision++
			m.save(tx, channel, saved)
			changed = true
			return M{"revision": saved.Revision, "added": added, "skipped": skipped}
		case "start":
			Check(s.Current == nil && len(s.Queue) > 0, 409, "MUSIC_QUEUE", "Add a track or resume the current one.")
			m.advance(tx, channel, &s, false)
			restart = true
		case "pause":
			s.Position = position
			requireMusicTrack(s)
			Check(s.Status == "playing" || s.Status == "buffering", 409, "MUSIC_STATE", "Music is already paused.")
			s.Status = "paused"
			restart = true
		case "resume":
			requireMusicTrack(s)
			Check(s.Status == "paused" || s.Status == "error", 409, "MUSIC_STATE", "Music is already active.")
			s.Status = "buffering"
			s.Disconnected = false
			restart = true
		case "seek", "restart":
			requireMusicTrack(s)
			Check(!s.Current.Track.Live && s.Current.Track.Duration > 0, 409, "MUSIC_LIVE", "This audio cannot be seeked.")
			s.Position = 0
			if action == "seek" {
				s.Position = VInt(r.Body, "position", 0, max(0, s.Current.Track.Duration-100))
			}
			if s.Status != "paused" {
				s.Status = "buffering"
				restart = true
			}
		case "skip", "vote":
			requireMusicTrack(s)
			Check(Str(r.Body, "entry") == s.Current.ID, 409, "MUSIC_STALE", "The track already changed.")
			if action == "vote" {
				Check(!B(r.User["guest"]), 403, "MUSIC_VOTE", "Guests cannot vote to skip.")
				if !slices.Contains(s.Votes, uid) {
					s.Votes = append(s.Votes, uid)
				}
				threshold, count, _ := musicVotes(m.humanMembers(tx, channel), s.Votes, uid)
				if count < threshold {
					break
				}
			}
			m.advance(tx, channel, &s, false)
			restart = true
		case "previous":
			Check(len(s.History) > 0 && !s.History[0].Track.Live, 409, "MUSIC_HISTORY", "There is no previous track available.")
			if s.Current != nil {
				s.Queue = slices.Insert(s.Queue, 0, *s.Current)
			}
			e := s.History[0]
			s.History = s.History[1:]
			m.selectTrack(&s, e)
			restart = true
		case "stop":
			if s.Disconnected {
				return M{"revision": s.Revision}
			}
			if s.Current != nil {
				s.Queue = slices.Insert(s.Queue, 0, *s.Current)
			}
			s.Current = nil
			s.Position = 0
			s.Votes = nil
			s.Status = "idle"
			s.Disconnected = true
			s.PreviousOrder = nil
			restart = true
		case "remove", "approve", "reject", "move":
			entry := VString(r.Body, "entry", 1, 80, false)
			isPending := B(r.Body["pending"]) || action == "approve" || action == "reject"
			list := &s.Queue
			if isPending {
				list = &s.Pending
			}
			i := slices.IndexFunc(*list, func(e musicEntry) bool { return e.ID == entry })
			Check(i >= 0, 409, "MUSIC_STALE", "That request is no longer in the queue.")
			e := (*list)[i]
			Check(p.dj || (action == "remove" && e.Requester == uid), 403, "MUSIC_DJ", "Only a DJ can use this control.")
			*list = slices.Delete(*list, i, i+1)
			switch action {
			case "move":
				Check(VInt(r.Body, "revision", 0, 1<<52) == s.Revision, 409, "MUSIC_STALE", "The queue changed. Refresh and try again.")
				Check(!isPending, 400, "VALIDATION", "Pending tracks cannot be moved.")
				destination := int(VInt(r.Body, "index", 0, int64(len(*list))))
				*list = slices.Insert(*list, destination, e)
			case "approve":
				if s.Current == nil {
					m.selectTrack(&s, e)
					restart = true
				} else {
					s.Queue = append(s.Queue, e)
				}
			}
			s.PreviousOrder = nil
		case "clear":
			s.Undo = slices.Clone(s.Queue)
			s.Queue = nil
			s.PreviousOrder = nil
		case "undo":
			Check(len(s.Undo) > 0 && len(s.Queue)+len(s.Undo) <= 100, 409, "MUSIC_QUEUE", "There is no queue to restore.")
			s.Queue = append(s.Undo, s.Queue...)
			s.Undo = nil
		case "shuffle":
			Check(len(s.Queue) > 1, 409, "MUSIC_QUEUE", "Add more tracks to shuffle the queue.")
			s.PreviousOrder = slices.Clone(s.Queue)
			rand.Shuffle(len(s.Queue), func(i, j int) { s.Queue[i], s.Queue[j] = s.Queue[j], s.Queue[i] })
		case "unshuffle":
			Check(len(s.PreviousOrder) > 0, 409, "MUSIC_QUEUE", "There is no shuffle to undo.")
			s.Queue = s.PreviousOrder
			s.PreviousOrder = nil
		case "repeat":
			s.Repeat = VEnum(r.Body, "value", []string{"off", "track", "queue"})
		case "quality":
			Check(p.dj, 403, "MUSIC_DJ", "Only a DJ can change the room’s music quality.")
			s.LowBandwidth = VBool(r.Body, "lowBandwidth")
			if s.Current != nil && (s.Status == "playing" || s.Status == "buffering") {
				s.Position = position
				s.Status = "buffering"
				restart = true
			}
		case "volume":
			s.Volume = int(VInt(r.Body, "value", 0, int64(s.Policy.MaxVolume)))
			if s.Current != nil && (s.Status == "playing" || s.Status == "buffering") {
				s.Position = position
				s.Status = "buffering"
				restart = true
			}
		case "autoplay":
			s.Autoplay = VString(r.Body, "playlist", 0, 80, false)
			list := getPlaylist(s, s.Autoplay)
			Check(s.Autoplay == "" || list != nil && list.Shared, 400, "MUSIC_PLAYLIST", "Choose a shared playlist for autoplay.")
		case "schedule", "cancelEvent":
			m.changeEvent(&s, r.Body, action)
		case "savePlaylist", "updatePlaylist", "deletePlaylist":
			changeMusicPlaylist(&s, r.Body, action, uid, p)
		case "policy":
			Check(p.manage, 403, "FORBIDDEN", "Only a channel manager can change music settings.")
			role := VString(r.Body, "djRole", 0, 80, false)
			if role != "" {
				Check(tx.One("SELECT id FROM custom_roles WHERE id=? AND server_id=(SELECT server_id FROM channels WHERE id=?)", role, channel) != nil, 400, "VALIDATION", "Choose a role from this server.")
			}
			s.Policy = musicPolicy{Disabled: VBool(r.Body, "disabled"), Mode: VEnum(r.Body, "mode", []string{"open", "dj", "approval"}), Fair: VBool(r.Body, "fair"), AllowExplicit: VBool(r.Body, "allowExplicit"), AllowUploads: VBool(r.Body, "allowUploads"), History: VBool(r.Body, "history"), MaxVolume: int(VInt(r.Body, "maxVolume", 10, 100)), DJRole: role}
			if !s.Policy.History {
				s.History = nil
			}
			s.Queue = slices.DeleteFunc(s.Queue, func(e musicEntry) bool { return !allowedMusic(s.Policy, e.Track) })
			s.Pending = slices.DeleteFunc(s.Pending, func(e musicEntry) bool { return !allowedMusic(s.Policy, e.Track) })
			s.Undo = nil
			s.PreviousOrder = nil
			if s.Policy.Disabled || s.Current != nil && !allowedMusic(s.Policy, s.Current.Track) {
				s.Current = nil
				s.Status = "idle"
				s.Position = 0
				s.Votes = nil
				restart = true
			}
			if s.Volume > s.Policy.MaxVolume {
				s.Volume = s.Policy.MaxVolume
				if s.Current != nil && (s.Status == "playing" || s.Status == "buffering") {
					s.Status = "buffering"
					restart = true
				}
			}
		default:
			Fail(400, "VALIDATION", "Unknown music control.")
		}
		saved = s
		saved.Revision++
		m.save(tx, channel, saved)
		changed = true
		return M{"revision": saved.Revision}
	})
	if requested {
		m.lastRequest[channel+":"+uid] = Now()
	}
	if changed && restart {
		if action == "stop" {
			identity, _ := m.sessions.Load(channel)
			removedPublisher, _ = identity.(string)
		}
		m.runChannel(channel, saved)
	}
	return out
}

func requireMusicTrack(s musicState) {
	Check(s.Current != nil, 409, "MUSIC_IDLE", "Choose a track first.")
}
func allowedMusic(p musicPolicy, t musicTrack) bool {
	return (p.AllowExplicit || !t.Explicit) && (p.AllowUploads || t.Source != "upload")
}
func musicIDs(v any) []string {
	raw, ok := v.([]any)
	Check(ok && len(raw) <= 100, 400, "VALIDATION", "Choose up to 100 tracks.")
	ids := []string{}
	for _, item := range raw {
		id, ok := item.(string)
		Check(ok, 400, "VALIDATION", "Invalid track.")
		ids = append(ids, VID(id))
	}
	return ids
}
func getPlaylist(s musicState, id string) *musicPlaylist {
	for i := range s.Playlists {
		if s.Playlists[i].ID == id {
			return &s.Playlists[i]
		}
	}
	return nil
}
func changeMusicPlaylist(s *musicState, b M, action, uid string, p musicAccess) {
	Check(p.request || p.dj, 403, "MUSIC_REQUEST", "Playlist editing is unavailable for your role.")
	if action == "savePlaylist" {
		Check(len(s.Playlists) < 80, 409, "MUSIC_PLAYLIST", "This channel has reached its playlist limit.")
		list := musicPlaylist{ID: ID(), Name: VString(b, "name", 1, 60, true), Owner: uid, Shared: VBool(b, "shared"), Collaborative: VBool(b, "collaborative")}
		Check(!list.Shared || p.dj, 403, "MUSIC_DJ", "Only a DJ can share playlists.")
		if B(b["queue"]) {
			if s.Current != nil {
				list.Tracks = append(list.Tracks, s.Current.Track.ID)
			}
			for _, e := range s.Queue {
				list.Tracks = append(list.Tracks, e.Track.ID)
			}
		} else {
			list.Tracks = musicIDs(b["tracks"])
		}
		list.Tracks = list.Tracks[:min(len(list.Tracks), 100)]
		Check(len(list.Tracks) > 0, 400, "MUSIC_PLAYLIST", "Choose at least one track.")
		s.Playlists = append(s.Playlists, list)
		return
	}
	id := VString(b, "playlist", 1, 80, false)
	list := getPlaylist(*s, id)
	Check(list != nil && (list.Shared || list.Owner == uid), 404, "MUSIC_PLAYLIST", "Playlist was not found.")
	Check(!list.Original, 403, "MUSIC_ORIGINAL", "The official Dorham playlist is read-only.")
	privileged := list.Owner == uid || list.Shared && p.dj
	if action == "deletePlaylist" {
		Check(privileged, 403, "FORBIDDEN", "You cannot delete this playlist.")
		s.Playlists = slices.DeleteFunc(s.Playlists, func(p musicPlaylist) bool { return p.ID == id })
		if s.Autoplay == id {
			s.Autoplay = ""
		}
	} else {
		Check(privileged || list.Shared && list.Collaborative, 403, "FORBIDDEN", "You cannot edit this playlist.")
		if name := Str(b, "name"); name != "" {
			Check(privileged, 403, "FORBIDDEN", "You cannot rename this playlist.")
			list.Name = VString(b, "name", 1, 60, true)
		}
		list.Tracks = musicIDs(b["tracks"])
	}
}
func fairMusic(queue []musicEntry, current *musicEntry) []musicEntry {
	groups := map[string][]musicEntry{}
	order := []string{}
	for _, e := range queue {
		if _, ok := groups[e.Requester]; !ok {
			order = append(order, e.Requester)
		}
		groups[e.Requester] = append(groups[e.Requester], e)
	}
	if current != nil {
		if i := slices.Index(order, current.Requester); i >= 0 {
			order = append(slices.Delete(order, i, i+1), current.Requester)
		}
	}
	out := make([]musicEntry, 0, len(queue))
	for len(out) < len(queue) {
		for _, id := range order {
			if g := groups[id]; len(g) > 0 {
				out = append(out, g[0])
				groups[id] = g[1:]
			}
		}
	}
	return out
}
func (m *Music) selectTrack(s *musicState, e musicEntry) {
	if e.ID == "" {
		e.ID = ID()
	}
	s.Current = &e
	s.Position = 0
	s.Status = "buffering"
	s.Disconnected = false
	s.Votes = nil
	s.PreviousOrder = nil
}
func (m *Music) advance(tx *DB, channel string, s *musicState, natural bool) {
	if s.Current != nil {
		e := *s.Current
		if natural && s.Repeat == "track" && !e.Track.Live {
			e.ID = ID()
			m.selectTrack(s, e)
			return
		}
		if s.Policy.History {
			s.History = append([]musicEntry{e}, s.History...)
			s.History = s.History[:min(len(s.History), 40)]
		}
		if natural && s.Repeat == "queue" && !e.Track.Live && len(s.Queue) < 100 {
			e.ID = ID()
			s.Queue = append(s.Queue, e)
		}
	}
	for len(s.Queue) > 0 {
		e := s.Queue[0]
		s.Queue = s.Queue[1:]
		if _, ok := m.asset(tx, channel, e.Track.ID, e.Requester); ok && allowedMusic(s.Policy, e.Track) {
			m.selectTrack(s, e)
			return
		}
	}
	if natural && s.Autoplay != "" {
		list := getPlaylist(*s, s.Autoplay)
		if list != nil && list.Shared {
			previous := ""
			if s.Current != nil {
				previous = s.Current.Track.ID
			}
			eligible := []musicTrack{}
			for _, id := range list.Tracks {
				if a, ok := m.asset(tx, channel, id, ""); ok && id != previous && allowedMusic(s.Policy, a.musicTrack) && !a.Live {
					eligible = append(eligible, a.musicTrack)
				}
			}
			if len(eligible) > 0 {
				m.selectTrack(s, musicEntry{Track: eligible[rand.IntN(len(eligible))], Name: "Dorham Music"})
				return
			}
		}
	}
	s.Current = nil
	s.Status = "idle"
	s.Position = 0
	s.Votes = nil
	s.PreviousOrder = nil
}
