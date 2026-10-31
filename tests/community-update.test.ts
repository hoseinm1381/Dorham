import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { harness } from './helpers';
import { hash } from '../apps/api/src/security';
let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => { h = await harness(); }); afterEach(async () => { await h.close(); });

it('issues hashed, single-use recovery codes on registration and remembers acknowledgement across devices', async () => {
  const user = await h.register('initial_recovery');
  expect(user.recoveryCodes).toHaveLength(8);
  const rows = await h.db.all('SELECT code_hash FROM recovery_codes WHERE user_id=?', [user.id]);
  expect(rows.map(row => row.code_hash).sort()).toEqual(user.recoveryCodes.map(hash).sort());
  expect(JSON.stringify(await h.db.all('SELECT * FROM mutations'))).not.toContain(user.recoveryCodes[0]);
  expect((await h.api(user, '/auth/recovery')).json()).toMatchObject({ prompt: true, codesRemaining: 8 });
  expect((await h.api(user, '/auth/recovery-acknowledge', {})).statusCode).toBe(200);
  expect((await h.api(user, '/auth/recovery')).json().prompt).toBe(false);
  const login = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-dorham-native': '1' }, payload: { username: user.user.username, password: 'correct-horse-123', requestId: randomUUID() } });
  expect(login.json().recoveryCodes).toBeUndefined();
  expect((await h.api({ token: login.json().accessToken }, '/auth/recovery')).json().prompt).toBe(false);
  const recover = () => h.app.inject({ method: 'POST', url: '/api/v1/auth/recover', payload: { username: user.user.username, password: 'replacement-secret-123', code: user.recoveryCodes[0], requestId: randomUUID() } });
  expect((await recover()).statusCode).toBe(200); expect((await recover()).statusCode).toBe(401);
  expect((await h.api(user, '/auth/me')).statusCode).toBe(401);
});

it('keeps legacy recovery codes unchanged until the user explicitly replaces them', async () => {
  const user = await h.register('legacy_recovery'), original = await h.db.all('SELECT * FROM recovery_codes WHERE user_id=?', [user.id]);
  await h.db.run('UPDATE users SET recovery_prompt_seen=0 WHERE id=?', [user.id]);
  expect((await h.api(user, '/auth/recovery')).json().prompt).toBe(true);
  await h.api(user, '/auth/recovery-acknowledge', {});
  expect(await h.db.all('SELECT * FROM recovery_codes WHERE user_id=?', [user.id])).toEqual(original);
  expect((await h.api(user, '/auth/recovery-codes', { password: 'wrong-password' })).statusCode).toBe(401);
  expect(await h.db.all('SELECT * FROM recovery_codes WHERE user_id=?', [user.id])).toEqual(original);
});

it('orders direct conversations by actual message creation, including received messages, and leaves empty chats identifiable', async () => {
  const a = await h.register('dm_alice'), b = await h.register('dm_bob'), c = await h.register('dm_claire');
  const ab = (await h.api(a, '/dms', { userId: b.id })).json().id, ac = (await h.api(a, '/dms', { userId: c.id })).json().id;
  expect((await h.api(a, '/bootstrap')).json().dms.every((d: any) => d.lastMessageAt === 0)).toBe(true);
  const first = (await h.api(a, '/messages', { conversationId: ab, content: 'Older chat' })).json();
  await h.api(c, '/messages', { conversationId: ac, content: 'Received last' });
  await h.db.run('UPDATE messages SET created_at=created_at-1000 WHERE id=?', [first.payload.id]);
  expect((await h.api(a, '/bootstrap')).json().dms.map((d: any) => d.id)).toEqual([ac, ab]);
  await h.api(a, `/messages/${first.payload.id}`, { content: 'Edited later' }, 'PATCH');
  expect((await h.api(a, '/bootstrap')).json().dms[0].id).toBe(ac);
  await h.api(b, '/messages', { conversationId: ab, content: 'New reply' });
  expect((await h.api(a, '/bootstrap')).json().dms[0].id).toBe(ab);
});

it('returns guest landing context when an invite is exhausted, supports target deletion, and rejects cross-server destinations', async () => {
  const owner = await h.register('invite_destination'), server = (await h.api(owner, '/servers', { name: 'Invited space' })).json();
  const text = (await h.api(owner, '/bootstrap')).json().channels.find((c: any) => c.serverId === server.id && c.kind === 'text');
  const invite = (await h.api(owner, `/servers/${server.id}/invites`, { channelId: text.id, uses: 1 })).json();
  const payload = { displayName: 'Guest landing', code: invite.code, requestId: randomUUID() };
  const guest = () => h.app.inject({ method: 'POST', url: '/api/v1/auth/guest', headers: { 'x-dorham-native': '1' }, payload });
  const response = await guest(); expect(response.statusCode).toBe(201); expect(response.json().landing).toEqual({ serverId: server.id, channelId: text.id });
  expect((await guest()).json().landing).toEqual(response.json().landing);
  expect((await h.api({ token: response.json().accessToken }, '/auth/recovery')).json().prompt).toBe(false);
  const elsewhere = (await h.api(owner, '/servers', { name: 'Other space' })).json();
  expect((await h.api(owner, `/servers/${elsewhere.id}/invites`, { channelId: text.id })).statusCode).toBe(400);
  const link = (await h.api(owner, `/servers/${server.id}/invites`, { channelId: text.id })).json();
  await h.api(owner, `/channels/${text.id}`, { delete: true }, 'PATCH');
  expect((await h.api(owner, `/servers/${server.id}/invites`)).json().invites.find((i: any) => i.code === link.code).channelId).toBeNull();
});

it('authorizes, sanitizes, refreshes and removes server icons without accepting remote URLs', async () => {
  const owner = await h.register('icon_owner'), member = await h.register('icon_member'), server = (await h.api(owner, '/servers', { name: 'Icon lab' })).json();
  const invite = (await h.api(owner, `/servers/${server.id}/invites`, {})).json(); await h.api(member, '/invites/join', { code: invite.code });
  const image = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#8571e9' } }).png().toBuffer();
  const upload = (user: typeof owner, bytes: Buffer) => {
    const boundary = 'dorham-icon-boundary'; return h.app.inject({ method: 'POST', url: `/api/v1/servers/${server.id}/icon`, headers: { authorization: `Bearer ${user.token}`, 'x-request-id': randomUUID(), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="icon"; filename="icon.png"\r\nContent-Type: image/png\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]) });
  };
  expect((await upload(member, image)).statusCode).toBe(403);
  expect((await upload(owner, Buffer.from('invalid'))).statusCode).toBe(400);
  const response = await upload(owner, image); expect(response.statusCode, response.body).toBe(200);
  const icon = response.json().icon; expect(icon).toMatch(/^\/avatars\/[a-f0-9-]+\.webp$/);
  expect((await h.api(member, '/bootstrap')).json().servers[0].icon).toBe(icon);
  const metadata = await sharp(await readFile(path.join(h.dataDir, icon))).metadata(); expect(metadata).toMatchObject({ width: 128, height: 128, format: 'webp' });
  expect((await h.api(member, `/servers/${server.id}/icon`, {}, 'DELETE')).statusCode).toBe(403);
  expect((await h.api(owner, `/servers/${server.id}/icon`, {}, 'DELETE')).statusCode).toBe(200);
  expect((await h.api(owner, '/bootstrap')).json().servers[0].icon).toBeNull();
  await expect(access(path.join(h.dataDir, icon))).rejects.toThrow();
});
