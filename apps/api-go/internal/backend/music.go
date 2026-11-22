package backend

import (
	"context"
	"encoding/json"
	"log"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const musicIdentity = "dorham-music"
const originalPlaylistID = "dorham-original"
const musicEmptyGrace = 5 * time.Minute

type musicTrack struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Artist   string `json:"artist"`
	Album    string `json:"album,omitempty"`
	Duration int64  `json:"duration"`
	Live     bool   `json:"live,omitempty"`
	Explicit bool   `json:"explicit,omitempty"`
	Source   string `json:"source"`
}

type musicEntry struct {
	ID        string     `json:"id"`
	Track     musicTrack `json:"track"`
	Requester string     `json:"requester"`
	Name      string     `json:"name"`
}
type musicPlaylist struct {
	Original      bool     `json:"original,omitempty"`
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Owner         string   `json:"owner,omitempty"`
	Shared        bool     `json:"shared"`
	Editable      bool     `json:"editable,omitempty"`
	Manageable    bool     `json:"manageable,omitempty"`
	Collaborative bool     `json:"collaborative"`
	Tracks        []string `json:"tracks"`
}
type musicPolicy struct {
	Disabled      bool   `json:"disabled"`
	Mode          string `json:"mode"`
	Fair          bool   `json:"fair"`
	AllowExplicit bool   `json:"allowExplicit"`
	AllowUploads  bool   `json:"allowUploads"`
	History       bool   `json:"history"`
	MaxVolume     int    `json:"maxVolume"`
	DJRole        string `json:"djRole,omitempty"`
}
type musicState struct {
	Events        []musicEvent    `json:"events"`
	Revision      int64           `json:"revision"`
	Current       *musicEntry     `json:"current"`
	Queue         []musicEntry    `json:"queue"`
	Pending       []musicEntry    `json:"pending"`
	History       []musicEntry    `json:"history"`
	Playlists     []musicPlaylist `json:"playlists"`
	Position      int64           `json:"position"`
	Status        string          `json:"status"`
	Disconnected  bool            `json:"disconnected,omitempty"`
	Repeat        string          `json:"repeat"`
	Volume        int             `json:"volume"`
	LowBandwidth  bool            `json:"lowBandwidth,omitempty"`
	Autoplay      string          `json:"autoplay,omitempty"`
	Policy        musicPolicy     `json:"policy"`
	Votes         []string        `json:"votes"`
	Message       string          `json:"message,omitempty"`
	Undo          []musicEntry    `json:"undo,omitempty"`
	PreviousOrder []musicEntry    `json:"previousOrder,omitempty"`
}
type musicAsset struct {
	musicTrack
	File string `json:"file,omitempty"`
	URL  string `json:"url,omitempty"`
}

type musicProcess struct {
	epoch     string
	cancel    context.CancelFunc
	readyAt   int64
	startedAt int64
	entry     string
	timedOut  bool
	done      chan struct{}
}

type Music struct {
	original                musicPlaylist
	a                       *App
	mu                      sync.Mutex
	processes               map[string]*musicProcess
	sessions                sync.Map
	emptySince              map[string]int64
	lastRequest             map[string]int64
	catalog                 map[string]musicAsset
	worker, ffmpeg, ffprobe string
	uploads                 chan struct{}
	linkSlots               chan struct{}
	stop                    chan struct{}
	wg                      sync.WaitGroup
	closed                  bool
}

func newMusic(a *App) *Music {
	m := &Music{a: a, processes: map[string]*musicProcess{}, emptySince: map[string]int64{}, lastRequest: map[string]int64{}, catalog: map[string]musicAsset{}, uploads: make(chan struct{}, 1), linkSlots: make(chan struct{}, 4), stop: make(chan struct{})}
	if a.C.MediaTransport != "livekit" || env("MUSIC_ENABLED", "") != "true" {
		return m
	}
	var err error
	m.worker, err = exec.LookPath(envDefault("MUSIC_WORKER", "dorham-music-worker"))
	if err == nil {
		m.ffmpeg, err = exec.LookPath(envDefault("MUSIC_FFMPEG", "ffmpeg"))
	}
	if err == nil {
		m.ffprobe, _ = exec.LookPath(envDefault("MUSIC_FFPROBE", "ffprobe"))
	}
	if err == nil {
		err = m.loadCatalog()
	}
	if err != nil {
		log.Printf("music unavailable: %v", err)
		m.worker = ""
		return m
	}

	// Resume is explicit after a backend restart. Keep the interrupted track and queue.
	for _, row := range a.DB.All("SELECT channel_id,state FROM music_rooms") {
		state := decodeMusic(Str(row, "state"))
		if state.Status == "playing" || state.Status == "buffering" {
			state.Status = "paused"
			state.Revision++
			m.save(a.DB, Str(row, "channel_id"), state)
		}
	}
	m.wg.Go(m.maintain)
	return m
}

