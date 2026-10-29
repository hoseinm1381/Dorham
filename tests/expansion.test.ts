import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { harness, event } from './helpers';
import { initializeAdministrator, resetPreview } from '../apps/api/src/admin-operations';
import { normalizeAnswer } from '../apps/api/src/accounts';
import { passwordVerify } from '../apps/api/src/security';
import { MiB, retentionMs } from '../apps/api/src/attachments';
import { channelLink, channelTarget, messageParts } from '../packages/contracts/src/links';
import { screenQualities, screenSettings } from '../packages/media/src/screen-quality';
import { Sfu } from '../apps/api/src/sfu';

let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => { h = await harness(); }); afterEach(async () => { await h.close(); });
async function room(owner: any) {
  const s = (await h.api(owner, '/servers', { name: 'Expansion lab' })).json();
  const snapshot = (await h.api(owner, '/bootstrap')).json();
  return { id: s.id, text: snapshot.channels.find((c: any) => c.serverId === s.id && c.kind === 'text'), voice: snapshot.channels.find((c: any) => c.serverId === s.id && c.kind === 'voice'), invite: (await h.api(owner, `/servers/${s.id}/invites`, {})).json() };
}
async function guest(invite: string, name = 'مهمان آزمایشی') {
  return h.app.inject({ method: 'POST', url: '/api/v1/auth/guest', headers: { 'x-dorham-native': '1' }, payload: { code: invite, displayName: name, requestId: randomUUID() } });
}
async function upload(owner: any, cv: string, bytes: Buffer, name = 'notes.txt') {
  const reserved = await h.api(owner, '/attachments', { conversationId: cv, name, size: bytes.length });
  expect(reserved.statusCode, reserved.body).toBe(200); const id = reserved.json().id;
  const response = await h.app.inject({ method: 'POST', url: `/api/v1/attachments/${id}/content`, headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) }, payload: bytes });
  expect(response.statusCode, response.body).toBe(200); return id;
}
it('keeps guest identity, messages and membership through conversion without granting privileges', async () => {
  const owner = await h.register('guest_owner'), r = await room(owner);
  expect((await guest('invalid-invitation')).statusCode).toBe(403);
  const response = await guest(r.invite.code); expect(response.statusCode).toBe(201);
  const g = { ...response.json(), token: response.json().accessToken, id: response.json().user.id };
  expect(g.user.guest).toBe(true);
  expect((await h.api(g, '/auth/me')).json().user.id).toBe(g.id);
  expect((await h.api(g, '/servers', { name: 'Escalation' })).statusCode).toBe(403);
  expect((await h.api(g, '/admin/claim', { secret: 'test-bootstrap-secret' })).statusCode).toBe(403);
  expect((await h.api(g, '/attachments', { conversationId: r.text.conversationId, name: 'a.txt', size: 2 })).statusCode).toBe(403);
  const message = await h.api(g, '/messages', { conversationId: r.text.conversationId, content: 'سلام از مهمان' }); expect(message.statusCode).toBe(200);
  const upgraded = await h.api(g, '/auth/upgrade', { username: 'converted_guest', displayName: 'Still the same person', password: 'eight888' }); expect(upgraded.statusCode, upgraded.body).toBe(200);
  const me = (await h.api(g, '/auth/me')).json().user; expect(me.id).toBe(g.id); expect(me.guest).toBe(false); expect(me.instanceAdmin).toBe(false);
  expect((await h.api(g, `/conversations/${r.text.conversationId}/messages`)).json().messages[0].author.id).toBe(g.id);
  const login = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-dorham-native': '1' }, payload: { username: 'converted_guest', password: 'eight888', requestId: randomUUID() } }); expect(login.statusCode).toBe(200);
  const otherGuest = (await guest(r.invite.code)).json(), outsider = { token: otherGuest.accessToken };
  const socket = await h.connect(outsider); await event(socket, 'voice:join', { channelId: r.voice.id, eligible: true });
  expect((await h.api(owner, `/servers/${r.id}`, { allowGuests: false }, 'PATCH')).statusCode).toBe(200);
  expect(await h.db.one('SELECT user_id FROM voice_members WHERE user_id=?', [otherGuest.user.id])).toBeUndefined();
  expect((await h.api(outsider, `/channels/${r.text.id}`)).statusCode).toBe(403);
  expect((await guest(r.invite.code)).statusCode).toBe(403);
});
it('uses single-use recovery codes, never questions alone, and revokes old sessions and sockets', async () => {
  const user = await h.register('recover_user'), socket = await h.connect(user);
  const question = await h.api(user, '/auth/recovery-question', { password: 'correct-horse-123', question: 'Favorite subject?', answer: '  ＭＡＴＨ   Class ' }); expect(question.statusCode).toBe(200);
  const stored = await h.db.one('SELECT * FROM recovery_questions WHERE user_id=?', [user.id]); expect(stored!.answer_hash).not.toContain('math'); expect(await passwordVerify(stored!.answer_hash, normalizeAnswer('math class'))).toBe(true);
  const rid = randomUUID(), issued = await h.api(user, '/auth/recovery-codes', { password: 'correct-horse-123', requestId: rid }); expect(issued.statusCode).toBe(200);
  const codes: string[] = issued.json().codes; expect(codes).toHaveLength(8);
  expect(JSON.stringify(await h.db.all('SELECT * FROM recovery_codes'))).not.toContain(codes[0]);
  expect((await h.api(user, '/auth/recovery-codes', { password: 'correct-horse-123', requestId: rid })).statusCode).toBe(409);
  const recover = (code: string) => h.app.inject({ method: 'POST', url: '/api/v1/auth/recover', payload: { username: 'recover_user', code, password: 'newpass88', requestId: randomUUID() } });
  expect((await recover('math class')).statusCode).toBe(401);
  const attempts = await Promise.all([recover(codes[0]), recover(codes[0])]); expect(attempts.map(r => r.statusCode).sort()).toEqual([200, 401]);
  expect((await h.api(user, '/auth/me')).statusCode).toBe(401); await expect.poll(() => socket.connected).toBe(false);
  expect(Number((await h.db.one('SELECT COUNT(*) AS count FROM recovery_codes'))!.count)).toBe(7);
  const events = await h.db.all('SELECT * FROM audit_log'); expect(events.some(e => e.action === 'account.recover')).toBe(true); expect(JSON.stringify(events)).not.toContain(codes[0]);
});
it('protects the global administrator and requires temporary-password replacement', async () => {
  const admin = await h.register('global_owner'), user = await h.register('managed_user');
  expect((await h.api(admin, '/admin/claim', { secret: 'test-bootstrap-secret' })).statusCode).toBe(200);
  expect((await h.api(user, `/admin/users/${admin.id}`, { action: 'ban' })).statusCode).toBe(403);
  expect((await h.api(admin, `/admin/users/${admin.id}`, { action: 'ban' })).statusCode).toBe(403);
  const reset = (await h.api(admin, `/admin/users/${user.id}`, { action: 'resetPassword' })).json(); expect(reset.temporaryPassword).toHaveLength(20);
  expect((await h.api(user, '/auth/me')).statusCode).toBe(401);
  const login = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-dorham-native': '1' }, payload: { username: 'managed_user', password: reset.temporaryPassword, requestId: randomUUID() } });
  expect(login.statusCode).toBe(200); const renewed = { token: login.json().accessToken };
  expect((await h.api(renewed, '/bootstrap')).statusCode).toBe(403);
  expect((await h.api(renewed, '/auth/password', { currentPassword: reset.temporaryPassword, password: 'newpass88' })).statusCode).toBe(200);
  expect((await h.api(renewed, '/bootstrap')).statusCode).toBe(200);
  await h.api(admin, `/admin/users/${user.id}`, { action: 'ban' }); expect((await h.api(renewed, '/bootstrap')).statusCode).toBe(401);
});
it('streams authorized attachments, rejects forged files and handles expiry and missing bytes', async () => {
  const owner = await h.register('files_owner'), outsider = await h.register('files_outsider'), r = await room(owner), bytes = Buffer.from('A small private attachment');
  const aid = await upload(owner, r.text.conversationId, bytes);
  expect((await h.api(owner, `/attachments/${aid}/download`)).statusCode).toBe(410);
  const sent = await h.api(owner, '/messages', { conversationId: r.text.conversationId, content: '', attachmentIds: [aid] }); expect(sent.statusCode, sent.body).toBe(200);
  const download = await h.api(owner, `/attachments/${aid}/download`); expect(download.rawPayload).toEqual(bytes); expect(download.headers['content-type']).toBe('application/octet-stream'); expect(download.headers['cache-control']).toBe('no-store');
  expect((await h.api(outsider, `/attachments/${aid}/download`)).statusCode).toBe(403);
  await writeFile(path.join(h.config.attachmentDir, `${aid}.bin`), 'corrupt'); expect((await h.api(owner, `/attachments/${aid}/download`)).statusCode).toBe(410);
  const bad = (await h.api(owner, '/attachments', { conversationId: r.text.conversationId, name: 'fake.png', size: 5 })).json();
  expect((await h.app.inject({ method: 'POST', url: `/api/v1/attachments/${bad.id}/content`, headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/octet-stream', 'content-length': '5' }, payload: 'wrong' })).statusCode).toBe(400);
  expect((await h.api(owner, '/attachments', { conversationId: r.text.conversationId, name: '../secret.txt', size: 1 })).statusCode).toBe(400);
  expect((await h.api(owner, '/attachments', { conversationId: r.text.conversationId, name: 'script.html', size: 1 })).statusCode).toBe(400);
  expect(retentionMs(10 * MiB)).toBe(7 * 86400000); expect(retentionMs(10 * MiB + 1)).toBe(86400000);
  const old = await upload(owner, r.text.conversationId, bytes); await h.db.run('UPDATE attachments SET expires_at=? WHERE id=?', [Date.now() - 1, old]);
  await h.attachments.cleanup(); expect((await h.db.one('SELECT state FROM attachments WHERE id=?', [old]))!.state).toBe('removed');
  await expect(readFile(path.join(h.config.attachmentDir, `${old}.bin`))).rejects.toThrow();
});
it('reserves rolling upload quota atomically and preserves usage after cancellation', async () => {
  const owner = await h.register('quota_owner'), r = await room(owner);
  await h.db.run('INSERT INTO attachment_usage(id,user_id,bytes,created_at) VALUES(?,?,?,?)', [randomUUID(), owner.id, 299 * MiB, Date.now()]);
  const results = await Promise.all([h.api(owner, '/attachments', { conversationId: r.text.conversationId, name: 'first.txt', size: MiB }), h.api(owner, '/attachments', { conversationId: r.text.conversationId, name: 'second.txt', size: MiB })]);
  expect(results.map(r => r.statusCode).sort()).toEqual([200, 429]);
  const successful = results.find(r => r.statusCode === 200)!;
  await h.api(owner, `/attachments/${successful.json().id}`, {}, 'DELETE');
  expect((await h.api(owner, '/uploads/usage')).json().usedBytes).toBe(300 * MiB);
  expect((await h.api(owner, '/attachments', { conversationId: r.text.conversationId, name: 'extra.txt', size: 1 })).statusCode).toBe(429);
});
it('enforces the 512 MiB soft / 1 GiB hard shared tiers atomically across different users', async () => {
  const owner = await h.register('tier_owner'), member = await h.register('tier_member'), r = await room(owner); await h.api(member, '/invites/join', { code: r.invite.code });
  const previous = await h.register('tier_previous'); await h.db.run('INSERT INTO attachment_usage(id,user_id,bytes,created_at) VALUES(?,?,?,?)', [randomUUID(), previous.id, 512 * MiB, Date.now()]);
  expect((await h.api(owner, '/attachments', { conversationId: r.text.conversationId, name: 'large.txt', size: 2 * MiB + 1 })).statusCode).toBe(429);
  const small = await h.api(owner, '/attachments', { conversationId: r.text.conversationId, name: 'small.txt', size: 2 * MiB }); expect(small.statusCode).toBe(200); await h.api(owner, `/attachments/${small.json().id}`, {}, 'DELETE');
  await h.db.run('UPDATE attachment_usage SET bytes=0 WHERE user_id=?', [owner.id]);
  const third = (await h.db.one('SELECT user_id FROM attachment_usage WHERE bytes>? LIMIT 1', [100 * MiB]))!.user_id;
  await h.db.run('UPDATE attachment_usage SET bytes=? WHERE user_id=?', [1023 * MiB, third]);
  const results = await Promise.all([h.api(owner, '/attachments', { conversationId: r.text.conversationId, name: 'last-a.txt', size: MiB }), h.api(member, '/attachments', { conversationId: r.text.conversationId, name: 'last-b.txt', size: MiB })]);
  expect(results.map(r => r.statusCode).sort()).toEqual([200, 429]);
  expect((await h.api(owner, '/uploads/usage')).json().sharedUsedBytes).toBe(1024 * MiB);
});
it('denies cached media tokens after mute, lease removal, kick, epoch replacement and session revocation', async () => {
  h.config.mediaAdmissionSecret = 'private-admission-test-secret-at-least-32'; h.config.livekitKey = 'admission-key'; h.config.livekitSecret = 'private-livekit-test-secret-at-least-32';
  const owner = await h.register('gate_owner'), member = await h.register('gate_member'), r = await room(owner); await h.api(member, '/invites/join', { code: r.invite.code });
  const socket = await h.connect(member); await event(socket, 'voice:join', { channelId: r.voice.id, eligible: true });
  const sfu = new Sfu({ ...h.config, mediaTransport: 'livekit', livekitUrl: 'ws://127.0.0.1:7880' }, h.service);
  const initial = await sfu.credentials(member.id, socket.id!, r.voice.id);
  const admit = (jwt: string, native = false) => h.app.inject({ url: '/internal/media/admission', headers: { 'x-dorham-media-gate': h.config.mediaAdmissionSecret, 'x-forwarded-uri': native ? '/rtc/validate?protocol=13' : `/rtc?access_token=${encodeURIComponent(jwt)}`, ...(native ? { authorization: `Bearer ${jwt}` } : {}) } });
  expect((await h.app.inject({ url: '/internal/media/admission' })).statusCode).toBe(404);
  expect((await admit(initial.token)).statusCode).toBe(200); expect((await admit(initial.token, true)).statusCode).toBe(200);
  expect((await admit(`${initial.token}forged`)).statusCode).toBe(403);
  await h.api(owner, `/voice/${r.voice.id}/moderate`, { userId: member.id, action: 'mute' }); expect((await admit(initial.token)).statusCode).toBe(403);
  const muted = await sfu.credentials(member.id, socket.id!, r.voice.id); expect((await admit(muted.token)).statusCode).toBe(200);
  await h.api(owner, `/voice/${r.voice.id}/moderate`, { userId: member.id, action: 'unmute' });
  await event(socket, 'share:start', { requestId: randomUUID() }); const sharing = await sfu.credentials(member.id, socket.id!, r.voice.id); expect((await admit(sharing.token)).statusCode).toBe(200);
  await event(socket, 'share:stop', { requestId: randomUUID() }); expect((await admit(sharing.token)).statusCode).toBe(403);
  await h.api(owner, `/voice/${r.voice.id}/moderate`, { userId: member.id, action: 'kick' }); expect((await admit(initial.token)).statusCode).toBe(403);
  await event(socket, 'voice:join', { channelId: r.voice.id, eligible: true }); expect((await admit(initial.token)).statusCode).toBe(403);
  const current = await sfu.credentials(member.id, socket.id!, r.voice.id); expect((await admit(current.token)).statusCode).toBe(200);
  const sessions = (await h.api(member, '/auth/sessions')).json().sessions;
  await h.api(member, '/auth/sessions/revoke', { sessionId: sessions[0].id }); expect((await admit(current.token)).statusCode).toBe(403);
});
it('evicts oldest files under storage pressure without touching database/config and reconciles crashed uploads', async () => {
  const owner = await h.register('pressure_owner'), r = await room(owner); h.config.attachmentBudgetMiB = 1;
  const first = await upload(owner, r.text.conversationId, Buffer.alloc(600 * 1024, 'a')); await h.api(owner, '/messages', { conversationId: r.text.conversationId, content: 'Old file', attachmentIds: [first] });
  const sentinel = path.join(h.config.attachmentDir, 'operator-config.txt'); await writeFile(sentinel, 'Do not touch');
  const second = await upload(owner, r.text.conversationId, Buffer.alloc(600 * 1024, 'b')); expect((await h.db.one('SELECT state FROM attachments WHERE id=?', [first]))!.state).toBe('removed');
  expect((await readFile(sentinel, 'utf8'))).toBe('Do not touch'); expect((await h.api(owner, `/attachments/${first}/download`)).statusCode).toBe(410);
  expect((await h.db.one('SELECT state FROM attachments WHERE id=?', [second]))!.state).toBe('ready');
  const orphan = randomUUID(); await writeFile(path.join(h.config.attachmentDir, `${orphan}.part`), 'Partial crash');
  await h.attachments.cleanup(); await expect(readFile(path.join(h.config.attachmentDir, `${orphan}.part`))).rejects.toThrow();
  expect((await h.db.one('PRAGMA integrity_check'))!.integrity_check).toBe('ok');
});
it('renews web sessions with CSRF, lists only owned devices and revokes a single device', async () => {
  const registration = await h.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username: 'web_devices', displayName: 'Web device', password: 'eight888', requestId: randomUUID() } });
  const cookie = registration.cookies.find(c => c.name === 'dorham_session')!, csrf = registration.json().csrf;
  expect(cookie.httpOnly).toBe(true); expect(Number(cookie.maxAge)).toBe(30 * 86400);
  const headers = { cookie: `dorham_session=${cookie.value}`, origin: 'http://localhost:3001', 'x-csrf-token': csrf };
  expect((await h.app.inject({ method: 'POST', url: '/api/v1/auth/renew', headers: { cookie: headers.cookie, origin: headers.origin }, payload: { requestId: randomUUID() } })).statusCode).toBe(403);
  const renewed = await h.app.inject({ method: 'POST', url: '/api/v1/auth/renew', headers, payload: { requestId: randomUUID() } }); expect(renewed.statusCode).toBe(200); expect(renewed.cookies[0].value).not.toBe(cookie.value);
  expect((await h.app.inject({ url: '/api/v1/auth/me', headers: { cookie: headers.cookie } })).statusCode).toBe(401);
  const stranger = await h.register('stranger_device'); expect((await h.api(stranger, '/auth/sessions')).json().sessions).toHaveLength(1);
  const validHeaders = { ...headers, cookie: `dorham_session=${renewed.cookies[0].value}` };
  const devices = await h.app.inject({ url: '/api/v1/auth/sessions', headers: validHeaders }); expect(devices.json().sessions).toHaveLength(1); expect(devices.json().sessions[0].current).toBe(true);
  expect((await h.app.inject({ method: 'POST', url: '/api/v1/auth/sessions/revoke', headers: validHeaders, payload: { requestId: randomUUID(), sessionId: devices.json().sessions[0].id } })).statusCode).toBe(200);
  expect((await h.app.inject({ url: '/api/v1/auth/me', headers: validHeaders })).statusCode).toBe(401);
});
it('applies tag ANY/ALL gates, immediate revocation, lock, room limits and moderation hierarchy', async () => {
  const owner = await h.register('tags_owner'), member = await h.register('tags_member'), r = await room(owner); await h.api(member, '/invites/join', { code: r.invite.code });
  const tagA = (await h.api(owner, `/servers/${r.id}/tags`, { name: 'A', color: '#abcdef' })).json().id, tagB = (await h.api(owner, `/servers/${r.id}/tags`, { name: 'B' })).json().id;
  const policy = (mode: string, locked = false, limit = 16) => h.api(owner, `/voice/${r.voice.id}/policy`, { locked, userLimit: limit, tagMode: mode, requiredTags: [tagA, tagB] }, 'PATCH');
  expect((await policy('ANY')).statusCode).toBe(200); expect((await h.api(member, `/channels/${r.voice.id}`)).statusCode).toBe(403);
  expect((await h.api(member, `/servers/${r.id}/tags`, { tagId: tagA, userId: member.id, assigned: true })).statusCode).toBe(403);
  await h.api(owner, `/servers/${r.id}/tags`, { tagId: tagA, userId: member.id, assigned: true }); expect((await h.api(member, `/channels/${r.voice.id}`)).statusCode).toBe(200);
  await policy('ALL'); expect((await h.api(member, `/channels/${r.voice.id}`)).statusCode).toBe(403);
  await h.api(owner, `/servers/${r.id}/tags`, { tagId: tagB, userId: member.id, assigned: true });
  const socket = await h.connect(member); await event(socket, 'voice:join', { channelId: r.voice.id, eligible: true });
  expect((await h.api(owner, `/voice/${r.voice.id}/moderate`, { userId: member.id, action: 'deafen' })).statusCode).toBe(200);
  expect((await h.db.one('SELECT server_deafened FROM voice_members WHERE user_id=?', [member.id]))!.server_deafened).toBe(1);
  await h.api(owner, `/servers/${r.id}/tags`, { tagId: tagA, userId: member.id, assigned: false }); expect(await h.db.one('SELECT user_id FROM voice_members WHERE user_id=?', [member.id])).toBeUndefined();
  await h.api(owner, `/servers/${r.id}/tags`, { tagId: tagA, userId: member.id, assigned: true }); await policy('ANY', true);
  await expect(event(socket, 'voice:join', { channelId: r.voice.id, eligible: true })).rejects.toThrow('VOICE_LOCKED');
  await policy('ANY', false, 1); const ownerSocket = await h.connect(owner); await event(ownerSocket, 'voice:join', { channelId: r.voice.id, eligible: true });
  await expect(event(socket, 'voice:join', { channelId: r.voice.id, eligible: true })).rejects.toThrow('ROOM_FULL');
  expect((await h.api(member, `/voice/${r.voice.id}/moderate`, { userId: owner.id, action: 'kick' })).statusCode).toBe(403);
});
it('resets an isolated fixture only, retaining server/channel configuration and a fresh protected admin', async () => {
  const owner = await h.register('reset_owner'), r = await room(owner); await h.api(owner, '/messages', { conversationId: r.text.conversationId, content: 'Will be in the backup' });
  expect((await resetPreview(h.db)).counts.users).toBe(1);
  const snapshot = path.join(h.dataDir, 'test-before-reset.sqlite'); await h.db.backup(snapshot); expect((await readFile(snapshot)).length).toBeGreaterThan(0);
  const fresh = await initializeAdministrator(h.db, { username: 'fresh_admin', displayName: 'Fresh admin', password: 'freshpass88' }, true);
  expect((await h.db.one('SELECT owner_id FROM servers WHERE id=?', [r.id]))!.owner_id).toBe(fresh.id);
  expect((await h.db.all('SELECT id FROM channels WHERE server_id=?', [r.id]))).toHaveLength(2);
  expect((await h.db.all('SELECT * FROM users'))).toHaveLength(1); expect((await h.db.all('SELECT * FROM sessions'))).toHaveLength(0); expect((await h.db.all('SELECT * FROM messages'))).toHaveLength(0);
  expect(await h.db.all('PRAGMA foreign_key_check')).toHaveLength(0);
  await expect(initializeAdministrator(h.db, { username: 'another_admin', displayName: 'Other', password: 'freshpass88' })).rejects.toThrow('already exists');
});
it('parses safe links without HTML and clamps all four screen modes to server policy', () => {
  const origin = 'https://dorhamapp.ir', link = channelLink(origin, 'server-1', 'channel-2'); expect(channelTarget(link, origin)).toEqual({ serverId: 'server-1', channelId: 'channel-2' });
  expect(channelTarget(link.replace('dorhamapp.ir', 'attacker.example'), origin)).toBeUndefined();
  const parts = messageParts(`سلام <script>alert(1)</script> javascript:bad https://example.com/x). ${link}`, origin);
  expect(parts.filter(p => p.url)).toHaveLength(2); expect(parts.find(p => p.url?.startsWith('https://example.com'))!.text).toBe('https://example.com/x');
  expect(messageParts('https://name:pass@example.com http://outside.example', origin).some(p => p.url)).toBe(false);
  for (const q of screenQualities) { const s = screenSettings(q, { maxBitrate: 450000, maxFrameRate: 12 }); expect(s.height).toBeLessThanOrEqual(720); expect(s.fps).toBe(12); expect(s.bitrate).toBeLessThanOrEqual(450000); }
});

it('shares the account cap with guests while permitting conversion at capacity', async () => {
  h.config.maxUsers = 2;
  const owner = await h.register('capacity_owner'), r = await room(owner);
  const response = await guest(r.invite.code); expect(response.statusCode).toBe(201);
  expect((await guest(r.invite.code)).statusCode).toBe(409);
  const register = await h.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username: 'over_capacity', displayName: 'Extra', password: 'eight888', requestId: randomUUID() } }); expect(register.statusCode).toBe(409);
  const g = { token: response.json().accessToken };
  expect((await h.api(g, '/auth/upgrade', { username: 'converted_at_cap', displayName: 'Same identity', password: 'eight888' })).statusCode).toBe(200);
  expect((await h.db.one('SELECT COUNT(*) AS count FROM users'))!.count).toBe(2);
});

