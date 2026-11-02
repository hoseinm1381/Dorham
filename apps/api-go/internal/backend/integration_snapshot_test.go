package backend

import "testing"

func TestIntegrationSnapshotSiblingWritesInvalidateAuthorization(t *testing.T) {
	f := newCoreFixture(t)
	f.db.Tx(func(tx *DB) any {
		left, right := tx.Snapshot(), tx.Snapshot()
		f.s.Channel(left, f.users["member"], f.voice, "view")
		right.Run("INSERT INTO channel_overrides(channel_id,role,permissions,revision) VALUES(?,'member',?,1) ON CONFLICT(channel_id,role) DO UPDATE SET permissions=excluded.permissions", f.voice, JSON(M{"view": false}))
		if serviceAttempt(func() { f.s.Channel(left, f.users["member"], f.voice, "view") }) == nil {
			t.Fatal("sibling transaction write left cached channel authorization valid")
		}
		tx.Run("DELETE FROM channel_overrides WHERE channel_id=? AND role='member'", f.voice)
		if serviceAttempt(func() { f.s.Channel(left, f.users["member"], f.voice, "view") }) != nil {
			t.Fatal("parent transaction write left cached channel denial stale")
		}
		return nil
	})
}
func TestIntegrationSnapshotCannotReturnCachedRowsAfterTransactionEnds(t *testing.T) {
	c := Config{DataDir: t.TempDir(), MaxDatabaseMiB: 16}
	db := OpenDB(c)
	defer db.Close()
	var escaped *DB
	db.Tx(func(tx *DB) any {
		escaped = tx.Snapshot()
		escaped.One("SELECT version FROM schema_migrations WHERE version=1")
		return nil
	})
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("committed snapshot returned cached data after transaction closed")
			}
		}()
		escaped.One("SELECT version FROM schema_migrations WHERE version=1")
	}()
	func() {
		defer func() { recover() }()
		db.Tx(func(tx *DB) any {
			escaped = tx.Snapshot()
			escaped.One("SELECT version FROM schema_migrations WHERE version=1")
			Fail(409, "TEST_ROLLBACK", "rollback")
			return nil
		})
	}()
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("rolled-back snapshot returned cached data after transaction closed")
			}
		}()
		escaped.One("SELECT version FROM schema_migrations WHERE version=1")
	}()
}

func TestIntegrationSnapshotDoesNotConflateSQLArgumentTypes(t *testing.T) {
	c := Config{DataDir: t.TempDir(), MaxDatabaseMiB: 16}
	db := OpenDB(c)
	defer db.Close()
	db.Tx(func(tx *DB) any {
		s := tx.Snapshot()
		if Str(s.One("SELECT typeof(?) AS kind", []byte("abc")), "kind") != "blob" {
			t.Fatal("SQL blob argument lost its storage type")
		}
		// encoding/json renders []byte("abc") and string("YWJj") identically,
		// but they have different SQL types and cannot share a result-cache key.
		if Str(s.One("SELECT typeof(?) AS kind", "YWJj"), "kind") != "text" {
			t.Fatal("snapshot cache conflated blob and text SQL parameters")
		}
		if Str(s.One("SELECT typeof(?) AS kind", int64(1)), "kind") != "integer" {
			t.Fatal("SQL integer argument lost its storage type")
		}
		if Str(s.One("SELECT typeof(?) AS kind", float64(1)), "kind") != "real" {
			t.Fatal("snapshot cache conflated integer and real SQL parameters")
		}
		return nil
	})
}
