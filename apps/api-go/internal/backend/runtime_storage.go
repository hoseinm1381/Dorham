package backend

import (
	"context"
	"fmt"
	"strings"
)

// Keep SQLite's single serialized connection pinned for the lifetime of the
// application: losing it must fail closed, never silently fall back to durable
// voice tables. TEMP tables preserve SQL transactions, rollback and cascading
// membership cleanup without journaling five-second liveness to the drive.
// The durable schema remains unchanged for backup and Node rollback tools.
func (d *DB) EnableRuntimeStorage() {
	if d.Dialect != "sqlite" {
		return
	}
	Check(d.conn == nil, 500, "INTERNAL", "Runtime storage already enabled")
	conn, err := d.raw.Conn(context.Background())
	if err != nil {
		panic(err)
	}
	d.conn = conn
	d.Run("PRAGMA temp_store=MEMORY")
	d.Run("PRAGMA cache_size=-32768")
	d.stats.cacheMiB.Store(32)
	d.Tx(func(tx *DB) any {
		for _, name := range []string{"voice_members", "share_leases", "coordinators"} {
			ddl := Str(tx.One("SELECT sql FROM main.sqlite_master WHERE type='table' AND name=?", name), "sql")
			Check(strings.HasPrefix(ddl, "CREATE TABLE "), 500, "INTERNAL", "Missing runtime schema")
			ddl = strings.Replace(ddl, "CREATE TABLE ", "CREATE TEMP TABLE ", 1)
			// SQLite cannot reference main tables from a TEMP foreign key. Use
			// TEMP triggers for their delete cascades and insert/update guards.
			for _, parent := range []string{"users", "channels"} {
				ddl = strings.ReplaceAll(ddl, " REFERENCES "+parent+"(id) ON DELETE CASCADE", "")
			}
			tx.Run(ddl)
		}
		tx.Run("CREATE INDEX temp.voice_room ON voice_members(channel_id)")
		tx.Run("CREATE TEMP TRIGGER runtime_user_delete AFTER DELETE ON main.users BEGIN DELETE FROM voice_members WHERE user_id=OLD.id; END")
		tx.Run("CREATE TEMP TRIGGER runtime_channel_delete AFTER DELETE ON main.channels BEGIN DELETE FROM voice_members WHERE channel_id=OLD.id; DELETE FROM share_leases WHERE channel_id=OLD.id; DELETE FROM coordinators WHERE channel_id=OLD.id; END")
		for _, table := range []string{"voice_members", "share_leases", "coordinators"} {
			for _, op := range []string{"INSERT", "UPDATE"} {
				condition := "NOT EXISTS(SELECT 1 FROM channels WHERE id=NEW.channel_id)"
				if table != "coordinators" {
					condition += " OR NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id)"
				}
				tx.Run("CREATE TEMP TRIGGER runtime_" + table + "_" + strings.ToLower(op) + " BEFORE " + op + " ON " + table + " WHEN " + condition + " BEGIN SELECT RAISE(ABORT,'FOREIGN KEY constraint failed'); END")
			}
		}
		// These are additive, rollback-compatible indexes, not a schema-format
		// change. Keep historical migration versions intact.
		for _, ddl := range []string{
			"CREATE INDEX IF NOT EXISTS io_attachment_message ON attachments(message_id)",
			"CREATE INDEX IF NOT EXISTS io_mutation_age ON mutations(created_at)",
			"CREATE INDEX IF NOT EXISTS io_usage_age ON attachment_usage(created_at)",
			"CREATE INDEX IF NOT EXISTS io_session_expiry ON sessions(expires_at)",
			"CREATE INDEX IF NOT EXISTS io_user_sessions ON sessions(user_id,created_at)",
			"CREATE INDEX IF NOT EXISTS io_user_dm ON dm_members(user_id,hidden,conversation_id)",
		} {
			tx.Run(ddl)
		}
		return nil
	})
}

func pageCacheBudget(host, service int64, ok bool, current int64) int64 {
	if !ok || host < 384*mediaMiB || service < 192*mediaMiB {
		return 8
	}
	if host > 512*mediaMiB && service > 256*mediaMiB {
		return 32
	}
	return current
}

func (d *DB) TunePageCache() {
	if d.conn == nil || d.stats == nil {
		return
	}
	host, service, ok := cacheMemoryHeadroom()
	current := d.stats.cacheMiB.Load()
	budget := pageCacheBudget(host, service, ok, current)
	if budget != current {
		d.Run(fmt.Sprintf("PRAGMA cache_size=-%d", budget*1024))
		d.stats.cacheMiB.Store(budget)
	}
}
