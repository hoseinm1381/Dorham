import { harness, event } from '../tests/helpers';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Sfu } from '../apps/api/src/sfu';

// Same isolated SQLite/socket workload before and after optimization. Registration
// and fixture setup are outside timing; mock SFU RPCs count control work only.
const label = process.env.DORHAM_BENCH_LABEL || 'current';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid benchmark label');
let sfuRpcs = 0;
const synchronize = Sfu.prototype.synchronize;
Sfu.prototype.synchronize = async function () { sfuRpcs++; };
const h = await harness({ mediaTransport: 'livekit', livekitUrl: 'ws://127.0.0.1:7880', livekitKey: 'benchmark', livekitSecret: 'isolated-benchmark-secret-not-real' });
try {
  const users: Awaited<ReturnType<typeof h.register>>[] = []; for (let i = 0; i < 10; i++) users.push(await h.register(`serverbench${i}`));
  const server = (await h.api(users[0], '/servers', { name: 'Isolated performance fixture' })).json();
  const invite = (await h.api(users[0], `/servers/${server.id}/invites`, { uses: 10 })).json();
  for (const user of users.slice(1)) await h.api(user, '/invites/join', { code: invite.code });
  for (let i = 0; i < 12; i++) await h.api(users[0], `/servers/${server.id}/channels`, { name: `Empty ${i}`, kind: i < 6 ? 'text' : 'voice' });
  const snapshot = (await h.api(users[0], '/bootstrap')).json(), voice = snapshot.channels.find((c: any) => c.kind === 'voice');
  const sockets: Awaited<ReturnType<typeof h.connect>>[] = []; for (const user of users) sockets.push(await h.connect(user));
  for (const socket of sockets) await event(socket, 'voice:join', { channelId: voice.id, eligible: true });
  for (const socket of sockets.slice(0, 3)) await event(socket, 'share:start', { requestId: randomUUID() });
  h.config.mediaTransport = 'livekit';
  let reads = 0, writes = 0;
  const transaction = h.db.transaction.bind(h.db);
  h.db.transaction = fn => transaction(tx => fn({ ...tx,
    all: async (q, p) => { reads++; return tx.all(q, p); }, one: async (q, p) => { reads++; return tx.one(q, p); }, run: async (q, p) => { writes++; await tx.run(q, p); }
  }));
  for (const key of ['all', 'one', 'run'] as const) { const original = h.db[key].bind(h.db); (h.db as any)[key] = async (...args: any[]) => { if (key === 'run') writes++; else reads++; return (original as any)(...args); }; }
  sfuRpcs = 0;
  const results: Record<string, unknown> = {}, delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  async function phase(name: string, work: () => Promise<void>) {
    const before = { reads, writes, sfuRpcs }, cpu = process.cpuUsage(), started = performance.now();
    await work(); const used = process.cpuUsage(cpu);
    results[name] = { sqlReads: reads - before.reads, sqlWrites: writes - before.writes, sfuRpcs: sfuRpcs - before.sfuRpcs, cpuMs: (used.user + used.system) / 1000, elapsedMs: performance.now() - started };
  }
  await phase('heartbeats100', async () => { for (let i = 0; i < 10; i++) for (const s of sockets) await event(s, 'voice:heartbeat', { eligible: true }); });
  await phase('muteTransitions20', async () => { for (const muted of [true, false]) for (const s of sockets) await event(s, 'voice:state', { muted, deafened: false, requestId: randomUUID() }); });
  await phase('unchangedStates20', async () => { for (let i = 0; i < 2; i++) for (const s of sockets) await event(s, 'voice:state', { muted: false, deafened: false, requestId: randomUUID() }); });
  await phase('snapshots10', async () => { for (const user of users) await h.service.bootstrap(user.id); });
  await phase('maintenance5', async () => { for (let i = 0; i < 5; i++) await h.service.cleanup(); });
  await phase('voiceRefresh10', async () => { for (let i = 0; i < 10; i++) await h.service.notify('voice:changed', {}); });
  delay.disable();
  const report = { label, measuredAt: new Date().toISOString(), node: process.version, workload: { users: 10, roomMembers: 10, shares: 3, totalChannels: 14, media: 'none; mocked SFU control RPCs', registrationTimed: false }, phases: results, totals: { sqlReads: reads, sqlWrites: writes, sfuRpcs, rssMiB: process.memoryUsage().rss / 1048576, eventLoopP95Ms: delay.percentile(95) / 1e6 }, limits: 'Local control-plane comparison only; does not measure SFU packet forwarding or certify sustained media capacity.' };
  await mkdir('artifacts/evidence', { recursive: true }); await writeFile(`artifacts/evidence/server-performance-${label}.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await h.close(); Sfu.prototype.synchronize = synchronize; }