func (m *Music) enabled() bool { return m != nil && m.worker != "" }

func decodeMusic(raw string) musicState {
	s := musicState{Queue: []musicEntry{}, Pending: []musicEntry{}, History: []musicEntry{}, Playlists: []musicPlaylist{}, Votes: []string{}, Status: "idle", Repeat: "off", Volume: 100, Policy: musicPolicy{Mode: "open", History: true, AllowUploads: true, MaxVolume: 100}}
	if raw != "" {
		if err := json.Unmarshal([]byte(raw), &s); err != nil {
			panic(err)
		}
	}
	return s
}

func (m *Music) read(tx *DB, channel string) musicState {
	s := decodeMusic(Str(tx.One("SELECT state FROM music_rooms WHERE channel_id=?", channel), "state"))
	return m.withOriginal(s)
}
func (m *Music) withOriginal(s musicState) musicState {
	if m.original.ID == "" {
		return s
	}
	list := m.original
	list.Tracks = make([]string, 0, len(m.original.Tracks))
	for _, id := range m.original.Tracks {
		if asset, ok := m.catalog[id]; ok && allowedMusic(s.Policy, asset.musicTrack) {
			list.Tracks = append(list.Tracks, id)
		}
	}
	s.Playlists = append([]musicPlaylist{list}, s.Playlists...)
	return s
}
func (m *Music) save(tx *DB, channel string, s musicState) {
	if len(s.Playlists) > 0 && s.Playlists[0].ID == originalPlaylistID {
		s.Playlists = s.Playlists[1:]
	}
	raw, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	title, status := "", ""
	if !s.Disconnected && !s.Policy.Disabled && s.Current != nil && (s.Status == "playing" || s.Status == "paused" || s.Status == "buffering") {
		title, status = s.Current.Track.Title, s.Status
	}
	next := int64(0)
	if len(s.Events) > 0 {
		next = s.Events[0].At
	}
	tx.Run("INSERT INTO music_rooms(channel_id,state,roster_title,roster_status,next_event_at) VALUES(?,?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET state=excluded.state,roster_title=excluded.roster_title,roster_status=excluded.roster_status,next_event_at=excluded.next_event_at", channel, string(raw), title, status, next)
}

func musicRoster(tx *DB, channel string) M {
	row := tx.One("SELECT roster_title,roster_status FROM music_rooms WHERE channel_id=?", channel)
	status := Str(row, "roster_status")
	if status == "" {
		return nil
	}
	return M{"user": M{"id": musicIdentity, "username": musicIdentity, "displayName": "Dorham Music", "bio": "", "status": "online", "avatar": nil, "kind": "music"},
		"kind": "music", "trackTitle": Str(row, "roster_title"), "playbackStatus": status, "muted": false, "deafened": false, "serverMuted": false, "serverDeafened": true, "canShare": false, "eligible": false, "epoch": "", "joinedAt": 0}
}

func (m *Music) sessionValid(channel, identity string) bool {
	if !m.enabled() {
		return false
	}
	claimed, ok := m.sessions.Load(channel)
	return ok && identity == claimed
}

func (m *Music) close() {
	if !m.enabled() {
		return
	}
	m.mu.Lock()
	m.closed = true
	close(m.stop)
	for _, p := range m.processes {
		p.cancel()
	}
	m.mu.Unlock()
	m.wg.Wait()
}

