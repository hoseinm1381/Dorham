package backend

import (
	"reflect"
	"testing"
)

func TestShareAudiencePrivacyAndMembership(t *testing.T) {
	game, _, _ := gamesTestFixture(t)
	h := game.a.Hub
	db := game.a.DB
	now := Now()
	db.Run("UPDATE voice_members SET heartbeat=?", now)
	db.Run("UPDATE voice_members SET channel_id='other' WHERE user_id='c'")
	db.Run("INSERT INTO share_leases(id,user_id,channel_id,expires_at) VALUES('screen','a','voice',?)", now+30000)
	for _, uid := range []string{"a", "b", "c", "d"} {
		id := "socket-" + uid
		h.peers[id] = &peer{id: id, uid: uid}
	}
	sync := func(uid string, watched ...string) M {
		list := make([]any, len(watched))
		for i, id := range watched {
			list[i] = id
		}
		return h.shareAudience(h.peers["socket-"+uid], M{"requestId": ID(), "watching": list})
	}
	check := func(uid string, want ...string) {
		t.Helper()
		got := sync(uid)["viewers"].([]string)
		if len(got) != len(want) || (len(want) > 0 && !reflect.DeepEqual(got, want)) {
			t.Fatalf("%s sees %v, expected %v", uid, got, want)
		}
	}
	check("a")
	sync("a", "screen")
	sync("c", "screen") // Other voice channel.
	sync("b", "screen", "screen")
	check("a", "b")
	check("d") // A bystander in the room receives no viewer identity.
	sync("b")
	check("a")
	sync("b", "screen")
	db.Run("UPDATE voice_members SET channel_id='other' WHERE user_id='b'")
	check("a")
	db.Run("UPDATE voice_members SET channel_id='voice' WHERE user_id='b'")
	h.peers["socket-b"].screenWatchingUntil = now - 1
	check("a")
	sync("b", "screen")
	db.Run("DELETE FROM share_leases WHERE id='screen'")
	check("a")
}
