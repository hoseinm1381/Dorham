// Opt-in real Piper integration against a fresh loopback-only backend/database.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

assert(process.env.DORHAM_TTS_PYTHON && process.env.DORHAM_TTS_MODELS, 'Provide the prepared local Piper interpreter and model directory.');
const root = process.cwd(), output = path.resolve(process.env.DORHAM_TTS_TEST_OUTPUT || path.join(root, 'artifacts/evidence/tts-performance-real'));
assert(output.startsWith(path.join(root,'artifacts')+path.sep),'Output must be inside owned artifacts');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dorham-tts-real-'));
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`, secret = randomUUID(), sockets = [];
const binary = path.resolve(process.env.DORHAM_TTS_TEST_BINARY || `apps/api-go/dist/dorham${process.platform === 'win32' ? '.exe' : ''}`);
const child = spawn(binary, [], { cwd: root, windowsHide: true, env: { ...process.env, NODE_ENV: 'test', DATA_DIR: dataDir, DATABASE_URL: '', ATTACHMENT_DIR: path.join(dataDir, 'attachments'), HOST: '127.0.0.1', SERVER_PORT: String(port), PUBLIC_URL: base, ALLOWED_ORIGINS: base, COOKIE_SECURE: 'false', MEDIA_TRANSPORT: 'mesh', TURN_URLS: '', CLOUDFLARE_TURN_KEY_ID: '', CLOUDFLARE_TURN_API_TOKEN: '', BOOTSTRAP_ADMIN_SECRET: secret, TTS_KEEP_WARM: 'true', TTS_IDLE_SECONDS: '1', TTS_CPU_PERCENT: process.env.DORHAM_TTS_TEST_CPU_PERCENT || '0', TTS_TIMEOUT_SECONDS: '180', UPLOAD_FREE_RESERVE_MIB: '1' } });
let logs = '', heartbeat;
child.stdout.on('data', data => { logs = (logs + data).slice(-12000); }); child.stderr.on('data', data => { logs = (logs + data).slice(-12000); });
const exit = new Promise(resolve => child.once('exit', resolve));
const report = { platform: process.platform, isolatedDatabase: true, loopbackOnly: true, cpuCapTested: process.env.DORHAM_TTS_TEST_CPU_PERCENT || '0', clips: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(route, token, body) {
  const response = await fetch(base + route, { headers: { 'Content-Type': 'application/json', 'X-Dorham-Native': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify({ requestId: randomUUID(), ...body }) } : {}), signal: AbortSignal.timeout(10000) });
  assert(response.ok, `${route}: ${response.status}`); return response.json();
}
async function until(check, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; assert(child.exitCode === null, logs); await pause(100); }
  throw Error('Timed out waiting for real speech. ' + logs);
}
async function connect(account) {
  const socket = io(base, { auth: { token: account.accessToken }, transports: ['websocket'], reconnection: false }); sockets.push(socket);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); }); return socket;
}
async function action(socket, name, body = {}) { const result = await socket.timeout(5000).emitWithAck(name, { requestId: randomUUID(), ...body }); assert(result.ok, JSON.stringify(result)); return result.data; }
function wavInfo(data) {
  assert.equal(data.toString('ascii', 0, 4), 'RIFF'); assert.equal(data.toString('ascii', 8, 12), 'WAVE');
  let fmt, pcm;
  for (let at = 12; at + 8 <= data.length;) {
    const size = data.readUInt32LE(at + 4), name = data.toString('ascii', at, at + 4);
    if (name === 'fmt ') fmt = data.subarray(at + 8, at + 8 + size);
    if (name === 'data') pcm = data.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  assert(fmt && pcm); assert.equal(fmt.readUInt16LE(0), 1); assert.equal(fmt.readUInt16LE(2), 1); assert.equal(fmt.readUInt32LE(4), 22050); assert.equal(fmt.readUInt16LE(14), 16);
  let sum = 0; for (let i = 0; i + 1 < pcm.length; i += 2) sum += (pcm.readInt16LE(i) / 32768) ** 2;
  const rms = Math.sqrt(sum / (pcm.length / 2)); assert(rms > 0.001);
  return { seconds: pcm.length / 44100, rms, sha256: createHash('sha256').update(data).digest('hex') };
}
try {
  await mkdir(output, { recursive: true });
  await until(async () => { try { return (await fetch(base + '/ready')).ok; } catch { return false; } }, 20000);
  async function register(name) { return api('/api/v1/auth/register', null, { username: name + randomUUID().slice(0, 6), displayName: name, password: randomUUID() + 'fixture' }); }
  const sender = await register('Speaker'), listener = await register('Listener'), outsider = await register('Outside');
  await api('/api/v1/admin/claim', sender.accessToken, { secret });
  const metrics = () => api('/api/v1/admin/metrics', sender.accessToken);
  const server = await api('/api/v1/servers', sender.accessToken, { name: 'Real speech validation' });
  const invite = await api(`/api/v1/servers/${server.id}/invites`, sender.accessToken, { uses: 5 });
  for (const user of [listener, outsider]) await api('/api/v1/invites/join', user.accessToken, { code: invite.code });
  const bootstrap = await api('/api/v1/bootstrap', sender.accessToken), channels = bootstrap.channels.filter(channel => channel.serverId === server.id);
  const voice = channels.find(channel => channel.kind === 'voice'), chat = channels.find(channel => channel.kind === 'text');
  const [actor, peer, outside] = await Promise.all([sender, listener, outsider].map(connect));
  const events = [], progressEvents = [], outsideEvents = [], heartbeats = [], notices = [];
  actor.on('voice:tts-notice', event => notices.push(event.text));
  peer.on('voice:tts', event => events.push({ ...event, at: Date.now() })); outside.on('voice:tts', event => outsideEvents.push(event));
  peer.on('voice:tts-progress', event => progressEvents.push({ ...event, at: Date.now() })); outside.on('voice:tts-progress', event => outsideEvents.push(event));
  for (const socket of [actor, peer]) await action(socket, 'voice:join', { channelId: voice.id, eligible: false });
  heartbeat = setInterval(() => { for (const socket of [actor, peer]) { const start = Date.now(); void action(socket, 'voice:heartbeat', { eligible: false }).then(() => heartbeats.push(Date.now() - start)).catch(() => heartbeats.push(-1)); } }, 4000);
  const start = Date.now(); await until(async () => (await metrics()).tts.worker.modelsReady);
  report.prewarmSeconds = (Date.now() - start) / 1000;
  report.prewarmedWorker = (await metrics()).tts.worker;
  assert.equal(report.prewarmedWorker.starts, 1);
  let lastSent = 0;
  async function speak(name, text) {
    await pause(Math.max(0, 4100 - (Date.now() - lastSent))); lastSent = Date.now();
    const message = await api('/api/v1/messages', sender.accessToken, { conversationId: chat.conversationId, content: '/tts ' + text });
    const id = message.payload.id;
    await until(() => { assert.equal(notices.length, 0, notices.join('; ')); return events.filter(event => event.messageId === id).length === 1; });
    const clips = events.filter(event => event.messageId === id).sort((a, b) => a.chunkIndex - b.chunkIndex);
    assert(clips[0].at - lastSent >= 2900); assert.deepEqual(clips.map(clip => clip.chunkIndex), [0]); assert.equal(clips[0].chunkCount, 1);
    const record = { name, firstSeconds: (clips[0].at - lastSent) / 1000, completeSeconds: (clips[0].at - lastSent) / 1000, chunks: [] };
    record.progress = progressEvents.filter(event => event.id === id).map(({ percent, phase }) => ({ percent, phase }));
    assert(record.progress.length > 0); assert(record.progress.every(event => event.percent >= 0 && event.percent <= 100));
    if (name !== 'persian-repeated') assert(record.progress.some(event => event.percent > 0 && event.percent < 100));
    for (const [index, clip] of clips.entries()) {
      const read = token => fetch(`${base}/api/v1/voice/tts/${clip.id}/audio`, { headers: { Authorization: `Bearer ${token}` } });
      const a = await read(sender.accessToken), b = await read(listener.accessToken), denied = await read(outsider.accessToken);
      assert(a.ok && b.ok); assert.equal(denied.status, 404);
      const data = Buffer.from(await a.arrayBuffer()); assert(data.equals(Buffer.from(await b.arrayBuffer())));
      const info = wavInfo(data); record.chunks.push(info); await writeFile(path.join(output, `${name}-${index}.wav`), data);
    }
    report.clips.push(record); console.log(`${name}: whole message ready ${record.completeSeconds.toFixed(3)}s`);
    return { record, clips };
  }
  await speak('english', 'Hello friends. The speech worker stays ready in memory.');
  const persian = await speak('persian', 'سلام دوستان، به برنامه دورهم خوش آمدید. صدای فارسی آماده است.');
  await speak('mixed', 'سلام دوستان Hello friends به دورهم خوش آمدید Welcome to Dorham');
  const before = (await metrics()).tts.synthesisCacheHits;
  const cached = await speak('persian-repeated', 'سلام دوستان، به برنامه دورهم خوش آمدید. صدای فارسی آماده است.');
  assert.equal((await metrics()).tts.synthesisCacheHits, before + 1);
  assert.deepEqual(cached.record.chunks.map(clip => clip.sha256), persian.record.chunks.map(clip => clip.sha256));
  await action(peer, 'voice:leave'); await action(peer, 'voice:join', { channelId: voice.id, eligible: false });
  const deniedOld = await fetch(`${base}/api/v1/voice/tts/${cached.clips[0].id}/audio`, { headers: { Authorization: `Bearer ${listener.accessToken}` } }); assert.equal(deniedOld.status, 404);
  await pause(7000);
  report.finalMetrics = (await metrics()).tts;
  assert.equal(report.finalMetrics.worker.pid, report.prewarmedWorker.pid); assert.equal(report.finalMetrics.worker.starts, 1); assert.equal(report.finalMetrics.worker.idleStops, 0);
  assert.equal(outsideEvents.length, 0); assert(heartbeats.length > 0 && heartbeats.every(ms => ms >= 0));
  report.heartbeatMaxMs = Math.max(...heartbeats); report.reusedIdenticalAudio = true; report.rejoinedEpochDenied = true; report.persistedBeyondConfiguredIdle = true;
  report.passed = true;
} finally {
  clearInterval(heartbeat); sockets.forEach(socket => socket.disconnect());
  if (child.exitCode === null) {
    if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    else child.kill('SIGTERM');
    await exit;
  }
  assert(path.dirname(path.resolve(dataDir)) === path.resolve(os.tmpdir()) && path.basename(dataDir).startsWith('dorham-tts-real-'));
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  report.syntheticDataRemoved = true;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(output, 'runtime.log'), logs);
}
assert(report.passed); console.log('Real bilingual Piper, prewarm, single complete WAV, reuse, voice privacy and persistent worker checks passed.');
