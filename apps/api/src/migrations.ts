import { createHash } from 'node:crypto';
import type { Database } from './db';

// All DDL is transactional in both supported databases. Never rewrite a v1 table
// or remove data during startup. Run one migrator before overlapping deployments.
export async function migrateExpansion(db: Database) {
  await db.transaction(async tx => {
    if (await tx.one('SELECT version FROM schema_migrations WHERE version=2')) return;
    for (const query of [
      "ALTER TABLE users ADD COLUMN guest INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE servers ADD COLUMN allow_guests INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE channels ADD COLUMN locked INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE channels ADD COLUMN user_limit INTEGER NOT NULL DEFAULT 16",
      "ALTER TABLE channels ADD COLUMN tag_mode TEXT NOT NULL DEFAULT 'ANY'",
      "ALTER TABLE voice_members ADD COLUMN server_deafened INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sessions ADD COLUMN device_name TEXT NOT NULL DEFAULT 'Unknown device'",
      "ALTER TABLE sessions ADD COLUMN last_seen BIGINT NOT NULL DEFAULT 0",
      'CREATE TABLE recovery_codes (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, code_hash TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(user_id,code_hash))',
      'CREATE TABLE recovery_questions (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, question TEXT NOT NULL, answer_hash TEXT NOT NULL)',
      'CREATE TABLE recovery_attempts (subject TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at BIGINT NOT NULL)',
      'CREATE TABLE audit_log (id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target_id TEXT, details TEXT NOT NULL, created_at BIGINT NOT NULL)',
      'CREATE INDEX audit_age ON audit_log(created_at)',
      'CREATE TABLE tags (id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL, UNIQUE(server_id,name))',
      'CREATE TABLE user_tags (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(user_id,tag_id))',
      'CREATE TABLE channel_tags (channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(channel_id,tag_id))',
      'CREATE TABLE voice_restrictions (channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, muted INTEGER NOT NULL DEFAULT 0, deafened INTEGER NOT NULL DEFAULT 0, sharing_allowed INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(channel_id,user_id))',
      'CREATE TABLE attachments (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, message_id TEXT REFERENCES messages(id) ON DELETE SET NULL, request_id TEXT NOT NULL, name TEXT NOT NULL, size BIGINT NOT NULL, digest TEXT, state TEXT NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, UNIQUE(user_id,request_id))',
      'CREATE INDEX attachments_quota ON attachments(user_id,created_at)',
      'CREATE INDEX attachments_expiry ON attachments(state,expires_at)',
      'CREATE TABLE attachment_usage (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, bytes BIGINT NOT NULL, created_at BIGINT NOT NULL)',
      'CREATE INDEX attachment_usage_user ON attachment_usage(user_id,created_at)'
    ]) await tx.run(query);
    await tx.run('INSERT INTO schema_migrations(version,applied_at) VALUES(2,?)', [Date.now()]);
  });
  await db.transaction(async tx => {
    if (await tx.one('SELECT version FROM schema_migrations WHERE version=3')) return;
    await tx.run('ALTER TABLE invites ADD COLUMN code TEXT');
    // v2 stored only invite hashes, but recent idempotency replies still contain
    // their original code. Recover active links without minting replacement invites.
    for (const row of await tx.all("SELECT response FROM mutations WHERE operation='invite.create' ORDER BY created_at DESC LIMIT 5000")) {
      let code: unknown;
      try { code = JSON.parse(row.response).code; } catch { continue; }
      if (typeof code === 'string' && /^[a-zA-Z0-9_-]{10,100}$/.test(code)) await tx.run('UPDATE invites SET code=? WHERE hash=? AND expires_at>? AND remaining>0', [code, createHash('sha256').update(code).digest('hex'), Date.now()]);
    }

    await tx.run('ALTER TABLE dm_members ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
    await tx.run('CREATE TABLE user_blocks (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(user_id,blocked_id))');
    await tx.run('CREATE TABLE custom_roles (id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL, permissions TEXT NOT NULL, UNIQUE(server_id,name))');
    await tx.run('CREATE TABLE member_roles (server_id TEXT NOT NULL, user_id TEXT NOT NULL, role_id TEXT NOT NULL REFERENCES custom_roles(id) ON DELETE CASCADE, PRIMARY KEY(server_id,user_id,role_id), FOREIGN KEY(server_id,user_id) REFERENCES members(server_id,user_id) ON DELETE CASCADE)');
    await tx.run('INSERT INTO schema_migrations(version,applied_at) VALUES(3,?)', [Date.now()]);
  });

}
