import { expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../apps/api/src/db';
import { config } from '../apps/api/src/config';
import { Service } from '../apps/api/src/service';
import { randomUUID } from 'node:crypto';

it('runs the PostgreSQL wire adapter and service transactions against a real PostgreSQL WASM engine', async () => {
  const engine = await PGlite.create();
  const server = new PGLiteSocketServer({ db: engine, host: '127.0.0.1', port: 0, maxConnections: 4 });
  await server.start();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dorham-postgres-'));
  const conn = server.getServerConn();
  const databaseUrl = conn.startsWith('postgres') ? conn : `postgresql://postgres:postgres@${conn}/postgres`;
  const c = config({ dataDir, databaseUrl, roomShares: 0, globalShares: 0 }); const db = await openDatabase(c); const service = new Service(db, c);
  try {
    for (const [id, username] of [['a', 'alice'], ['b', 'bravo']]) await db.run('INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)', [id, username, username, 'test-fixture-not-a-password', Date.now()]);
    const dm = await service.dm('a', randomUUID(), 'b'); const rid = randomUUID();
    const first = await service.send('a', rid, dm.id, 'PostgreSQL persisted this.');
    const retry = await service.send('a', rid, dm.id, 'PostgreSQL persisted this.'); expect(first).toEqual(retry);
    const history = await service.history('b', dm.id); expect((history as any).messages[0].content).toBe('PostgreSQL persisted this.');
    const serverData = await service.createServer('a', randomUUID(), 'Postgres room'); expect((await service.bootstrap('a')).servers[0].id).toBe(serverData.id);
    const custom = await service.changeCustomRole('a', randomUUID(), serverData.id, { name: 'PG role', color: '#aabbcc', permissions: { speak: false } });
    expect((await service.customRoles('a', serverData.id)).roles[0].id).toBe(custom.id);
    await expect(service.mutate('a', randomUUID(), 'rollback.test', {}, async tx => { await tx.run('UPDATE users SET bio=? WHERE id=?', ['must rollback', 'a']); throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect((await db.one('SELECT bio FROM users WHERE id=?', ['a']))!.bio).toBe('');
    expect(db.dialect).toBe('postgres');
    const text = (await service.bootstrap('a')).channels.find(ch => ch.kind === 'text')!;
    await service.changeChannel('a', randomUUID(), text.id, { role: 'member', permissions: { write: false }, expectedRevision: 0 });
    expect(await service.channelOverrides('a', text.id, 'member')).toMatchObject({ revision: 1, permissions: { write: false } });
    await expect(service.changeChannel('a', randomUUID(), text.id, { role: 'member', permissions: {}, expectedRevision: 0 })).rejects.toMatchObject({ status: 409 });
    for (const id of ['c', 'd']) await db.run('INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)', [id, `pg_${id}`, `pg_${id}`, 'test-fixture-not-a-password', Date.now()]);
    const invitation = await service.invite('a', randomUUID(), serverData.id, 'pg_share_invitation', 24, 10);
    for (const id of ['b', 'c', 'd']) await service.joinInvite(id, randomUUID(), invitation.code);
    const main = (await service.bootstrap('a')).channels.find(ch => ch.kind === 'voice')!;
    const extra = await service.createChannel('a', randomUUID(), serverData.id, 'PG fallback', 'voice');
    for (const id of ['a', 'b', 'c', 'd']) await service.joinVoice(id, `pg-socket-${id}`, id === 'd' ? extra.id : main.id, true);
    const shares = await Promise.all(['a', 'b', 'c'].map(id => service.share(id, `pg-socket-${id}`, randomUUID())));
    const fallback = await service.share('d', 'pg-socket-d', randomUUID()); expect(fallback.lease?.tier).toBe('fallback');
    await service.share('a', 'pg-socket-a', randomUUID(), true);
    expect((await service.room('d', extra.id)).shares[0]).toMatchObject({ tier: 'standard', requestedFrameRate: 15 });
    expect(shares).toHaveLength(3);
    for (const id of ['e', 'f']) { await db.run('INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)', [id, `pg_${id}`, `pg_${id}`, 'fixture', Date.now()]); await service.joinInvite(id, randomUUID(), invitation.code); }
    const waitingRoom = await service.createChannel('a', randomUUID(), serverData.id, 'PG waiting', 'voice');
    for (const id of ['e', 'f']) await service.joinVoice(id, `pg-socket-${id}`, waitingRoom.id, true);
    expect((await service.share('e', 'pg-socket-e', randomUUID())).lease?.tier).toBe('fallback');
    await expect(service.share('f', 'pg-socket-f', randomUUID())).rejects.toMatchObject({ code: 'SHARE_LIMIT' });
    await db.run('UPDATE share_leases SET expires_at=? WHERE user_id=?', [Date.now() - 1, 'b']);
    expect((await service.room('e', waitingRoom.id)).shares[0]).toMatchObject({ tier: 'standard', requestedFrameRate: 15 });
    await service.moderate('a', randomUUID(), waitingRoom.id, 'e', 'stopShare'); expect((await service.room('e', waitingRoom.id)).shares).toHaveLength(0);
  } finally { await db.close(); await server.stop(); await engine.close(); await rm(dataDir, { recursive: true, force: true }); }
}, 45000);