it('keeps moderator restrictions across rejoin and authorizes room moves', async () => {
  const owner = await h.register('persistent_owner'), member = await h.register('persistent_member'), r = await room(owner);
  await h.api(member, '/invites/join', { code: r.invite.code }); const socket = await h.connect(member);
  await event(socket, 'voice:join', { channelId: r.voice.id, eligible: true });
  for (const action of ['mute', 'deafen', 'denyShare']) expect((await h.api(owner, `/voice/${r.voice.id}/moderate`, { userId: member.id, action })).statusCode).toBe(200);
  await event(socket, 'voice:leave', { requestId: randomUUID() }); await event(socket, 'voice:join', { channelId: r.voice.id, eligible: true });
  const vm = await h.db.one('SELECT * FROM voice_members WHERE user_id=?', [member.id]); expect(vm!.server_muted).toBe(1); expect(vm!.server_deafened).toBe(1);
  await expect(event(socket, 'share:start', { requestId: randomUUID() })).rejects.toThrow('FORBIDDEN');
  const destination = (await h.api(owner, `/servers/${r.id}/channels`, { name: 'Destination', kind: 'voice' })).json();
  const moved = new Promise<any>(resolve => socket.once('voice:move', resolve));
  expect((await h.api(owner, `/voice/${r.voice.id}/move`, { userId: member.id, channelId: destination.id })).statusCode).toBe(200);
  expect((await moved).channelId).toBe(destination.id); expect(await h.db.one('SELECT * FROM voice_members WHERE user_id=?', [member.id])).toBeUndefined();
  await event(socket, 'voice:join', { channelId: destination.id, eligible: true });
  expect((await h.db.one('SELECT channel_id FROM voice_members WHERE user_id=?', [member.id]))!.channel_id).toBe(destination.id);
});
