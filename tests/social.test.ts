import { beforeEach, afterEach, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolveCustomPermissions } from '@dorham/contracts';
import { harness, event } from './helpers';
let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => { h = await harness(); }); afterEach(async () => { await h.close(); });
async function setup() {
  const owner = await h.register('role_owner'), member = await h.register('role_member'), outsider = await h.register('role_outsider');
  const server = (await h.api(owner, '/servers', { name: 'Role lab' })).json(), invite = (await h.api(owner, `/servers/${server.id}/invites`, {})).json();
  await h.api(member, '/invites/join', { code: invite.code });
  const snapshot = (await h.api(owner, '/bootstrap')).json();
  return { owner, member, outsider, server, invite, text: snapshot.channels.find((c: any) => c.serverId === server.id && c.kind === 'text'), voice: snapshot.channels.find((c: any) => c.serverId === server.id && c.kind === 'voice') };
}
it('applies custom-role denies, allows, channel overrides and protected ownership deterministically', () => {
  expect(resolveCustomPermissions('member', [{ speak: true, moderate: true }, { speak: false }])).toMatchObject({ speak: false, moderate: true, manageMembers: false });
  expect(resolveCustomPermissions('member', [{ speak: false }], { speak: true }).speak).toBe(true);
  expect(resolveCustomPermissions('owner', [{ view: false, speak: false }], { write: false })).toMatchObject({ view: true, speak: true, write: true });
});
it('keeps invite links across sessions, limits who can read them, and revokes them idempotently', async () => {
  const { owner, member, outsider, server } = await setup();
  expect((await h.api(member, `/servers/${server.id}/invites`)).statusCode).toBe(403);
  expect((await h.api(outsider, `/servers/${server.id}/invites`)).statusCode).toBe(403);
  const rid = randomUUID(), first = await h.api(owner, `/servers/${server.id}/invites`, { requestId: rid, hours: 168, uses: 3 });
  expect((await h.api(owner, `/servers/${server.id}/invites`, { requestId: rid, hours: 168, uses: 3 })).json()).toEqual(first.json());
  const current = (await h.api(owner, `/servers/${server.id}/invites`)).json().invites.find((i: any) => i.code === first.json().code);
  expect(current.remaining).toBe(3); expect(current.expiresAt).toBeGreaterThan(Date.now() + 6 * 86400000);
  const body = { requestId: randomUUID() };
  for (let i = 0; i < 2; i++) expect((await h.api(owner, `/servers/${server.id}/invites/${first.json().code}`, body, 'DELETE')).statusCode).toBe(200);
  expect((await h.api(outsider, '/invites/join', { code: first.json().code })).statusCode).toBe(404);
});
it('creates and assigns functional server roles without cross-server or global privilege escalation', async () => {
  const { owner, member, outsider, server, text } = await setup();
  const route = `/servers/${server.id}/roles`, body = { name: 'Helpers', color: '#56aaff', permissions: { moderate: true, manageChannels: true, manageMembers: true, createInvites: true, write: false } };
  expect((await h.api(member, route, body)).statusCode).toBe(403);
  expect((await h.api(owner, route, { ...body, permissions: { instanceAdmin: true } })).statusCode).toBe(400);
  const role = (await h.api(owner, route, body)).json();
  expect((await h.api(owner, route, { roleId: role.id, userId: member.id, assigned: true })).statusCode).toBe(200);
  expect((await h.api(member, `/channels/${text.id}`)).json().permissions).toMatchObject({ write: false, moderate: true, manageChannels: true });
  expect((await h.api(member, '/messages', { conversationId: text.conversationId, content: 'denied' })).statusCode).toBe(403);
  expect((await h.api(member, `/servers/${server.id}/channels`, { name: 'Helper room', kind: 'text' })).statusCode).toBe(200);
  expect((await h.api(member, `/servers/${server.id}/invites`, {})).statusCode).toBe(200);
  expect((await h.api(member, route, { ...body, name: 'Escalation' })).statusCode).toBe(403);
  expect((await h.api(member, `/servers/${server.id}/members/${owner.id}`, { remove: true }, 'PATCH')).statusCode).toBe(403);
  expect((await h.api(member, `/servers/${server.id}/members/${member.id}`, { role: 'administrator' }, 'PATCH')).statusCode).toBe(403);
  expect((await h.api(member, '/auth/me')).json().user.instanceAdmin).toBe(false);
  const other = (await h.api(outsider, '/servers', { name: 'Elsewhere' })).json();
  expect((await h.api(outsider, `/servers/${other.id}/roles`, { roleId: role.id, delete: true })).statusCode).toBe(404);
  expect((await h.api(owner, route, { roleId: role.id, userId: outsider.id, assigned: true })).statusCode).toBe(403);
  expect((await h.api(owner, `/servers/${server.id}/members`)).json().find((m: any) => m.user.id === member.id).customRoles[0].name).toBe('Helpers');
  expect((await h.api(owner, route, { roleId: role.id, delete: true })).statusCode).toBe(200);
  expect((await h.api(member, `/channels/${text.id}`)).json().permissions).toMatchObject({ write: true, moderate: false, manageChannels: false });
  expect(await h.db.all('SELECT * FROM member_roles')).toHaveLength(0);
});
it('revokes active voice publication immediately on role changes and restores only non-moderator denials', async () => {
  const { owner, member, server, voice } = await setup(), socket = await h.connect(member);
  const joined = await event<any>(socket, 'voice:join', { channelId: voice.id, eligible: true });
  await event(socket, 'share:start', { requestId: randomUUID() });
  const route = `/servers/${server.id}/roles`, role = (await h.api(owner, route, { name: 'Listener', color: '#aabbcc', permissions: { speak: false, share: false } })).json();
  await h.api(owner, route, { roleId: role.id, userId: member.id, assigned: true });
  expect((await h.db.one('SELECT server_muted FROM voice_members WHERE user_id=?', [member.id]))!.server_muted).toBe(1);
  expect(await h.db.one('SELECT id FROM share_leases WHERE user_id=?', [member.id])).toBeUndefined();
  await h.api(owner, route, { roleId: role.id, userId: member.id, assigned: false });
  expect((await h.db.one('SELECT server_muted FROM voice_members WHERE user_id=?', [member.id]))!.server_muted).toBe(0);
  await h.api(owner, `/voice/${voice.id}/moderate`, { userId: member.id, action: 'mute' });
  await h.api(owner, route, { roleId: role.id, userId: member.id, assigned: true });
  await h.api(owner, route, { roleId: role.id, userId: member.id, assigned: false });
  expect((await h.db.one('SELECT server_muted FROM voice_members WHERE user_id=?', [member.id]))!.server_muted).toBe(1);
  const same = await event<any>(socket, 'voice:join', { channelId: voice.id, eligible: true }); expect(same.epoch).toBe(joined.epoch);
  await h.api(owner, route, { roleId: role.id, name: 'Hidden', color: '#aabbcc', permissions: { view: false } });
  await h.api(owner, route, { roleId: role.id, userId: member.id, assigned: true });
  expect(await h.db.one('SELECT user_id FROM voice_members WHERE user_id=?', [member.id])).toBeUndefined();
  expect((await h.api(member, '/bootstrap')).json().channels).toEqual([]);
});
it('persists profile changes and exposes fresh identity in message history and live rosters', async () => {
  const { owner, member, server, text, voice } = await setup(), socket = await h.connect(member), observer = await h.connect(owner);
  await event(socket, 'voice:join', { channelId: voice.id, eligible: true });
  await h.api(member, '/messages', { conversationId: text.conversationId, content: 'before change' });
  const update = new Promise<any>(resolve => observer.on('voice:directory', rows => { if (rows[0]?.members.some((m: any) => m.user.displayName === 'Updated name')) resolve(rows); }));
  const result = await h.api(member, '/profile', { displayName: 'Updated name', bio: 'Saved biography', status: 'idle' }, 'PATCH'); expect(result.statusCode, result.body).toBe(200);
  await update;
  expect((await h.api(member, '/auth/me')).json().user).toMatchObject({ displayName: 'Updated name', bio: 'Saved biography', status: 'idle' });
  expect((await h.api(owner, `/servers/${server.id}/members`)).json().find((m: any) => m.user.id === member.id).user.displayName).toBe('Updated name');
  expect((await h.api(owner, `/conversations/${text.conversationId}/messages`)).json().messages[0].author.displayName).toBe('Updated name');
});

