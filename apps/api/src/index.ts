import { createApp } from './app';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const { app, config } = await createApp();
await app.listen({ port: config.port, host: config.host });
// Operator-only startup evidence, useful when the host's console stream is unavailable.
// This records a startup, not a live health signal, and contains no credentials.
await writeFile(path.join(config.dataDir, 'runtime-status.json'), JSON.stringify({
  startedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  pid: process.pid, host: config.host, port: config.port, publicUrl: config.publicUrl,
  database: config.databaseUrl ? 'postgresql' : 'sqlite', rssBytes: process.memoryUsage().rss
}, null, 2), { mode: 0o600 }).catch(error => app.log.warn({ error }, 'Could not save startup evidence'));
for (const event of ['SIGINT', 'SIGTERM'] as const) process.once(event, () => { void app.close().then(() => process.exit(0)); });
