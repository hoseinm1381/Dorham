import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness } from './helpers';
import { DraftStore } from '../apps/web/src/drafts';
import { createApp } from '../apps/api/src/app';
import { config } from '../apps/api/src/config';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { shareStartSchema, shareUpdateSchema } from '../packages/contracts/src/index';
import { screenSettings } from '../packages/media/src/screen-quality';

it('requires the current sharing protocol and applies a combined screen-media budget', () => {
  expect(shareStartSchema.safeParse({ requestId: randomUUID() }).success).toBe(false);
  expect(shareStartSchema.parse({ requestId: randomUUID(), protocolVersion: 2 }).includeAudio).toBe(false);
  const lease: any = { maxFrameRate: 15, includeAudio: true };
  const audio = screenSettings('720p30', { maxBitrate: 450000, maxFrameRate: 30 }, lease);
  expect(audio.fps).toBe(15); expect(audio.bitrate).toBe(402000); expect(audio.audioBitrate).toBe(48000);
  expect(screenSettings('720p30', { maxBitrate: 450000, maxFrameRate: 30 }, { ...lease, maxFrameRate: 30, includeAudio: false })).toMatchObject({ fps: 30, bitrate: 450000, audioBitrate: 0 });
  expect(shareUpdateSchema.safeParse({ requestId: randomUUID(), leaseId: randomUUID(), expectedRevision: 1, includeAudio: true }).success).toBe(false);
});

it('separates clients behind a trusted proxy and ignores spoofed forwarding from untrusted peers', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dorham-proxy-regression-'));
  const h = await createApp(config({ dataDir: dir, databaseUrl: '', mediaTransport: 'mesh', trustedProxies: ['127.0.0.1/32'] }), { logger: false });
  const attempt = (ip: string, remoteAddress = '127.0.0.1') => h.app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress, headers: { 'x-forwarded-for': ip }, payload: { username: 'absent_' + randomUUID().slice(0, 8), password: 'fixture_password', requestId: randomUUID() } });
  try {
    for (let i = 0; i < 60; i++) expect((await attempt('198.51.100.10')).statusCode).toBe(401);
    expect((await attempt('198.51.100.10')).statusCode).toBe(429);
    expect((await attempt('203.0.113.20')).statusCode).toBe(401);
    for (let i = 0; i < 60; i++) expect((await attempt(`198.51.100.${i}`, '192.0.2.10')).statusCode).toBe(401);
    expect((await attempt('203.0.113.99', '192.0.2.10')).statusCode).toBe(429);
  } finally { await h.app.close(); await rm(dir, { recursive: true, force: true }); }
});

it('loads versioned overrides, rejects legacy/stale saves and preserves a saved denial', async () => {
  const h = await harness();
  try {
    const owner = await h.register('override_owner'), outsider = await h.register('override_other');
    const server = await h.service.createServer(owner.id, randomUUID(), 'Overrides');
    const channel = (await h.service.bootstrap(owner.id)).channels.find(c => c.serverId === server.id && c.kind === 'text')!;
    const first = await h.service.channelOverrides(owner.id, channel.id, 'member'); expect(first).toMatchObject({ revision: 0, permissions: {} });
    await expect(h.service.changeChannel(owner.id, randomUUID(), channel.id, { role: 'member', permissions: {} })).rejects.toMatchObject({ status: 428 });
    await h.service.changeChannel(owner.id, randomUUID(), channel.id, { role: 'member', permissions: { write: false }, expectedRevision: 0 });
    const loaded = await h.service.channelOverrides(owner.id, channel.id, 'member'); expect(loaded).toMatchObject({ revision: 1, permissions: { write: false } });
    await expect(h.service.changeChannel(owner.id, randomUUID(), channel.id, { role: 'member', permissions: {}, expectedRevision: 0 })).rejects.toMatchObject({ status: 409 });
    await h.service.changeChannel(owner.id, randomUUID(), channel.id, { role: 'member', permissions: loaded.permissions, expectedRevision: loaded.revision });
    expect((await h.service.channelOverrides(owner.id, channel.id, 'member')).permissions.write).toBe(false);
    await expect(h.service.channelOverrides(outsider.id, channel.id, 'member')).rejects.toMatchObject({ status: 403 });
    const concurrent = await Promise.allSettled([false, true].map(write => h.service.changeChannel(owner.id, randomUUID(), channel.id, { role: 'moderator', permissions: { write }, expectedRevision: 0 })));
    expect(concurrent.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'STALE_PERMISSIONS' } });
  } finally { await h.close(); }
});