it('closes only the caller DM, preserves history, and reopens on a new permitted message', async () => {
  const a = await h.register('close_alice'), b = await h.register('close_bravo'), c = await h.register('close_outsider');
  const dm = (await h.api(a, '/dms', { userId: b.id })).json(); await h.api(a, '/messages', { conversationId: dm.id, content: 'Keep this history' });
  expect((await h.api(c, `/dms/${dm.id}/close`, {})).statusCode).toBe(403);
  const rid = randomUUID(); for (let i = 0; i < 2; i++) expect((await h.api(a, `/dms/${dm.id}/close`, { requestId: rid })).statusCode).toBe(200);
  expect((await h.api(a, '/bootstrap')).json().dms).toHaveLength(0); expect((await h.api(b, '/bootstrap')).json().dms).toHaveLength(1);
  expect((await h.api(a, `/conversations/${dm.id}/messages`)).json().messages[0].content).toBe('Keep this history');
  await h.api(b, '/messages', { conversationId: dm.id, content: 'A fresh message reopens it' }); expect((await h.api(a, '/bootstrap')).json().dms).toHaveLength(1);
  await h.api(a, `/dms/${dm.id}/close`, {}); expect((await h.api(a, '/dms', { userId: b.id })).json().id).toBe(dm.id);
});
it('blocks new DMs, socket sends and typing in both directions until each relevant block is removed', async () => {
  const a = await h.register('block_alice'), b = await h.register('block_bravo'); const dm = (await h.api(a, '/dms', { userId: b.id })).json();
  await h.api(a, '/messages', { conversationId: dm.id, content: 'Old history' });
  const socket = await h.connect(b); expect((await h.api(a, `/users/${a.id}/block`, { blocked: true })).statusCode).toBe(400);
  expect((await h.api(a, `/users/${b.id}/block`, { blocked: true })).statusCode).toBe(200);
  for (const user of [a, b]) { expect((await h.api(user, '/messages', { conversationId: dm.id, content: 'denied' })).statusCode).toBe(403); expect((await h.api(user, '/dms', { userId: user.id === a.id ? b.id : a.id })).statusCode).toBe(403); }
  await expect(event(socket, 'message:send', { conversationId: dm.id, content: 'socket denied', requestId: randomUUID() })).rejects.toThrow('DM_BLOCKED');
  await expect(event(socket, 'typing', { conversationId: dm.id, active: true })).rejects.toThrow('DM_BLOCKED');
  expect((await h.api(a, '/bootstrap')).json()).toMatchObject({ blockedUsers: [{ id: b.id }], dms: [{ blocked: true, blockedByMe: true }] });
  expect((await h.api(b, '/bootstrap')).json().dms[0]).toMatchObject({ blocked: true, blockedByMe: false });
  expect((await h.api(b, `/conversations/${dm.id}/messages`)).json().messages).toHaveLength(1);
  await h.api(b, `/users/${a.id}/block`, { blocked: true }); await h.api(a, `/users/${b.id}/block`, { blocked: false }); expect((await h.api(a, '/messages', { conversationId: dm.id, content: 'still denied' })).statusCode).toBe(403);
  await h.api(b, `/users/${a.id}/block`, { blocked: false }); expect((await h.api(a, '/messages', { conversationId: dm.id, content: 'Allowed again' })).statusCode).toBe(200);
});
it('leaves a server with voice and role cleanup, preserves its history, and requires an invite to rejoin', async () => {
  const { owner, member, outsider, server, text, voice } = await setup(), socket = await h.connect(member);
  const role = (await h.api(owner, `/servers/${server.id}/roles`, { name: 'Leaving role', color: '#aabbcc', permissions: { createInvites: true } })).json(); await h.api(owner, `/servers/${server.id}/roles`, { roleId: role.id, userId: member.id, assigned: true });
  await h.api(member, '/messages', { conversationId: text.conversationId, content: 'Retain after leaving' }); await event(socket, 'voice:join', { channelId: voice.id, eligible: true }); await event(socket, 'share:start', { requestId: randomUUID() });
  expect((await h.api(owner, `/servers/${server.id}/leave`, {})).statusCode).toBe(403); expect((await h.api(outsider, `/servers/${server.id}/leave`, {})).statusCode).toBe(404);
  const requestId = randomUUID(); for (let i = 0; i < 2; i++) expect((await h.api(member, `/servers/${server.id}/leave`, { requestId })).statusCode).toBe(200);
  expect((await h.api(member, '/bootstrap')).json().servers).toEqual([]); expect(await h.db.all('SELECT * FROM member_roles WHERE user_id=?', [member.id])).toEqual([]); expect(await h.db.one('SELECT * FROM voice_members WHERE user_id=?', [member.id])).toBeUndefined(); expect(await h.db.one('SELECT * FROM share_leases WHERE user_id=?', [member.id])).toBeUndefined();
  expect((await h.api(member, `/conversations/${text.conversationId}/messages`)).statusCode).toBe(403); expect((await h.api(owner, `/conversations/${text.conversationId}/messages`)).json().messages[0].content).toBe('Retain after leaving');
  const invite = (await h.api(owner, `/servers/${server.id}/invites`, {})).json(); await h.api(member, '/invites/join', { code: invite.code }); expect((await h.api(member, '/bootstrap')).json().servers[0].permissions.createInvites).toBe(false);
});
