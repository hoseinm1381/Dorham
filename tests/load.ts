import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness, event } from './helpers';
const h = await harness({ roomShares: 0, globalShares: 0 });
const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
const started = performance.now(), cpuStart = process.cpuUsage();
const samples: number[] = [], rss: number[] = []; const timer = setInterval(() => rss.push(process.memoryUsage().rss), 50);
try {
  const users = []; for (let i = 0; i < 21; i++) users.push(await h.register(`load${i.toString().padStart(2, '0')}`));
  const serverId = (await h.api(users[0], '/servers', { name: 'Capacity laboratory' })).json().id;
  const invite = (await h.api(users[0], `/servers/${serverId}/invites`, { uses: 100 })).json();
  for (const user of users.slice(1)) await h.api(user, '/invites/join', { code: invite.code });
  const snapshot = (await h.api(users[0], '/bootstrap')).json(), text = snapshot.channels.find((c: any) => c.kind === 'text'), voice = snapshot.channels.find((c: any) => c.kind === 'voice');
  const sockets: Awaited<ReturnType<typeof h.connect>>[] = []; for (const user of users.slice(0, 20)) sockets.push(await h.connect(user));
  await assert.rejects(h.connect(users[20]), /capacity/);
  for (const socket of sockets.slice(0, 16)) await event(socket, 'voice:join', { channelId: voice.id, eligible: true });
  await assert.rejects(event(sockets[16], 'voice:join', { channelId: voice.id, eligible: true }), /ROOM_FULL/);
  const second = (await h.api(users[0], `/servers/${serverId}/channels`, { name: 'Second room', kind: 'voice' })).json();
  const third = (await h.api(users[0], `/servers/${serverId}/channels`, { name: 'Third room', kind: 'voice' })).json();
  for (const socket of sockets.slice(16, 18)) await event(socket, 'voice:join', { channelId: second.id, eligible: true });
  for (const socket of sockets.slice(18, 20)) await event(socket, 'voice:join', { channelId: third.id, eligible: true });
  await Promise.all(sockets.map(socket => event(socket, 'share:start', { requestId: randomUUID() })));
  await event(sockets[0], 'share:start', { requestId: randomUUID() });
  assert.equal((await h.db.one('SELECT COUNT(*) AS count FROM share_leases'))!.count, 20);
  assert.equal((await h.service.room(users[0].id, voice.id)).shares.length, 16);
  const heartbeats = setInterval(() => { for (const socket of sockets) void event(socket, 'voice:heartbeat', { eligible: true }).catch(() => {}); }, 5000);
  try {
    for (let round = 0; round < 10; round++) {
      await Promise.all(sockets.map(async (socket, i) => { const t = performance.now(); await event(socket, 'message:send', { requestId: randomUUID(), conversationId: text.conversationId, content: `Measured message ${round} from client ${i}` }); samples.push(performance.now() - t); }));
      await new Promise(r => setTimeout(r, 100));
    }
  } finally { clearInterval(heartbeats); }
  let bytes = 0; for (const name of await readdir(h.dataDir)) { const s = await stat(path.join(h.dataDir, name)); if (s.isFile()) bytes += s.size; }
  samples.sort((a, b) => a - b); const elapsed = performance.now() - started, cpu = process.cpuUsage(cpuStart);
  const report = { measuredAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, arch: process.arch }, scenario: 'One local Node process, real SQLite, 20 Socket.IO clients, 16 voice memberships in primary room, 20 screen leases with fixed caps disabled; no media generated in this control-plane test', controlPlane: { concurrentUsers: 20, messages: samples.length, voiceMemberships: 20, primaryRoomMembers: 16, activeShareLeases: 20, rejectedTwentyFirstUser: true, rejectedSeventeenthVoiceMember: true, duplicatePublicationPrevented: true }, measurements: { elapsedMs: elapsed, acknowledgementP50Ms: samples[Math.floor(samples.length * 0.5)], acknowledgementP95Ms: samples[Math.floor(samples.length * 0.95)], acknowledgementMaxMs: samples.at(-1), peakRssMiB: Math.max(...rss, process.memoryUsage().rss) / 1048576, finalRssMiB: process.memoryUsage().rss / 1048576, cpuMilliseconds: (cpu.user + cpu.system) / 1000, averageCorePercent: ((cpu.user + cpu.system) / 1000) / elapsed * 100, eventLoopP95Ms: delay.percentile(95) / 1e6, databaseAndWalBytes: bytes }, limits: 'Local unsandboxed Windows measurement; not a 1-vCPU cgroup or hosted SFU capacity certification.' };
  await mkdir('artifacts/evidence', { recursive: true }); await writeFile('artifacts/evidence/control-plane-load.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  assert(report.measurements.acknowledgementP95Ms < 500, 'p95 exceeds initial target'); assert(report.measurements.peakRssMiB < 640, 'Peak RSS exceeds initial target');
} finally { clearInterval(timer); delay.disable(); await h.close(); }
