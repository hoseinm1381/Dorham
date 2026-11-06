package backend

func init() {
	expansionSchema[13] = []string{
		"ALTER TABLE users ADD COLUMN deleted_at BIGINT",
		"CREATE INDEX users_deleted ON users(deleted_at)",
	}
}
