import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../apps/api/src/app';
import { config } from '../apps/api/src/config';
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dorham-browser-'));
const relay = process.env.DORHAM_RELAY_TEST === '1';
const h = await createApp(config({ dataDir, databaseUrl: '', publicUrl: 'http://127.0.0.1:3101', origins: ['http://127.0.0.1:3101'], port: 3101, stunUrls: [], maxUsers: 100,
  roomShares: 0, globalShares: 0,
  // Ordinary browser scenarios remain independent of external accounts and relays.
  ...(!relay ? { turnUrls: [], turnUsername: '', turnPassword: '', turnSecret: '', cloudflareTurnKeyId: '', cloudflareTurnApiToken: '' } : {})
}), { logger: false, rateLimit: false });
await h.app.listen({ port: 3101, host: '127.0.0.1' });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void h.app.close().then(() => process.exit(0)); });
