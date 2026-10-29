import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { harness } from './helpers';
import { mediaMime, byteRange } from '../apps/api/src/attachment-media';
import { VoiceMembershipCues } from '../packages/contracts/src/voice-notifications';
let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => { h = await harness(); }); afterEach(async () => { await h.close(); });
async function fixture(name = 'sample.png', bytes?: Buffer) {
  const owner = await h.register('media_owner'), peer = await h.register('media_peer'), outsider = await h.register('media_outsider');
  const dm = (await h.api(owner, '/dms', { userId: peer.id })).json();
  bytes ||= await sharp({ create: { width: 32, height: 24, channels: 3, background: '#46b8b0' } }).png().toBuffer();
  const reserved = await h.api(owner, '/attachments', { conversationId: dm.id, name, size: bytes.length }), id = reserved.json().id;
  expect(reserved.statusCode).toBe(200);
  expect((await h.app.inject({ method: 'POST', url: `/api/v1/attachments/${id}/content`, headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) }, payload: bytes })).statusCode).toBe(200);
  const message = (await h.api(owner, '/messages', { conversationId: dm.id, content: '', attachmentIds: [id] })).json().payload;
  return { owner, peer, outsider, dm, bytes, id, message };
}
it('streams existing image attachments inline with MIME validation and no public download bypass', async () => {
  const f = await fixture(), route = `/attachments/${f.id}`;
  expect((await h.api(f.outsider, `${route}/preview`, {})).statusCode).toBe(403);
  const preview = (await h.api(f.peer, `${route}/preview`, {})).json(); expect(preview.path).toMatch(/media_ticket=/);
  const response = await h.app.inject({ url: preview.path }); expect(response.statusCode, response.body).toBe(200); expect(response.rawPayload).toEqual(f.bytes);
  expect(response.headers).toMatchObject({ 'content-type': 'image/png', 'content-disposition': 'inline', 'accept-ranges': 'bytes', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
  expect((await h.app.inject({ url: `/api/v1${route}/media` })).statusCode).toBe(401);
  expect((await h.app.inject({ url: preview.path.replace(f.id, randomUUID()) })).statusCode).toBe(401);
  expect((await h.app.inject({ url: `/api/v1/bootstrap?media_ticket=${new URL('http://local' + preview.path).searchParams.get('media_ticket')}` })).statusCode).toBe(401);
  expect((await h.api(f.owner, `${route}/download`)).headers['content-disposition']).toMatch(/^attachment;/);
});
it('supports bounded single-range, suffix, HEAD and invalid range responses for seekable media', async () => {
  const f = await fixture(), preview = (await h.api(f.peer, `/attachments/${f.id}/preview`, {})).json();
  const range = await h.app.inject({ url: preview.path, headers: { range: 'bytes=4-19' } }); expect(range.statusCode).toBe(206); expect(range.rawPayload).toEqual(f.bytes.subarray(4, 20)); expect(range.headers['content-range']).toBe(`bytes 4-19/${f.bytes.length}`);
  const suffix = await h.app.inject({ url: preview.path, headers: { range: 'bytes=-8' } }); expect(suffix.rawPayload).toEqual(f.bytes.subarray(-8));
  const head = await h.app.inject({ method: 'HEAD', url: preview.path }); expect(head.statusCode).toBe(200); expect(head.body).toBe(''); expect(head.headers['content-length']).toBe(String(f.bytes.length));
  for (const range of ['bytes=1-2,4-5', 'bytes=-0', 'bytes=99999-', 'bytes=20-2', 'no']) { const response = await h.app.inject({ url: preview.path, headers: { range } }); expect(response.statusCode, range).toBe(416); expect(response.headers['content-range']).toBe(`bytes */${f.bytes.length}`); }
  expect(byteRange('bytes=2-', 8)).toEqual({ start: 2, end: 7 });
});
it('rechecks session revocation, membership, deletion, expiry and byte integrity on previews', async () => {
  const f = await fixture(), preview = (await h.api(f.peer, `/attachments/${f.id}/preview`, {})).json();
  const session = await h.db.one('SELECT id FROM sessions WHERE user_id=?', [f.peer.id]); await h.db.run('DELETE FROM sessions WHERE id=?', [session!.id]); expect((await h.app.inject({ url: preview.path })).statusCode).toBe(401);
  const valid = (await h.api(f.owner, `/attachments/${f.id}/preview`, {})).json();
  await writeFile(path.join(h.config.attachmentDir, `${f.id}.bin`), Buffer.alloc(f.bytes.length, 9)); expect((await h.app.inject({ url: valid.path })).statusCode).toBe(410);
  await writeFile(path.join(h.config.attachmentDir, `${f.id}.bin`), f.bytes);
  await h.db.run('UPDATE attachments SET expires_at=0 WHERE id=?', [f.id]); expect((await h.app.inject({ url: valid.path })).statusCode).toBe(410);
  await h.db.run('UPDATE attachments SET expires_at=? WHERE id=?', [Date.now() + 60000, f.id]); await h.api(f.owner, `/messages/${f.message.id}`, { delete: true }, 'PATCH'); expect((await h.app.inject({ url: valid.path })).statusCode).toBe(410);
});
it('rejects executable or mismatched inline content while preserving ordinary downloads', async () => {
  const f = await fixture('pretend.mp4', Buffer.from('<html>not video data</html>')), preview = (await h.api(f.owner, `/attachments/${f.id}/preview`, {})).json();
  expect((await h.app.inject({ url: preview.path })).statusCode).toBe(415); expect((await h.api(f.peer, `/attachments/${f.id}/download`)).statusCode).toBe(200);
  expect(mediaMime('script.svg', Buffer.from('<svg/>'))).toBeNull(); expect(mediaMime('renamed.webp', Buffer.from('not RIFFxxxxWEBP'))).toBeNull();
  expect(mediaMime('clip.mp4', Buffer.from('0000ftypisom'))).toBe('video/mp4');
});
it('detects peer leave cues exactly once from authoritative directory changes, independently of transport room updates', () => {
  const cues = new VoiceMembershipCues(), room = (ids: string[]) => [{ channelId: 'room', members: ids.map(id => ({ user: { id } })) }];
  expect(cues.transition('room', ['self'])).toEqual(['join']); expect(cues.directory(room(['self', 'peer']), 'self')).toEqual(['join']);
  expect(cues.transition('room', ['self', 'peer'])).toEqual([]); expect(cues.directory(room(['self']), 'self')).toEqual(['leave']); expect(cues.directory(room(['self']), 'self')).toEqual([]);
  expect(cues.transition('room', ['self', 'peer'])).toEqual([]); expect(cues.directory(room(['self']), 'self')).toEqual([]);
  expect(cues.directory([], 'self')).toEqual([]); expect(cues.transition(null)).toEqual(['leave']); expect(cues.transition(null)).toEqual([]);
});

it('expires and bounds preview tickets and rejects fresh ranges after channel access is removed', async () => {
  const f = await fixture(), server = (await h.api(f.owner, '/servers', { name: 'Private preview' })).json(), invite = (await h.api(f.owner, `/servers/${server.id}/invites`, {})).json(); await h.api(f.peer, '/invites/join', { code: invite.code });
  const text = (await h.api(f.owner, '/bootstrap')).json().channels.find((c: any) => c.serverId === server.id && c.kind === 'text');
  await h.db.run('UPDATE attachments SET conversation_id=? WHERE id=?', [text.conversationId, f.id]);
  const old = (await h.api(f.peer, `/attachments/${f.id}/preview`, {})).json();
  for (let n = 0; n < 32; n++) await h.api(f.peer, `/attachments/${f.id}/preview`, {});
  expect((await h.app.inject({ url: old.path })).statusCode).toBe(401);
  const fresh = (await h.api(f.peer, `/attachments/${f.id}/preview`, {})).json(); expect((await h.app.inject({ url: fresh.path, headers: { range: 'bytes=0-4' } })).statusCode).toBe(206);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60000);
  try { expect((await h.app.inject({ url: fresh.path })).statusCode).toBe(401); } finally { clock.mockRestore(); }
  await h.api(f.owner, `/servers/${server.id}/members/${f.peer.id}`, { remove: true }, 'PATCH'); expect((await h.app.inject({ url: fresh.path, headers: { range: 'bytes=0-4' } })).statusCode).toBe(403);
});
