package backend

import "slices"

type musicEvent struct {
	ID       string `json:"id"`
	Playlist string `json:"playlist"`
	Title    string `json:"title"`
	At       int64  `json:"at"`
}

func (m *Music) changeEvent(s *musicState, b M, action string) {
	if action == "cancelEvent" {
		id := VString(b, "event", 1, 80, false)
		s.Events = slices.DeleteFunc(s.Events, func(event musicEvent) bool { return event.ID == id })
		return
	}
	Check(len(s.Events) < 6, 409, "MUSIC_SCHEDULE", "There are too many scheduled sessions.")
	list := getPlaylist(*s, VString(b, "playlist", 1, 80, false))
	Check(list != nil && list.Shared && len(list.Tracks) > 0, 400, "MUSIC_PLAYLIST", "Choose a shared playlist with tracks.")
	now := Now()
	at := VInt(b, "at", now+10000, now+30*24*3600000)
	title := VString(b, "title", 1, 80, true)
	s.Events = append(s.Events, musicEvent{ID: ID(), Playlist: list.ID, Title: title, At: at})
	slices.SortFunc(s.Events, func(a, b musicEvent) int {
		if a.At < b.At {
			return -1
		}
		if a.At > b.At {
			return 1
		}
		return 0
	})
}

func (m *Music) dueMusic(now int64) []string {
	changed := []string{}
	for _, row := range m.a.DB.All("SELECT channel_id,state FROM music_rooms WHERE next_event_at>0 AND next_event_at<=?", now) {
		channel := Str(row, "channel_id")
		s := m.withOriginal(decodeMusic(Str(row, "state")))
		wrote := false
		start := false
		for len(s.Events) > 0 && s.Events[0].At <= now {
			event := s.Events[0]
			if !s.Policy.Disabled && now-event.At < 20*60000 && (s.Disconnected || s.Current != nil || len(m.humanMembers(m.a.DB, channel)) == 0) {
				break
			}
			s.Events = s.Events[1:]
			wrote = true
			if s.Policy.Disabled || now-event.At >= 20*60000 {
				continue
			}
			list := getPlaylist(s, event.Playlist)
			if list == nil || !list.Shared {
				continue
			}
			for _, id := range list.Tracks {
				if len(s.Queue) >= 100 {
					break
				}
				if asset, ok := m.asset(m.a.DB, channel, id, ""); ok && allowedMusic(s.Policy, asset.musicTrack) {
					s.Queue = append(s.Queue, musicEntry{ID: ID(), Track: asset.musicTrack, Name: event.Title})
				}
			}
			m.advance(m.a.DB, channel, &s, false)
			if s.Current != nil {
				start = true
				break
			}
		}
		if wrote {
			s.Revision++
			m.save(m.a.DB, channel, s)
			if start {
				m.runChannel(channel, s)
			}
			changed = append(changed, channel)
		}
	}
	return changed
}
