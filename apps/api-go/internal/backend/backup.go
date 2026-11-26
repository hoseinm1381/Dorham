package backend

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"
)

func backupRestoreVerifiedAt() any {
	path := os.Getenv("DORHAM_RESTORE_RECEIPT")
	if path == "" {
		path = "/var/lib/dorham-ops/last-verified-restore.json"
	}
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	var receipt struct {
		Schema     int       `json:"schema"`
		VerifiedAt time.Time `json:"verifiedAt"`
	}
	if json.NewDecoder(io.LimitReader(file, 4096)).Decode(&receipt) != nil ||
		receipt.Schema != 1 || receipt.VerifiedAt.IsZero() || receipt.VerifiedAt.After(time.Now()) {
		return nil
	}
	return receipt.VerifiedAt.UTC()
}

// OfflineBackup shares the existing instance lock but starts no HTTP, game,
// speech or voice lifecycle. In particular it does not clear voice_members or
// alter persisted games before taking the recovery snapshot.
func OfflineBackup(c Config, destination string) {
	Check(c.DatabaseURL == "", 400, "BACKUP", "PostgreSQL backups require pg_dump")
	info, e := os.Stat(filepath.Join(c.DataDir, "dorham.sqlite"))
	Check(e == nil && info.Mode().IsRegular(), 400, "BACKUP", "Existing Dorham SQLite database required")
	a := &App{C: c}
	a.acquireLock()
	defer os.Remove(a.lockPath)
	// Open read-only and do not invoke startup migrations or page/WAL policy.
	// A backup must capture an older schema before any upgrade transforms it.
	sourcePath := filepath.ToSlash(filepath.Join(c.DataDir, "dorham.sqlite"))
	if len(sourcePath) > 1 && sourcePath[1] == ':' {
		sourcePath = "/" + sourcePath
	}
	source := (&url.URL{Scheme: "file", Path: sourcePath}).String() + "?mode=ro"
	raw, err := sql.Open("sqlite", source)
	if err != nil {
		panic(err)
	}
	defer raw.Close()
	db := &DB{raw: raw, mu: &sync.Mutex{}, Dialect: "sqlite"}
	Check(db.One("SELECT version FROM schema_migrations LIMIT 1") != nil, 400, "BACKUP", "Dorham database required")
	db.Backup(destination)
	if e := os.Chmod(destination, 0600); e != nil {
		panic(e)
	}
}
