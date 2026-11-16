package backend

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"testing"
)

func TestMusicPublisherAdmission(t *testing.T) {
	media, _, _ := mediaTestStore(t)
	a := media.a
	a.Mux = http.NewServeMux()
	a.C.LivekitKey, a.C.LivekitSecret, a.C.MediaAdmissionSecret = "key", "secret", "gate"
	a.Music = &Music{worker: "fixture"}
	a.DB.Run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('s','Server','owner',?)", Now())
	a.DB.Run("INSERT INTO channels(id,server_id,name,kind,created_at) VALUES('room','s','Lounge','voice',?)", Now())
	a.DB.Run("INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,heartbeat,joined_at) VALUES('owner','room','socket','epoch',?,?)", Now(), Now())
	identity := musicIdentity + ":fixture:music"
	a.Music.sessions.Store("room", identity)
	media.registerAdmission()
	grant := func(room string, subscribe bool, source string) M {
		return M{"roomJoin": true, "room": room, "canPublish": true, "canSubscribe": subscribe, "canPublishSources": []string{source}, "canPublishData": false, "canUpdateOwnMetadata": false}
	}
	admit := func(id string, video M) int {
		token := mediaJWT("key", "secret", id, video, 60)
		req := httptest.NewRequest("GET", "/internal/media/admission", nil)
		req.Header.Set("X-Dorham-Media-Gate", "gate")
		req.Header.Set("X-Forwarded-Uri", "/rtc?access_token="+url.QueryEscape(token))
		rec := httptest.NewRecorder()
		a.Mux.ServeHTTP(rec, req)
		return rec.Code
	}
	if code := admit(identity, grant("room", false, "microphone")); code != 200 {
		t.Fatalf("active music publisher returned %d", code)
	}
	for _, g := range []M{grant("other", false, "microphone"), grant("room", true, "microphone"), grant("room", false, "camera")} {
		if code := admit(identity, g); code != 403 {
			t.Fatalf("invalid music grant returned %d", code)
		}
	}
	if got := admit(musicIdentity+":stale:music", grant("room", false, "microphone")); got != 403 {
		t.Fatalf("stale publisher was admitted: %d", got)
	}
	a.DB.Run("UPDATE voice_members SET heartbeat=0")
	if got := admit(identity, grant("room", false, "microphone")); got != 403 {
		t.Fatalf("empty room admitted music: %d", got)
	}
}

func TestMusicFairQueueAndVoteEligibility(t *testing.T) {
	a := musicEntry{ID: "a1", Requester: "a"}
	b := musicEntry{ID: "b1", Requester: "b"}
	queue := fairMusic([]musicEntry{a, {ID: "a2", Requester: "a"}, b, {ID: "b2", Requester: "b"}, {ID: "c1", Requester: "c"}}, &a)
	var order []string
	for _, entry := range queue {
		order = append(order, entry.ID)
	}
	if !slices.Equal(order, []string{"b1", "c1", "a1", "b2", "a2"}) {
		t.Fatal(order)
	}
	members := []M{{"user_id": "a"}, {"user_id": "b"}, {"user_id": "guest", "guest": true}}
	if required, votes, voted := musicVotes(members, []string{"a", "left", "guest"}, "a"); required != 2 || votes != 1 || !voted {
		t.Fatal(required, votes, voted)
	}
}

func TestMusicStateSurvivesSaveAndHidesStoppedBot(t *testing.T) {
	media, _, _ := mediaTestStore(t)
	a := media.a
	a.DB.Run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('s','Server','owner',?)", Now())
	a.DB.Run("INSERT INTO channels(id,server_id,name,kind,created_at) VALUES('room','s','Lounge','voice',?)", Now())
	m := &Music{a: a}
	s := decodeMusic("")
	track := musicTrack{ID: "music", Title: "A track", Duration: 10000}
	m.selectTrack(&s, musicEntry{ID: "first", Track: track})
	s.Queue = []musicEntry{{ID: "next", Track: track}}
	s.Events = []musicEvent{{ID: "next-event", At: Now() + 50000}}
	s.Revision++
	m.save(a.DB, "room", s)
	if state := m.read(a.DB, "room"); state.Current.ID != "first" || state.Queue[0].ID != "next" || state.Events[0].At != s.Events[0].At {
		t.Fatal(state)
	}
	if bot := musicRoster(a.DB, "room"); Str(bot, "kind") != "music" || Str(bot, "trackTitle") != track.Title || !Bool(bot, "serverDeafened") || Bool(bot, "serverMuted") {
		t.Fatal(bot)
	}
	s.Status = "idle"
	s.Current = nil
	m.save(a.DB, "room", s)
	if musicRoster(a.DB, "room") != nil {
		t.Fatal("stopped bot remained in the roster")
	}
}

