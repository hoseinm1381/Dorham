import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Sqlite from 'better-sqlite3';
import { openDatabase } from '../apps/api/src/db';
import { config } from '../apps/api/src/config';
import { passwordHash, passwordVerify, hash } from '../apps/api/src/security';
import { Service } from '../apps/api/src/service';

it('upgrades the actual v1 schema without losing existing users, sessions, messages or ownership', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dorham-v1-upgrade-')), file = path.join(dir, 'dorham.sqlite'), old = new Sqlite(file), now = Date.now(), encoded = await passwordHash('legacy-pass88');
  old.pragma('foreign_keys=ON'); old.exec(await readFile('tests/fixtures/v1.sql', 'utf8'));
  old.prepare('INSERT INTO schema_migrations VALUES(1,?)').run(now);
  old.prepare('INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)').run('legacy-user', 'legacy_user', 'Legacy person', encoded, now);
  old.prepare('INSERT INTO sessions(id,user_id,access_hash,csrf,access_expires,expires_at,created_at) VALUES(?,?,?,?,?,?,?)').run('legacy-session', 'legacy-user', hash('fixture-access-never-used-publicly'), 'fixture-csrf', now + 86400000, now + 30 * 86400000, now);
  old.prepare('INSERT INTO servers VALUES(?,?,?,?)').run('legacy-server', 'Keep this server', 'legacy-user', now);
  old.prepare('INSERT INTO members VALUES(?,?,?,?)').run('legacy-server', 'legacy-user', 'owner', now);
  old.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run('legacy-conversation', 'channel', 1, now);
  old.prepare('INSERT INTO channels VALUES(?,?,?,?,?,?)').run('legacy-channel', 'legacy-server', 'Keep this channel', 'text', 'legacy-conversation', now);
  old.prepare('INSERT INTO messages(id,conversation_id,sequence,user_id,content,created_at) VALUES(?,?,?,?,?,?)').run('legacy-message', 'legacy-conversation', 1, 'legacy-user', 'Persisted before the upgrade', now);
  old.close();
  let db = await openDatabase(config({ dataDir: dir, databaseUrl: '' }));
  try {
    const user = await db.one('SELECT * FROM users WHERE id=?', ['legacy-user']); expect(user!.guest).toBe(0); expect(await passwordVerify(user!.password_hash, 'legacy-pass88')).toBe(true);
    expect((await db.one('SELECT id FROM sessions WHERE id=?', ['legacy-session']))!.id).toBe('legacy-session');
    const service = new Service(db, config({ dataDir: dir, databaseUrl: '' }));
    const history = await service.history('legacy-user', 'legacy-conversation'); expect(history.messages![0].content).toBe('Persisted before the upgrade');
    expect((await service.bootstrap('legacy-user')).servers[0].ownerId).toBe('legacy-user');
    expect(await db.all('PRAGMA foreign_key_check')).toHaveLength(0);
    await db.close(); db = await openDatabase(config({ dataDir: dir, databaseUrl: '' }));
    expect((await db.all('SELECT version FROM schema_migrations ORDER BY version')).map(r => Number(r.version))).toEqual([1, 2]);
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});
