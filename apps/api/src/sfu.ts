import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import type { Config } from './config';
import type { Service } from './service';
import { fail } from './security';

export class Sfu {
  client: RoomServiceClient | null;
  constructor(private c: Config, private service: Service) {
    this.client = c.mediaTransport === 'livekit' ? new RoomServiceClient(c.livekitApiUrl || c.livekitUrl.replace(/^ws/, 'http'), c.livekitKey, c.livekitSecret) : null;
  }
  async credentials(userId: string, socketId: string, channelId: string) {
    if (!this.client) fail(409, 'SFU_DISABLED', 'This instance uses peer-to-peer media.');
    const vm = await this.service.db.one('SELECT * FROM voice_members WHERE user_id=? AND socket_id=? AND channel_id=? AND heartbeat>=?', [userId, socketId, channelId, Date.now() - 30000]);
    if (!vm) fail(403, 'FORBIDDEN', 'An active voice session is required.');
    const access = await this.service.channel(this.service.db, userId, channelId);
    const lease = await this.service.db.one('SELECT id FROM share_leases WHERE user_id=? AND expires_at>=?', [userId, Date.now()]);
    const sources = [];
    if (access.permissions.speak && !vm!.server_muted && !vm!.server_deafened) sources.push(TrackSource.MICROPHONE);
    if (access.permissions.share && lease) sources.push(TrackSource.SCREEN_SHARE);
    const jwt = new AccessToken(this.c.livekitKey, this.c.livekitSecret, { identity: `${userId}:${vm!.epoch}`, ttl: 60, name: userId });
    jwt.addGrant({ roomJoin: true, room: channelId, canSubscribe: !vm!.server_deafened, canPublish: sources.length > 0, canPublishSources: sources, canPublishData: false, canUpdateOwnMetadata: false });
    return { url: this.c.livekitUrl, token: await jwt.toJwt(), identity: `${userId}:${vm!.epoch}` };
  }
  async synchronize() {
    if (!this.client) return;
    const rooms = await this.client.listRooms();
    for (const room of rooms) {
      if (!await this.service.db.one("SELECT id FROM channels WHERE id=? AND kind='voice'", [room.name])) continue;
      for (const participant of await this.client.listParticipants(room.name)) {
        const [userId, epoch] = participant.identity.split(':');
        const vm = await this.service.db.one('SELECT * FROM voice_members WHERE user_id=? AND epoch=? AND channel_id=? AND heartbeat>=?', [userId, epoch, room.name, Date.now() - 30000]);
        if (!vm) { await this.client.removeParticipant(room.name, participant.identity); continue; }
        let ch; try { ch = await this.service.channel(this.service.db, userId, room.name); } catch { await this.client.removeParticipant(room.name, participant.identity); continue; }
        const lease = await this.service.db.one('SELECT id FROM share_leases WHERE user_id=? AND expires_at>=?', [userId, Date.now()]);
        const sources = [];
        if (ch.permissions.speak && !vm.server_muted && !vm.server_deafened) sources.push(TrackSource.MICROPHONE);
        if (ch.permissions.share && lease) sources.push(TrackSource.SCREEN_SHARE);
        await this.client.updateParticipant(room.name, participant.identity, { permission: { canSubscribe: !vm.server_deafened, canPublish: sources.length > 0, canPublishSources: sources, canPublishData: false, canUpdateMetadata: false } });
      }
    }
  }
}
