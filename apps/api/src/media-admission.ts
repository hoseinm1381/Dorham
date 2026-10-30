import type { FastifyInstance } from 'fastify';
import { TokenVerifier, TrackSource } from 'livekit-server-sdk';
import type { Service } from './service';
import { equal, fail } from './security';

// Run via the trusted signaling proxy for BOTH the WebSocket handshake and
// /rtc/validate. Self-hosted LiveKit's cached/refreshed JWTs are not revocable.
// Never log the JWT or the forwarded URI (which can contain access_token).
export function mediaAdmission(app: FastifyInstance, service: Service, sessionForSocket: (socketId: string) => string | undefined) {
  const { c, db } = service;
  app.get('/internal/media/admission', async req => {
    if (!c.mediaAdmissionSecret || !equal(String(req.headers['x-dorham-media-gate'] || ''), c.mediaAdmissionSecret)) fail(404, 'NOT_FOUND', 'Not found.');
    let uri: URL;
    try { uri = new URL(String(req.headers['x-forwarded-uri'] || ''), 'http://internal.invalid'); } catch { fail(403, 'FORBIDDEN', 'Media admission denied.'); }
    if (!/^\/rtc(?:\/|$)/.test(uri!.pathname)) fail(403, 'FORBIDDEN', 'Media admission denied.');
    const raw = uri!.searchParams.get('access_token') || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '');
    if (!raw || raw.length > 8192) fail(403, 'FORBIDDEN', 'Media admission denied.');
    let claims;
    try { claims = await new TokenVerifier(c.livekitKey, c.livekitSecret).verify(raw, 0); } catch { fail(403, 'FORBIDDEN', 'Media admission denied.'); }
    const video = claims!.video, identity = claims!.sub || '', [userId, epoch, extra] = identity.split(':');
    if (!video?.roomJoin || !video.room || !userId || !epoch || extra) fail(403, 'FORBIDDEN', 'Media admission denied.');
    const vm = await db.one('SELECT v.* FROM voice_members v JOIN users u ON u.id=v.user_id WHERE v.user_id=? AND v.epoch=? AND v.channel_id=? AND v.heartbeat>=? AND u.banned=0 AND u.must_change_password=0', [userId, epoch, video!.room, Date.now() - 30000]);
    const sessionId = vm ? sessionForSocket(vm.socket_id) : undefined;
    if (!vm || !sessionId || !await db.one('SELECT id FROM sessions WHERE id=? AND user_id=? AND access_expires>=? AND expires_at>=?', [sessionId, userId, Date.now(), Date.now()])) fail(403, 'FORBIDDEN', 'Media admission denied.');
    const ch = await service.channel(db, userId, vm!.channel_id);
    if (vm!.server_deafened && video!.canSubscribe !== false) fail(403, 'FORBIDDEN', 'Media admission denied.');
    if (video!.canPublishData) fail(403, 'FORBIDDEN', 'Media admission denied.');
    if (video!.canPublish) {
      if (!Array.isArray(video!.canPublishSources) || !video!.canPublishSources.length) fail(403, 'FORBIDDEN', 'Media admission denied.');
      for (const source of video!.canPublishSources!) {
        // AccessToken serializes source enums into strings. TokenVerifier's
        // TypeScript return type does not convert those JWT strings back.
        if ((source === TrackSource.MICROPHONE || String(source) === 'microphone') && ch.permissions.speak && !vm!.server_muted && !vm!.server_deafened) continue;
        if ((source === TrackSource.SCREEN_SHARE || String(source) === 'screen_share') && ch.permissions.share && await db.one('SELECT id FROM share_leases WHERE user_id=? AND channel_id=? AND expires_at>?', [userId, vm!.channel_id, Date.now()])) continue;
        if ((source === TrackSource.SCREEN_SHARE_AUDIO || String(source) === 'screen_share_audio') && ch.permissions.share && await db.one('SELECT id FROM share_leases WHERE user_id=? AND channel_id=? AND expires_at>? AND include_audio=1', [userId, vm!.channel_id, Date.now()])) continue;
        fail(403, 'FORBIDDEN', 'Media admission denied.');
      }
    }
    return { allowed: true };
  });
}
