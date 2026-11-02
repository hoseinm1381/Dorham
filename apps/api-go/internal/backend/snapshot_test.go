package backend

import "testing"

func TestSnapshotReadsAreTransactionScopedCopiedAndInvalidated(t *testing.T) {
	c := Config{DataDir: t.TempDir(), MaxDatabaseMiB: 16}
	db := OpenDB(c)
	defer db.Close()
	db.Run("INSERT INTO meta(key,value) VALUES('snapshot','before')")
	db.Tx(func(tx *DB) any {
		s := tx.Snapshot()
		row := s.One("SELECT value FROM meta WHERE key=?", "snapshot")
		row["value"] = "caller-mutation"
		if Str(s.One("SELECT value FROM meta WHERE key=?", "snapshot"), "value") != "before" {
			t.Fatal("caller modified cached row")
		}
		if len(s.memo) != 1 {
			t.Fatal("identical query was not reused")
		}
		s.Run("UPDATE meta SET value='after' WHERE key='snapshot'")
		if Str(s.One("SELECT value FROM meta WHERE key=?", "snapshot"), "value") != "after" {
			t.Fatal("snapshot stale after write")
		}
		return nil
	})
	db.Run("UPDATE meta SET value='next-commit' WHERE key='snapshot'")
	db.Tx(func(tx *DB) any {
		if Str(tx.Snapshot().One("SELECT value FROM meta WHERE key=?", "snapshot"), "value") != "next-commit" {
			t.Fatal("snapshot survived a commit")
		}
		return nil
	})
}
func TestSnapshotAuthorizationRefreshesAfterPermissionCommit(t *testing.T) {
	f := newCoreFixture(t)
	s := f.s
	_ = s.Bootstrap(f.users["member"])
	s.ChangeChannel(f.users["owner"], ID(), f.voice, M{"role": "member", "permissions": M{"view": false}, "expectedRevision": int64(0)})
	for _, raw := range Arr(s.Bootstrap(f.users["member"])["channels"]) {
		if Str(Obj(raw), "id") == f.voice {
			t.Fatal("cached authorization survived permission revocation")
		}
	}
}
