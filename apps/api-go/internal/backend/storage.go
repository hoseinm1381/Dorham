package backend

import (
	"os"
	"path/filepath"
)

func (a *App) storageStatus() M {
	var databaseBytes any
	databaseBudget := any(nil)
	if a.DB.Dialect == "sqlite" {
		databaseBytes = Num(a.DB.One("PRAGMA page_count"), "page_count") * Num(a.DB.One("PRAGMA page_size"), "page_size")
		databaseBudget = int64(a.C.MaxDatabaseMiB) * 1048576
	}
	var avatarBytes int64
	entries, e := os.ReadDir(filepath.Join(a.C.DataDir, "avatars"))
	if e != nil {
		panic(e)
	}
	for _, f := range entries {
		s, e := f.Info()
		if e != nil {
			panic(e)
		}
		avatarBytes += s.Size()
	}
	avatarBudget := int64(a.C.MaxAvatarsMiB) * 1048576
	warnings := []string{}
	if databaseBytes != nil && N(databaseBytes)*10 >= N(databaseBudget)*8 {
		warnings = append(warnings, "Database is at least 80% of its page budget. Prune data or migrate storage.")
	}
	if avatarBytes*10 >= avatarBudget*8 {
		warnings = append(warnings, "Avatar storage is at least 80% of its budget.")
	}
	return M{"databaseBytes": databaseBytes, "databaseBudgetBytes": databaseBudget, "avatarBytes": avatarBytes, "avatarBudgetBytes": avatarBudget, "warnings": warnings}
}
