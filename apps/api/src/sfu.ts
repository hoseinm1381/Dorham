import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import type { Config } from './config';
import type { Service } from './service';
import { fail } from './security';
import { readSnapshot } from './read-snapshot';
import { SingleFlight } from './single-flight';

export class Sfu {
  client: RoomServiceClient | null;
  readonly metrics = { passes: 0, permissionUpdates: 0, removals: 0 };
  private synchronization = new SingleFlight(() => this.synchronizePass());
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
  synchronize() { return this.synchronization.run(); }
  private async synchronizePass() {
    if (!this.client) return;
    this.metrics.passes++;
    const rooms = await this.client.listRooms();
    for (const room of rooms) {
      if (!await this.service.db.one("SELECT id FROM channels WHERE id=? AND kind='voice'", [room.name])) continue;
      const participants = await this.client.listParticipants(room.name);
      const changes = await this.service.db.transaction(async connection => {
        const tx = readSnapshot(connection), actions: (() => Promise<unknown>)[] = [];
        for (const participant of participants) {
        const [userId, epoch] = participant.identity.split(':');
        const remove = () => { actions.push(async () => { await this.client!.removeParticipant(room.name, participant.identity); this.metrics.removals++; }); };
        const now = Date.now();
        const vm = await tx.one('SELECT * FROM voice_members WHERE user_id=? AND epoch=? AND channel_id=? AND heartbeat>=?', [userId, epoch, room.name, now - 30000]);
        if (!vm) { remove(); continue; }
        let ch; try { ch = await this.service.channel(tx, userId, room.name); } catch { remove(); continue; }
        const lease = await tx.one('SELECT id FROM share_leases WHERE user_id=? AND expires_at>=?', [userId, now]);
        const sources = [];
        if (ch.permissions.speak && !vm.server_muted && !vm.server_deafened) sources.push(TrackSource.MICROPHONE);
        if (ch.permissions.share && lease) sources.push(TrackSource.SCREEN_SHARE);
        const permission = { canSubscribe: !vm.server_deafened, canPublish: sources.length > 0, canPublishSources: sources, canPublishData: false, canUpdateMetadata: false };
        const actual = participant.permission;
        if (!actual || actual.canSubscribe !== permission.canSubscribe || actual.canPublish !== permission.canPublish || actual.canPublishData || actual.canUpdateMetadata || JSON.stringify([...actual.canPublishSources].sort()) !== JSON.stringify([...sources].sort())) {
          actions.push(async () => { await this.client!.updateParticipant(room.name, participant.identity, { permission }); this.metrics.permissionUpdates++; });
        }
        }
        return actions;
      });
      // Do not hold a database transaction across SFU network requests.
      for (let i = 0; i < changes.length; i += 4) {
        const results = await Promise.allSettled(changes.slice(i, i + 4).map(change => change()));
        const failed = results.find(r => r.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
      }
    }
  }
}
