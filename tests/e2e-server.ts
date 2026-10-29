import { RoomServiceClient } from 'livekit-server-sdk';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../apps/api/src/app';
import { config } from '../apps/api/src/config';
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dorham-browser-'));
const relay = process.env.DORHAM_RELAY_TEST === '1';
const h = await createApp(config({ dataDir, databaseUrl: '', publicUrl: 'http://127.0.0.1:3101', origins: ['http://127.0.0.1:3101'], port: 3101, stunUrls: [], maxUsers: 100,
  roomShares: 0, globalShares: 0, bootstrapSecret: 'browser-fixture-bootstrap-not-for-deployment',
  // Ordinary browser scenarios remain independent of external accounts and relays.
  ...(!relay ? { turnUrls: [], turnUsername: '', turnPassword: '', turnSecret: '', cloudflareTurnKeyId: '', cloudflareTurnApiToken: '' } : {})
}), { logger: false, rateLimit: false });
if (process.env.DORHAM_SFU_ISOLATED_TEST === '1' && h.config.mediaTransport === 'livekit') h.app.addHook('preClose', async () => {
  const client = new RoomServiceClient(h.config.livekitApiUrl, h.config.livekitKey, h.config.livekitSecret);
  // Only UUID rooms from this local fixture database; never enumerate/delete live rooms.
  for (const channel of await h.db.all("SELECT id FROM channels WHERE kind='voice'")) await client.deleteRoom(channel.id).catch(() => {});
});
await h.app.listen({ port: 3101, host: '127.0.0.1' });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void h.app.close().then(() => process.exit(0)); });
