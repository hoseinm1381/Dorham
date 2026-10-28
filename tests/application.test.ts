import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, event } from './helpers';
import { basePermissions, resolvePermissions, canManage } from '@dorham/contracts';
let h: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
describe('permissions', () => {
  it('resolves role defaults, explicit deny/allow, owner immunity, and hierarchy', () => {
    expect(basePermissions('member').moderate).toBe(false); expect(basePermissions('moderator').moderate).toBe(true);
    expect(resolvePermissions('member', { view: false, share: false }).view).toBe(false);
    expect(resolvePermissions('member', { moderate: true }).moderate).toBe(true);
    expect(resolvePermissions('owner', { view: false }).view).toBe(true);
    expect(canManage('moderator', 'administrator')).toBe(false); expect(canManage('administrator', 'moderator')).toBe(true);
  });
});
describe('accounts and access', () => {
  it('closes the server while authenticated WebSocket clients remain connected', async () => {
    h = await harness(); const user = await h.register('shutdown_check'); const socket = await h.connect(user);
    expect(socket.connected).toBe(true);
    const stopped = new Promise<void>(resolve => socket.once('disconnect', () => resolve()));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([h.app.close(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Shutdown waited for a chat client')), 2000); })]);
      await stopped; expect(socket.connected).toBe(false);
    } finally { if (timeout) clearTimeout(timeout); socket.disconnect(); }
  });
  it('validates input, rejects foreign origins, claims administration once, and warns before WAL-backed storage fills', async () => {
    h = await harness({ maxDatabaseMiB: 1 }); const a = await h.register('alice'), b = await h.register('bravo');
    expect((await h.api(a, '/servers', { name: '' })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { authorization: `Bearer ${a.token}`, origin: 'https://untrusted.example' } })).statusCode).toBe(403);
    expect((await h.api(a, '/admin/metrics')).statusCode).toBe(403);
    expect((await h.api(a, '/admin/claim', { secret: 'test-bootstrap-secret' })).statusCode).toBe(200);
    expect((await h.api(b, '/admin/claim', { secret: 'test-bootstrap-secret' })).statusCode).toBe(409);
    await h.db.run('CREATE TABLE pressure (payload BLOB NOT NULL)'); await h.db.run('INSERT INTO pressure(payload) VALUES(zeroblob(700000))');
    const storage = (await h.api(a, '/admin/metrics')).json().storage; expect(storage.databaseBytes).toBeLessThan(1048576); expect(storage.warnings).toContain('Database is at least 80% of its page budget. Prune data or migrate storage.');
  });
  it('enforces account capacity under concurrent registration', async () => {
    h = await harness({ maxUsers: 1 });
    const responses = await Promise.all(['alpha', 'bravo'].map(username => h!.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username, displayName: username, password: 'very-secret-password', requestId: randomUUID() } })));
    expect(responses.map(r => r.statusCode).sort()).toEqual([201, 409]); expect((await h.db.one('SELECT COUNT(*) AS count FROM users'))!.count).toBe(1);
  });
  it('hashes passwords and tokens; rotates native refresh credentials and revokes reuse', async () => {
    h = await harness(); const user = await h.register('alice');
    expect((await h.db.one('SELECT password_hash FROM users'))!.password_hash).toMatch(/^\$argon2id\$/);
    expect((await h.db.one('SELECT access_hash FROM sessions'))!.access_hash).not.toBe(user.token);
    const refresh = async (refreshToken: string) => h!.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken, requestId: randomUUID() } });
    const rotated = await refresh(user.refreshToken); expect(rotated.statusCode).toBe(200);
    expect((await h.api(user, '/bootstrap')).statusCode).toBe(401);
    expect((await refresh(user.refreshToken)).statusCode).toBe(401);
    expect((await h.api({ token: rotated.json().accessToken }, '/bootstrap')).statusCode).toBe(401);
  });
  it('requires cookie CSRF and separates instance administration from registration', async () => {
    h = await harness();
    const r = await h.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username: 'alice', displayName: 'Alice', password: 'very-secret-password', requestId: randomUUID() } });
    const cookie = r.headers['set-cookie']!.toString().split(';')[0]; expect(r.json().user.instanceAdmin).toBe(false);
    const payload = { name: 'Friends', requestId: randomUUID() };
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/servers', headers: { cookie }, payload })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/servers', headers: { cookie, origin: 'http://localhost:5173', 'x-csrf-token': r.json().csrf }, payload })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { cookie, origin: 'https://evil.example' } })).statusCode).toBe(403);
  });
});
describe('messages and membership', () => {
  it('protects DMs, commits once, replays edits/deletion, reactions, and monotonic reads', async () => {
    h = await harness(); const a = await h.register('alice'), b = await h.register('bravo'), c = await h.register('charlie');
    const dm = (await h.api(a, '/dms', { userId: b.id })).json().id;
    expect((await h.api(c, `/conversations/${dm}/messages`)).statusCode).toBe(403);
    const requestId = randomUUID(), body = { conversationId: dm, content: '<script>alert(1)</script>', requestId };
    const first = await h.api(a, '/messages', body), duplicate = await h.api(a, '/messages', body);
    expect(first.json()).toEqual(duplicate.json()); expect((await h.db.one('SELECT COUNT(*) AS count FROM messages'))!.count).toBe(1);
    expect((await h.api(a, '/messages', { ...body, content: 'changed' })).statusCode).toBe(409);
    const messageId = first.json().payload.id;
    expect((await h.api(b, `/messages/${messageId}`, { content: 'forged' }, 'PATCH')).statusCode).toBe(403);
    expect((await h.api(a, `/messages/${messageId}`, { content: 'Edited' }, 'PATCH')).statusCode).toBe(200);
    expect((await h.api(b, `/messages/${messageId}`, { emoji: '👍' }, 'PATCH')).statusCode).toBe(200);
    const replay = (await h.api(b, `/conversations/${dm}/messages?after=0`)).json(); expect(replay.events).toHaveLength(3); expect(replay.events[1].payload.content).toBe('Edited');
    await h.api(a, `/conversations/${dm}/read`, { sequence: 3 }); await h.api(a, `/conversations/${dm}/read`, { sequence: 1 });
    expect((await h.db.one('SELECT sequence FROM read_cursors'))!.sequence).toBe(3);
    await h.api(a, `/messages/${messageId}`, { delete: true }, 'PATCH');
    expect((await h.api(b, `/conversations/${dm}/messages`)).json().messages[0].deleted).toBe(true);
  });
  it('exhausts invites atomically, enforces channel overrides, hierarchy and removal', async () => {
    h = await harness(); const a = await h.register('alice'), b = await h.register('bravo'), c = await h.register('charlie');
    const serverId = (await h.api(a, '/servers', { name: 'Friends' })).json().id;
    const invite = (await h.api(a, `/servers/${serverId}/invites`, { uses: 1 })).json();
    const results = await Promise.all([b, c].map(u => h!.api(u, '/invites/join', { code: invite.code })));
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 404]);
    const member = results[0].statusCode === 200 ? b : c;
    expect((await h.api(member, `/servers/${serverId}`, { name: 'Stolen' }, 'PATCH')).statusCode).toBe(403);
    const cv = (await h.api(a, '/bootstrap')).json().channels.find((ch: any) => ch.kind === 'text');
    await h.api(a, `/channels/${cv.id}`, { role: 'member', permissions: { view: false } }, 'PATCH');
    expect((await h.api(member, `/conversations/${cv.conversationId}/messages`)).statusCode).toBe(403);
    await h.api(a, `/servers/${serverId}/members/${member.id}`, { role: 'moderator' }, 'PATCH');
    expect((await h.api(member, `/servers/${serverId}/members/${a.id}`, { remove: true }, 'PATCH')).statusCode).toBe(403);
    await h.api(a, `/servers/${serverId}/members/${member.id}`, { remove: true }, 'PATCH');
    expect((await h.api(member, `/servers/${serverId}/members`)).statusCode).toBe(403);
  });
  it('makes consistent online backups, refuses live restore, and restores usable accounts/history after restart', async () => {
    h = await harness(); const a = await h.register('alice'), b = await h.register('bravo');
    const dm = (await h.api(a, '/dms', { userId: b.id })).json().id;
    await h.api(a, '/messages', { conversationId: dm, content: 'Preserve me' });
    const { default: Sqlite } = await import('better-sqlite3'); const backup = `${h.dataDir}/backup.sqlite`; await h.db.backup(backup);
    const copy = new Sqlite(backup, { readonly: true }); expect(copy.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' }); expect(copy.prepare('SELECT content FROM messages').get()).toEqual({ content: 'Preserve me' }); copy.close();
    const { spawnSync } = await import('node:child_process');
    const args = ['node_modules/tsx/dist/cli.mjs', 'scripts/database.ts', 'restore', backup];
    const env = { ...process.env, DATA_DIR: h.dataDir, DATABASE_URL: '' };
    const live = spawnSync(process.execPath, args, { env, encoding: 'utf8' }); expect(live.status).not.toBe(0); expect(live.stderr).toContain('Stop the server');
    await h.app.close();
    const broken = new Sqlite(`${h.dataDir}/dorham.sqlite`); broken.prepare('UPDATE messages SET content=?').run('Changed after backup'); broken.close();
    const restored = spawnSync(process.execPath, args, { env, encoding: 'utf8' }); expect(restored.status, restored.stderr).toBe(0);
    const { createApp } = await import('../apps/api/src/app'); const restarted = await createApp(h.config, { logger: false, rateLimit: false });
    try { const history = await restarted.app.inject({ method: 'GET', url: `/api/v1/conversations/${dm}/messages`, headers: { authorization: `Bearer ${a.token}` } }); expect(history.statusCode).toBe(200); expect(history.json().messages[0].content).toBe('Preserve me'); } finally { await restarted.app.close(); }
  });
});
describe('real-time voice control', () => {
  it('revokes live speaking and sharing when a role loses channel privileges', async () => {
    h = await harness(); const owner = await h.register('owner'), member = await h.register('member');
    const server = (await h.api(owner, '/servers', { name: 'Permissions' })).json();
    const invite = (await h.api(owner, `/servers/${server.id}/invites`, {})).json(); await h.api(member, '/invites/join', { code: invite.code });
    const channel = (await h.api(owner, '/bootstrap')).json().channels.find((c: any) => c.kind === 'voice');
    await h.api(owner, `/channels/${channel.id}`, { role: 'member', permissions: { speak: false, share: false } }, 'PATCH');
    await h.api(owner, `/servers/${server.id}/members/${member.id}`, { role: 'moderator' }, 'PATCH');
    const socket = await h.connect(member); await event(socket, 'voice:join', { channelId: channel.id, eligible: true }); await event(socket, 'share:start', { requestId: randomUUID() });
    expect((await h.service.room(owner.id, channel.id)).shares).toHaveLength(1);
    await h.api(owner, `/servers/${server.id}/members/${member.id}`, { role: 'member' }, 'PATCH');
    const room = await h.service.room(owner.id, channel.id); expect(room.shares).toHaveLength(0); expect(room.members[0].serverMuted).toBe(true);
    await expect(event(socket, 'share:start', { requestId: randomUUID() })).rejects.toThrow('FORBIDDEN');
    await h.api(owner, `/servers/${server.id}/members/${member.id}`, { remove: true }, 'PATCH');
    expect((await h.service.room(owner.id, channel.id)).members).toHaveLength(0);
  });
  it('enforces room/global share limits, fences signaling, migrates coordinator and cleans expired leases', async () => {
    h = await harness({ maxVoice: 3, roomShares: 2, globalShares: 2 });
    const users = []; for (let i = 0; i < 4; i++) users.push(await h.register(`user${i}`));
    const serverId = (await h.api(users[0], '/servers', { name: 'Voice tests' })).json().id;
    const inv = (await h.api(users[0], `/servers/${serverId}/invites`, { uses: 10 })).json();
    for (const u of users.slice(1)) await h.api(u, '/invites/join', { code: inv.code });
    const channel = (await h.api(users[0], '/bootstrap')).json().channels.find((c: any) => c.kind === 'voice');
    const sockets: Awaited<ReturnType<typeof h.connect>>[] = []; for (const u of users) sockets.push(await h.connect(u));
    const joins = []; for (const s of sockets.slice(0, 3)) joins.push(await event(s, 'voice:join', { channelId: channel.id, eligible: true }));
    await expect(event(sockets[3], 'voice:join', { channelId: channel.id, eligible: true })).rejects.toThrow('ROOM_FULL');
    const requests = await Promise.allSettled(sockets.slice(0, 3).map(s => event(s, 'share:start', { requestId: randomUUID() })));
    expect(requests.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    expect((await h.db.one('SELECT COUNT(*) AS count FROM share_leases'))!.count).toBe(2);
    await expect(event(sockets[0], 'voice:signal', { channelId: channel.id, epoch: 'stale', to: users[1].id })).rejects.toThrow('STALE_EPOCH');
    const received = new Promise<any>(resolve => sockets[1].once('voice:signal', resolve));
    await event(sockets[0], 'voice:signal', { channelId: channel.id, epoch: joins[0].epoch, to: users[1].id, candidate: { candidate: 'candidate:test' } });
    expect((await received).from).toBe(users[0].id);
    const before = await h.service.room(users[1].id, channel.id); expect(before.coordinatorId).toBe(users[0].id);
    await event(sockets[0], 'voice:leave', { requestId: randomUUID() });
    const after = await h.service.room(users[1].id, channel.id); expect(after.coordinatorId).toBe(users[1].id); expect(after.coordinatorEpoch).toBeGreaterThan(before.coordinatorEpoch);
    await h.db.run('UPDATE voice_members SET heartbeat=? WHERE user_id=?', [Date.now() - 16000, users[1].id]);
    const migrated = await h.service.room(users[2].id, channel.id); expect(migrated.coordinatorId).toBe(users[2].id); expect(migrated.coordinatorEpoch).toBeGreaterThan(after.coordinatorEpoch);
    await h.db.run('UPDATE share_leases SET expires_at=0'); await h.service.cleanup(); expect((await h.db.one('SELECT COUNT(*) AS count FROM share_leases'))!.count).toBe(0);
  });
  it('enforces online capacity including simultaneous handshakes', async () => {
    h = await harness({ maxOnline: 1 }); const a = await h.register('alice'), b = await h.register('bravo'); await h.connect(a); await expect(h.connect(b)).rejects.toThrow('capacity');
  });
});