func musicPosition(s musicState, p *musicProcess, now int64) int64 {
	if p == nil || p.readyAt == 0 || s.Status != "playing" || s.Current == nil || s.Current.Track.Live {
		return s.Position
	}
	return min(s.Current.Track.Duration, s.Position+max(0, now-p.readyAt))
}
func (m *Music) humanMembers(tx *DB, channel string) []M {
	return tx.All("SELECT v.user_id,u.guest FROM voice_members v JOIN users u ON v.user_id=u.id WHERE v.channel_id=? AND v.heartbeat>=? AND u.banned=0", channel, Now()-30000)
}
func (m *Music) asset(tx *DB, channel, id, requester string) (musicAsset, bool) {
	if a, ok := m.catalog[id]; ok {
		return a, true
	}
	row := tx.One("SELECT track FROM music_uploads WHERE channel_id=? AND id=?", channel, id)
	if row == nil {
		return m.memberAsset(tx, id, requester)
	}
	var a musicAsset
	if json.Unmarshal([]byte(Str(row, "track")), &a.musicTrack) != nil {
		return musicAsset{}, false
	}
	a.File = filepath.Join(m.a.C.DataDir, "music", "uploads", a.ID+".ogg")
	return a, true
}
func (m *Music) library(tx *DB, channel string, s musicState) []musicTrack {
	out := make([]musicTrack, 0, len(m.catalog))
	for _, a := range m.catalog {
		if s.Policy.AllowExplicit || !a.Explicit {
			out = append(out, a.musicTrack)
		}
	}
	if s.Policy.AllowUploads {
		for _, row := range tx.All("SELECT track FROM music_uploads WHERE channel_id=? ORDER BY created_at DESC LIMIT 50", channel) {
			var track musicTrack
			if json.Unmarshal([]byte(Str(row, "track")), &track) == nil && (s.Policy.AllowExplicit || !track.Explicit) {
				out = append(out, track)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i].Title)+out[i].ID < strings.ToLower(out[j].Title)+out[j].ID
	})
	return out
}

func (m *Music) maintain() {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-m.stop:
			return
		case <-tick.C:
			func() {
				defer func() {
					if p := recover(); p != nil {
						log.Printf("music maintenance failed: %T", p)
					}
				}()
				m.sweep()
			}()
		}
	}
}
func (m *Music) sweep() {
	var notifications []string
	defer func() {
		for _, channel := range notifications {
			m.notify(channel)
		}
	}()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return
	}
	now := Now()
	for key, last := range m.lastRequest {
		if now-last > 60000 {
			delete(m.lastRequest, key)
		}
	}
	for channel, p := range m.processes {
		row := m.a.DB.One("SELECT c.id FROM channels c WHERE c.id=? AND kind='voice'", channel)
		if row == nil {
			m.cancelChannel(channel)
			continue
		}
		if p.readyAt == 0 && now-p.startedAt > 18000 && !p.timedOut {
			p.timedOut = true
			p.cancel()
		}
		if p.readyAt > 0 && now-p.readyAt >= 15000 {
			state := m.read(m.a.DB, channel)
			if state.Status == "playing" && state.Current != nil && !state.Current.Track.Live {
				state.Position = musicPosition(state, p, now)
				m.save(m.a.DB, channel, state)
				p.readyAt = now
			}
		}
	}
	notifications = append(m.disconnectEmptyRooms(now), m.dueMusic(now)...)
}

// The caller holds the Music mutex, including when evaluating due playlists.
func (m *Music) disconnectEmptyRooms(now int64) []string {
	var disconnected []string
	m.a.DB.Tx(func(tx *DB) any {
		for _, row := range tx.All("SELECT channel_id,state FROM music_rooms WHERE roster_status<>''") {
			channel := Str(row, "channel_id")
			if len(m.humanMembers(tx, channel)) > 0 {
				delete(m.emptySince, channel)
				continue
			}
			emptySince := m.emptySince[channel]
			if emptySince == 0 {
				m.emptySince[channel] = now
				continue
			}
			if now-emptySince < musicEmptyGrace.Milliseconds() {
				continue
			}
			s := decodeMusic(Str(row, "state"))
			s.Position = musicPosition(s, m.processes[channel], now)
			s.Status = "paused"
			s.Disconnected = true
			s.Votes = nil
			s.Revision++
			m.save(tx, channel, s)
			disconnected = append(disconnected, channel)
		}
		return nil
	})
	for _, channel := range disconnected {
		m.cancelChannel(channel)
	}
	return disconnected
}

func (m *Music) cancelChannel(channel string) {
	if p := m.processes[channel]; p != nil {
		delete(m.processes, channel)
		m.sessions.Delete(channel)
		p.cancel()
	}
	delete(m.emptySince, channel)
}

func (m *Music) notify(channel string) {
	m.a.Hub.musicChanged(channel)
}

func (m *Music) removePublisher(channel, identity string) {
	if err := m.a.Media.removeSFUParticipant(channel, identity); err != nil {
		// The revoked identity is also removed by the regular SFU reconciliation.
		log.Printf("music participant removal deferred: %T", err)
	}
}
