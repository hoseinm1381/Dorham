import { it, expect } from 'vitest';
import { harness } from './helpers';

it('lets members and guests invite by default while scoping ordinary members to their own links', async () => {
  const h = await harness();
  try {
    const owner = await h.register('invite_owner'), member = await h.register('invite_member'), outsider = await h.register('invite_outsider');
    const server = (await h.api(owner, '/servers', { name: 'Member invitations' })).json(), route = `/servers/${server.id}/invites`;
    const ownerLink = (await h.api(owner, route, { uses: 10 })).json();
    await h.api(member, '/invites/join', { code: ownerLink.code });
    const bootstrap = (await h.api(member, '/bootstrap')).json().servers[0];
    expect(bootstrap.allowMemberInvites).toBe(true); expect(bootstrap.permissions.createInvites).toBe(true);
    const response = await h.api(member, route, { uses: 3 }); expect(response.statusCode).toBe(200); const link = response.json();
    expect((await h.api(member, route)).json().invites.map((i: any) => i.code)).toEqual([link.code]);
    expect((await h.api(member, `${route}/${ownerLink.code}`, {}, 'DELETE')).statusCode).toBe(403);
    expect((await h.api(outsider, route, {})).statusCode).toBe(403);
    const guestResponse = await h.app.inject({ method: 'POST', url: '/api/v1/auth/guest', headers: { 'x-dorham-native': '1' }, payload: { code: link.code, displayName: 'Invited guest', requestId: crypto.randomUUID() } });
    expect(guestResponse.statusCode).toBe(201); const guest = { token: guestResponse.json().accessToken };
    expect((await h.api(guest, route, {})).statusCode).toBe(200);
    expect((await h.api(guest, `/servers/${server.id}`, { allowMemberInvites: false }, 'PATCH')).statusCode).toBe(403);
    expect((await h.api(owner, route)).json().invites).toHaveLength(3);
    expect((await h.api(owner, `${route}/${link.code}`, {}, 'DELETE')).statusCode).toBe(200);
    expect((await h.api(member, route)).json().invites).toEqual([]);
  } finally { await h.close(); }
});

it('makes the owner switch authoritative over grants and preserves explicit role denies', async () => {
  const h = await harness();
  try {
    const owner = await h.register('policy_owner'), member = await h.register('policy_member'), admin = await h.register('policy_admin');
    const server = (await h.api(owner, '/servers', { name: 'Invite policy' })).json(), route = `/servers/${server.id}`, invites = route + '/invites';
    const link = (await h.api(owner, invites, {})).json();
    for (const user of [member, admin]) await h.api(user, '/invites/join', { code: link.code });
    await h.api(owner, `${route}/members/${admin.id}`, { role: 'administrator' }, 'PATCH');
    expect((await h.api(admin, route, { allowMemberInvites: false }, 'PATCH')).statusCode).toBe(403);
    const role = (await h.api(owner, route + '/roles', { name: 'Explicit invite grant', color: '#55aabb', permissions: { createInvites: true } })).json();
    await h.api(owner, route + '/roles', { roleId: role.id, userId: member.id, assigned: true });
    expect((await h.api(owner, route, { allowMemberInvites: false }, 'PATCH')).statusCode).toBe(200);
    for (const user of [member, admin]) {
      expect((await h.api(user, invites, {})).statusCode).toBe(403);
      const snapshot = (await h.api(user, '/bootstrap')).json(); expect(snapshot.servers[0].permissions.createInvites).toBe(false);
      expect(snapshot.channels.every((c: any) => c.permissions.createInvites === false)).toBe(true);
    }
    expect((await h.api(owner, invites, {})).statusCode).toBe(200);
    expect((await h.api(member, '/invites/join', { code: link.code })).statusCode).toBe(200);
    await h.api(owner, route, { allowMemberInvites: true }, 'PATCH');
    expect((await h.api(member, invites, {})).statusCode).toBe(200);
    await h.api(owner, route + '/roles', { roleId: role.id, name: 'Explicit invite deny', color: '#55aabb', permissions: { createInvites: false } });
    expect((await h.api(member, invites, {})).statusCode).toBe(403);
  } finally { await h.close(); }
});
