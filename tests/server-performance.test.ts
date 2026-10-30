import { it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, event } from './helpers';
import { Sfu } from '../apps/api/src/sfu';

it('keeps heartbeat work local, skips SFU RPCs for PTT, and retains enforced topology changes', async () => {
  const synchronize = vi.spyOn(Sfu.prototype, 'synchronize').mockResolvedValue(undefined);
  const h = await harness({ mediaTransport: 'livekit', livekitUrl: 'ws://127.0.0.1:7880', livekitKey: 'fixture', livekitSecret: 'isolated-test-secret-not-real' });
  try {
    const owner = await h.register('perfowner'); await h.api(owner, '/servers', { name: 'Performance' });
    const channel = (await h.api(owner, '/bootstrap')).json().channels.find((c: any) => c.kind === 'voice');
    const socket = await h.connect(owner); await event(socket, 'voice:join', { channelId: channel.id, eligible: true });
    const lease = (await event(socket, 'share:start', { requestId: randomUUID() })).lease;
    const queries: string[] = [], transaction = h.db.transaction.bind(h.db);
    h.db.transaction = work => transaction(tx => work({ ...tx, run: async (q, p) => { queries.push(q); await tx.run(q, p); } }));
    synchronize.mockClear();
    expect(await event(socket, 'voice:heartbeat', { eligible: true })).toEqual({ alive: true });
    expect(queries.some(q => /^DELETE FROM/.test(q))).toBe(false);
    expect((await h.db.one('SELECT expires_at FROM share_leases WHERE id=?', [lease.id]))!.expires_at).toBeGreaterThan(Date.now());
    const room = new Promise<any>(resolve => socket.once('voice:room', resolve));
    await event(socket, 'voice:state', { muted: true, deafened: false, requestId: randomUUID() });
    expect((await room).members[0].muted).toBe(true); expect(synchronize).not.toHaveBeenCalled();
    const notifications = vi.fn(); socket.on('voice:room', notifications);
    await event(socket, 'voice:state', { muted: true, deafened: false, requestId: randomUUID() });
    expect(notifications).not.toHaveBeenCalled();
    await event(socket, 'share:stop', { requestId: randomUUID() }); expect(synchronize).toHaveBeenCalled();
    // Expiry and coordinator fencing remain active on the existing maintenance path.
    await h.db.run('UPDATE voice_members SET heartbeat=0'); await h.service.cleanup();
    expect(await h.db.one('SELECT user_id FROM voice_members')).toBeUndefined();
    expect((await h.db.one('SELECT user_id FROM coordinators WHERE channel_id=?', [channel.id]))!.user_id).toBeNull();
  } finally { await h.close(); synchronize.mockRestore(); }
});

it('fresh batched audiences never leak hidden channels, DMs, bans, or revoked permissions', async () => {
  const h = await harness();
  try {
    const owner = await h.register('audowner'), member = await h.register('audmember'), outsider = await h.register('audoutsider');
    const server = (await h.api(owner, '/servers', { name: 'Audience' })).json();
    const invite = (await h.api(owner, `/servers/${server.id}/invites`, {})).json(); await h.api(member, '/invites/join', { code: invite.code });
    const channel = (await h.api(owner, '/bootstrap')).json().channels.find((c: any) => c.kind === 'text');
    const viewers = [{ socketId: 'owner', userId: owner.id }, { socketId: 'member-a', userId: member.id }, { socketId: 'member-b', userId: member.id }, { socketId: 'outsider', userId: outsider.id }];
    expect(await h.service.conversationAudience(viewers, channel.conversationId)).toEqual(['owner', 'member-a', 'member-b']);
    await h.api(owner, `/channels/${channel.id}`, { role: 'member', permissions: { view: false } }, 'PATCH');
    expect(await h.service.conversationAudience(viewers, channel.conversationId)).toEqual(['owner']);
    await expect(h.service.conversationAudience(viewers, channel.conversationId, member.id)).rejects.toMatchObject({ status: 403 });
    const dm = (await h.api(owner, '/dms', { userId: member.id })).json();
    expect(await h.service.conversationAudience(viewers, dm.id)).toEqual(['owner', 'member-a', 'member-b']);
    await h.db.run('UPDATE users SET banned=1 WHERE id=?', [member.id]);
    expect(await h.service.conversationAudience(viewers, dm.id)).toEqual(['owner']);
  } finally { await h.close(); }
});
