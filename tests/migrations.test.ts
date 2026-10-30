import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Sqlite from 'better-sqlite3';
import { openDatabase } from '../apps/api/src/db';
import { config } from '../apps/api/src/config';
import { passwordHash, passwordVerify, hash } from '../apps/api/src/security';
import { Service } from '../apps/api/src/service';
import { randomUUID } from 'node:crypto';

it('migrates and restores a schema-3 backup while preserving overrides, attachments and conversation data', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dorham-v3-restore-')), c = config({ dataDir: dir, databaseUrl: '' }); let db = await openDatabase(c);
  try {
    const uid = randomUUID(); await db.run('INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)', [uid, 'v3_restore', 'Preserved profile', 'fixture', Date.now()]);
    const service = new Service(db, c), server = await service.createServer(uid, randomUUID(), 'Preserved community');
    const channel = (await service.bootstrap(uid)).channels.find(ch => ch.serverId === server.id && ch.kind === 'text')!;
    await service.changeChannel(uid, randomUUID(), channel.id, { role: 'member', permissions: { write: false, share: false }, expectedRevision: 0 });
    await service.send(uid, randomUUID(), channel.conversationId!, 'Kept across migration and restore');
    const attachment = randomUUID(); await db.run('INSERT INTO attachments(id,user_id,conversation_id,request_id,name,size,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)', [attachment, uid, channel.conversationId, randomUUID(), 'kept.png', 123, 'ready', Date.now(), Date.now() + 86400000]);
    for (const column of ['tier', 'started_at', 'requested_fps', 'include_audio', 'policy_revision']) await db.run(`ALTER TABLE share_leases DROP COLUMN ${column}`);
    await db.run('ALTER TABLE servers DROP COLUMN allow_member_invites'); await db.run('DELETE FROM schema_migrations WHERE version=5');
    await db.run('ALTER TABLE channel_overrides DROP COLUMN revision'); await db.run('DELETE FROM schema_migrations WHERE version=4');
    const backup = path.join(dir, 'schema3.sqlite'); await db.backup(backup); await db.close(); db = await openDatabase(c);
    expect(await db.one('SELECT revision,permissions FROM channel_overrides WHERE channel_id=?', [channel.id])).toEqual({ revision: 1, permissions: JSON.stringify({ write: false, share: false }) });
    expect((await new Service(db, c).history(uid, channel.conversationId!)).messages![0].content).toBe('Kept across migration and restore');
    const restoredDir = path.join(dir, 'restored'); const { mkdir } = await import('node:fs/promises'); await mkdir(restoredDir);
    const raw = new Sqlite(backup, { readonly: true }); await raw.backup(path.join(restoredDir, 'dorham.sqlite')); raw.close();
    const restored = await openDatabase(config({ dataDir: restoredDir, databaseUrl: '' }));
    try { expect((await restored.one('SELECT name FROM attachments WHERE id=?', [attachment]))!.name).toBe('kept.png'); expect((await restored.one('SELECT COUNT(*) AS n FROM messages'))!.n).toBe(1); expect(await restored.all('PRAGMA foreign_key_check')).toEqual([]); expect((await restored.one('PRAGMA integrity_check'))!.integrity_check).toBe('ok'); expect((await restored.all('SELECT version FROM schema_migrations ORDER BY version')).map(r => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); }
    finally { await restored.close(); }
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});

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
    expect((await db.all('SELECT version FROM schema_migrations ORDER BY version')).map(r => Number(r.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});

it('adds v3 roles and recovers recent active v2 invite links without changing their codes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dorham-v2-upgrade-'));
  let db = await openDatabase(config({ dataDir: dir, databaseUrl: '' }));
  try {
    const now = Date.now(), code = 'existing_invitation_code_123';
    await db.run('INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)', ['v2user', 'v2user', 'Keep profile', 'fixture', now]);
    await db.run('INSERT INTO servers(id,name,owner_id,created_at) VALUES(?,?,?,?)', ['v2server', 'Keep server', 'v2user', now]);
    await db.run('INSERT INTO invites(hash,server_id,expires_at,remaining,created_by) VALUES(?,?,?,?,?)', [hash(code), 'v2server', now + 86400000, 5, 'v2user']);
    await db.run('INSERT INTO mutations(user_id,request_id,operation,fingerprint,response,created_at) VALUES(?,?,?,?,?,?)', ['v2user', 'prior-invite-request', 'invite.create', 'prior-fingerprint', JSON.stringify({ code, url: `https://example.test/?invite=${code}` }), now]);
    await db.run('ALTER TABLE dm_members DROP COLUMN hidden'); await db.run('DROP TABLE user_blocks'); await db.run('DROP TABLE member_roles'); await db.run('DROP TABLE custom_roles'); await db.run('ALTER TABLE invites DROP COLUMN code'); await db.run('DELETE FROM schema_migrations WHERE version=3');
    await db.close(); db = await openDatabase(config({ dataDir: dir, databaseUrl: '' }));
    expect(await db.one('SELECT code,remaining FROM invites WHERE hash=?', [hash(code)])).toEqual({ code, remaining: 5 });
    expect((await db.one('SELECT display_name FROM users WHERE id=?', ['v2user']))!.display_name).toBe('Keep profile');
    expect(await db.all('PRAGMA foreign_key_check')).toEqual([]);
    await db.close(); db = await openDatabase(config({ dataDir: dir, databaseUrl: '' }));
    expect(await db.all('SELECT * FROM custom_roles')).toEqual([]);
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});
