package backend

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRuntimeVoiceHeartbeatsDoNotWriteWALAndCascadesRollback(t *testing.T) {
	f := newCoreFixture(t)
	f.s.C.MediaTransport = "livekit"
	uid := f.users["member"]
	f.s.JoinVoice(uid, "io-socket", f.voice, true)
	f.db.Run("INSERT INTO share_leases(id,user_id,channel_id,expires_at) VALUES(?,?,?,?)", ID(), uid, f.voice, Now()+30000)
	f.db.Run("PRAGMA wal_checkpoint(TRUNCATE)")
	for i := 0; i < 100; i++ {
		f.s.VoiceAction(uid, "io-socket", "heartbeat", M{"eligible": true})
	}
	st, err := os.Stat(filepath.Join(f.s.C.DataDir, "dorham.sqlite-wal"))
	if err != nil || st.Size() != 0 {
		t.Fatalf("heartbeats wrote durable WAL: %v %v", st, err)
	}
	if Num(f.db.One("SELECT COUNT(*) AS n FROM main.voice_members"), "n") != 0 || Num(f.db.One("SELECT COUNT(*) AS n FROM temp.voice_members"), "n") != 1 {
		t.Fatal("runtime state leaked to main")
	}
	rolledBack := false
	func() {
		defer func() { rolledBack = recover() != nil }()
		f.db.Tx(func(tx *DB) any {
			tx.Run("DELETE FROM channels WHERE id=?", f.voice)
			if Num(tx.One("SELECT COUNT(*) AS n FROM voice_members"), "n") != 0 || Num(tx.One("SELECT COUNT(*) AS n FROM share_leases"), "n") != 0 {
				t.Fatal("TEMP delete cascade failed")
			}
			panic("intentional rollback")
		})
	}()
	if !rolledBack || Num(f.db.One("SELECT COUNT(*) AS n FROM voice_members"), "n") != 1 || Num(f.db.One("SELECT COUNT(*) AS n FROM share_leases"), "n") != 1 {
		t.Fatal("main/TEMP transaction rollback failed")
	}
	f.db.Run("DELETE FROM users WHERE id=?", uid)
	if Num(f.db.One("SELECT COUNT(*) AS n FROM voice_members"), "n") != 0 || Num(f.db.One("SELECT COUNT(*) AS n FROM share_leases"), "n") != 0 {
		t.Fatal("user deletion left runtime state")
	}
	if mediaSafe(func() {
		f.db.Run("INSERT INTO voice_members(user_id,channel_id,socket_id,epoch,heartbeat,joined_at) VALUES('missing',?,'x','x',1,1)", f.voice)
	}) {
		t.Fatal("missing parent accepted")
	}
}

func TestBatchedHistoryMatchesIndividualViewsAndUsesFourReads(t *testing.T) {
	f := newCoreFixture(t)
	uid := f.users["member"]
	ids := []string{}
	for i := 0; i < 50; i++ {
		id := ID()
		ids = append(ids, id)
		f.db.Run("INSERT INTO messages(id,conversation_id,sequence,user_id,content,created_at) VALUES(?,?,?,?,?,?)", id, f.conversation, i+1, uid, "synthetic @second", Now())
		if i%3 == 0 {
			f.db.Run("INSERT INTO reactions(message_id,user_id,emoji) VALUES(?,?,'👍')", id, uid)
			f.db.Run("INSERT INTO reactions(message_id,user_id,emoji) VALUES(?,?,'👍')", id, f.users["second"])
			f.db.Run("INSERT INTO message_mentions(message_id,user_id,username) VALUES(?,?,'second')", id, f.users["second"])
		}
		if i%5 == 0 {
			f.db.Run("INSERT INTO attachments(id,user_id,conversation_id,message_id,request_id,name,size,state,created_at,expires_at) VALUES(?,?,?,?,?,'test.txt',8,'ready',?,?)", ID(), uid, f.conversation, id, ID(), Now(), Now()+60000)
		}
		if i == 49 {
			f.db.Run("UPDATE messages SET deleted=1 WHERE id=?", id)
		}
	}
	want := []M{}
	f.db.Tx(func(tx *DB) any {
		for _, id := range ids {
			want = append(want, f.s.MessageView(tx, id))
		}
		return nil
	})
	before := f.db.stats.reads.Load()
	var got []M
	f.db.Tx(func(tx *DB) any { got = f.s.MessageViews(tx, ids); return nil })
	if reads := f.db.stats.reads.Load() - before; reads != 4 {
		t.Fatalf("page assembly used %d reads", reads)
	}
	if JSON(got) != JSON(want) {
		t.Fatal("batched message views changed content, order, reactions, mentions, attachments or tombstones")
	}
	t.Logf("50-message page assembly: 4 SQL reads, identical output")
}

func TestAdvanceOnlyReadCursorKeepsReplayReceipts(t *testing.T) {
	f := newCoreFixture(t)
	uid := f.users["member"]
	f.db.Run("UPDATE conversations SET sequence=10 WHERE id=?", f.conversation)
	f.s.Read(uid, ID(), f.conversation, 8)
	rid := ID()
	f.s.Read(uid, rid, f.conversation, 4)
	f.s.Read(uid, rid, f.conversation, 4)
	if Num(f.db.One("SELECT sequence FROM read_cursors WHERE conversation_id=? AND user_id=?", f.conversation, uid), "sequence") != 8 {
		t.Fatal("read cursor regressed")
	}
	if f.db.One("SELECT request_id FROM mutations WHERE user_id=? AND request_id=?", uid, rid) == nil {
		t.Fatal("read receipt lost")
	}
	coreWantError(t, "IDEMPOTENCY_CONFLICT", func() { f.s.Read(uid, rid, f.conversation, 9) })
}

func TestPageCachePressureAndRecoveryHysteresis(t *testing.T) {
	for _, tt := range []struct {
		host, service int64
		ok            bool
		current, want int64
	}{
		{1024, 512, true, 8, 32}, {300, 512, true, 32, 8}, {1024, 160, true, 32, 8},
		{450, 220, true, 8, 8}, {450, 220, true, 32, 32}, {1024, 512, false, 32, 8},
	} {
		if got := pageCacheBudget(tt.host*mediaMiB, tt.service*mediaMiB, tt.ok, tt.current); got != tt.want {
			t.Fatalf("budget=%d want=%d", got, tt.want)
		}
	}
}
