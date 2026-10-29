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
  const c = config({ dataDir, databaseUrl }); const db = await openDatabase(c); const service = new Service(db, c);
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
  } finally { await db.close(); await server.stop(); await engine.close(); await rm(dataDir, { recursive: true, force: true }); }
}, 45000);