it('allocates three standard shares and one room-first fallback; promotes without forcing 30fps', async () => {
  const h = await harness({ mediaTransport: 'mesh', roomShares: 0, globalShares: 0 });
  try {
    const people: Awaited<ReturnType<typeof h.register>>[] = []; for (let i = 0; i < 7; i++) people.push(await h.register(`tier_member_${i}`));
    const owner = people[0], server = await h.service.createServer(owner.id, randomUUID(), 'Share allocation');
    const invite = await h.service.invite(owner.id, randomUUID(), server.id, 'tier_invite_code_for_test', 24, 20);
    for (const person of people.slice(1)) await h.service.joinInvite(person.id, randomUUID(), invite.code);
    const a = (await h.service.bootstrap(owner.id)).channels.find(c => c.serverId === server.id && c.kind === 'voice')!;
    const b = await h.service.createChannel(owner.id, randomUUID(), server.id, 'Other room', 'voice');
    const c = await h.service.createChannel(owner.id, randomUUID(), server.id, 'Third room', 'voice');
    for (let i = 0; i < people.length; i++) await h.service.joinVoice(people[i].id, `socket-${i}`, i < 4 ? a.id : i < 6 ? b.id : c.id, true);
    const start = (i: number) => h.service.share(people[i].id, `socket-${i}`, randomUUID());
    const standard = await Promise.all([start(0), start(1), start(2)]);
    expect(standard.every(r => r.lease?.tier === 'standard' && r.lease.requestedFrameRate === 15)).toBe(true);
    await expect(start(3)).rejects.toMatchObject({ code: 'SHARE_LIMIT' });
    const fallback = await start(4); expect(fallback.lease).toMatchObject({ tier: 'fallback', maxFrameRate: 15 });
    await expect(start(5)).rejects.toMatchObject({ code: 'SHARE_LIMIT' });
    await new Promise(r => setTimeout(r, 2)); const later = await start(6);
    await expect(h.service.updateShare(people[4].id, 'socket-4', randomUUID(), { leaseId: fallback.lease!.id, expectedRevision: fallback.lease!.policyRevision!, frameRate: 30 })).rejects.toMatchObject({ code: 'SHARE_TIER' });
    await h.service.share(people[0].id, 'socket-0', randomUUID(), true);
    const promoted = (await h.service.room(people[4].id, b.id)).shares[0]; expect(promoted).toMatchObject({ tier: 'standard', maxFrameRate: 30, requestedFrameRate: 15 });
    const updated = await h.service.updateShare(people[4].id, 'socket-4', randomUUID(), { leaseId: promoted.id, expectedRevision: promoted.policyRevision!, frameRate: 30 }); expect(updated.lease.requestedFrameRate).toBe(30);
    expect((await h.service.room(people[6].id, c.id)).shares[0].id).toBe(later.lease!.id);
    expect((await h.db.one("SELECT COUNT(*) AS count FROM share_leases WHERE tier='standard'"))!.count).toBe(3);
    await h.db.run('UPDATE share_leases SET expires_at=? WHERE id=?', [Date.now() - 1, standard[1].lease!.id]);
    await h.service.room(people[6].id, c.id);
    expect((await h.service.room(people[6].id, c.id)).shares[0]).toMatchObject({ tier: 'standard', requestedFrameRate: 15 });
  } finally { await h.close(); }
});

it('persists bounded drafts without quoted history, expires them and clears only the signed-out account', () => {
  const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) || null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } };
  const store = new DraftStore(storage), key = store.key('person', 'https://fixture', 'conversation');
  store.set(key, { ...store.get(key), text: 'A persistent draft', reply: { id: 'quoted-id', content: 'Private quoted history must not be persisted' } as any }); store.flush();
  expect([...values.values()].join('')).not.toContain('Private quoted history');
  const restored = new DraftStore(storage); expect(restored.get(key).text).toBe('A persistent draft'); expect(restored.get(key).reply?.id).toBe('quoted-id');
  const other = restored.key('someone-else', 'https://fixture', 'conversation'); restored.set(other, { ...restored.get(other), text: 'Other account' }); restored.clear('person', 'https://fixture');
  expect(new DraftStore(storage).get(key).text).toBe(''); expect(new DraftStore(storage).get(other).text).toBe('Other account');
  values.set('dorham-drafts-v1', JSON.stringify([[key, { text: 'Expired text', updatedAt: Date.now() - 8 * 86400000 }]])); expect(new DraftStore(storage).get(key).text).toBe('');
  for (let i = 0; i < 200; i++) restored.set(restored.key('person', 'https://fixture', `cv-${i}`), { ...restored.get(key), text: 'ا'.repeat(4000) }); restored.flush();
  expect(new TextEncoder().encode([...values.values()].join('')).length).toBeLessThanOrEqual(1048576);
});