func TestMusicLeavesOnlyAfterFiveContinuousEmptyMinutes(t *testing.T) {
	media, _, _ := mediaTestStore(t)
	a := media.a
	now := Now()
	a.DB.Run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('s','Server','owner',?)", now)
	a.DB.Run("INSERT INTO channels(id,server_id,name,kind,created_at) VALUES('room','s','Lounge','voice',?)", now)
	m := &Music{a: a, emptySince: map[string]int64{}}
	state := decodeMusic("")
	track := musicEntry{ID: "track", Track: musicTrack{ID: "music", Title: "Music", Duration: 10000}}
	state.Current, state.Position, state.Status = &track, 700, "paused"
	state.Queue = []musicEntry{{ID: "next"}}
	state.Events = []musicEvent{{ID: "scheduled", At: now + 10000}}
	m.save(a.DB, "room", state)
	grace := musicEmptyGrace.Milliseconds()
	if len(m.disconnectEmptyRooms(now)) != 0 {
		t.Fatal("empty-room timer did not start at zero")
	}
	a.DB.Run("INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,heartbeat,joined_at) VALUES('owner','room','socket','epoch',?,?)", Now(), Now())
	if len(m.disconnectEmptyRooms(now+grace)) != 0 {
		t.Fatal("music was removed with a listener still present")
	}
	a.DB.Run("DELETE FROM voice_members WHERE channel_id='room'")
	if len(m.disconnectEmptyRooms(now+grace)) != 0 || len(m.disconnectEmptyRooms(now+2*grace-1)) != 0 {
		t.Fatal("music was removed before five continuous empty minutes")
	}
	if got := m.disconnectEmptyRooms(now + 2*grace); !slices.Equal(got, []string{"room"}) {
		t.Fatal(got)
	}
	got := m.read(a.DB, "room")
	if musicRoster(a.DB, "room") != nil || !got.Disconnected || got.Position != 700 || got.Current.ID != "track" || got.Queue[0].ID != "next" {
		t.Fatal("disconnection lost playback state or left the bot in voice", got)
	}
	a.DB.Run("INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,heartbeat,joined_at) VALUES('owner','room','socket','epoch',?,?)", Now(), Now())
	if changed := m.dueMusic(now + 2*grace); len(changed) != 0 {
		t.Fatal("a due playlist brought back disconnected music")
	}
}

func TestOfficialPlaylistIsVisibleAndReadOnly(t *testing.T) {
	track := musicTrack{ID: "starter-one", Title: "Test track", Source: "library"}
	m := &Music{catalog: map[string]musicAsset{track.ID: {musicTrack: track}}, original: musicPlaylist{
		ID: originalPlaylistID, Name: "Official", Tracks: []string{track.ID}, Shared: true, Original: true,
	}}
	s := m.withOriginal(decodeMusic(""))
	list := getPlaylist(s, originalPlaylistID)
	if list == nil || !list.Original || !list.Shared || len(list.Tracks) != 1 {
		t.Fatalf("missing original playlist: %#v", list)
	}
	e := serviceAttempt(func() {
		changeMusicPlaylist(&s, M{"playlist": originalPlaylistID}, "deletePlaylist", "owner", musicAccess{dj: true})
	})
	if e == nil || RecoverError(e).Status != 403 {
		t.Fatal("the DJ could delete the official playlist")
	}
}
