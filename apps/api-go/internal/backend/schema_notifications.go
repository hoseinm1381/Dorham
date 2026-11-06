package backend

// Additive migration: older Go binaries ignore the additional tables on rollback.
// Existing accounts, messages and the original schema are never rewritten.
func init() {
	expansionSchema[12] = []string{
		"CREATE TABLE notification_devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, installation_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at BIGINT NOT NULL, UNIQUE(session_id,installation_id))",
		"CREATE INDEX notification_devices_user ON notification_devices(user_id)",
		"CREATE TABLE notification_queue (device_id TEXT NOT NULL REFERENCES notification_devices(id) ON DELETE CASCADE, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, PRIMARY KEY(device_id,message_id))",
		"CREATE INDEX notification_queue_message ON notification_queue(message_id)",
	}
}
