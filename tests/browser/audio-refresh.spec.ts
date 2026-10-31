import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { completeRecovery } from './recovery-helper';
test.use({ trace: 'off', video: 'off' });
async function api(page: Page, route: string, body?: object) {
  return page.evaluate(async ({ route, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json();
    const response = await fetch('/api/v1' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf }, body: body ? JSON.stringify({ requestId: crypto.randomUUID(), ...body }) : undefined });
    if (!response.ok) throw Error(`API ${response.status}`); return response.json();
  }, { route, body });
}
async function register(page: Page, name: string) {
  await page.goto('/'); await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill(name); await page.getByLabel('Username', { exact: true }).fill(name); await page.getByLabel('Password', { exact: true }).fill('synthetic-fixture-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click(); await completeRecovery(page);
}
async function settings(page: Page) { await page.getByRole('button', { name: 'Account settings', exact: true }).click(); }
async function capture(page: Page, name: string) { await mkdir('artifacts/evidence', { recursive: true }); await page.screenshot({ path: `artifacts/evidence/v077-${name}.png`, fullPage: true }); }
test('simple audio defaults, advanced boost, saved noise modes and mobile Persian layouts', async ({ page }) => {
  await register(page, `Audio${Date.now().toString().slice(-7)}`); await settings(page); await page.getByRole('tab', { name: 'Audio', exact: true }).click();
  await expect(page.locator('.audio-advanced')).not.toHaveAttribute('open');
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  const volume = page.getByRole('slider', { name: 'Microphone volume', exact: true }), noise = page.getByRole('combobox', { name: 'Noise removal', exact: true });
  await expect(volume).toHaveValue('100'); await expect(noise).toHaveValue('standard'); expect(await page.locator('.audio-advanced > summary').evaluate(e => e.getBoundingClientRect().bottom <= e.closest('.modal')!.getBoundingClientRect().bottom)).toBe(true); await capture(page, 'audio-simple');
  await noise.selectOption('strong'); await expect(noise).toHaveValue('strong'); await page.locator('.audio-advanced > summary').click();
  await page.getByLabel('Allow microphone boost up to +45 dB', { exact: true }).check(); await volume.fill('45'); await expect(page.locator('.microphone-gain output')).toHaveText('+45.0 dB');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click(); await page.reload(); await settings(page); await page.getByRole('tab', { name: 'Audio', exact: true }).click();
  await expect(volume).toHaveValue('45'); await expect(noise).toHaveValue('strong'); await noise.selectOption('off'); await expect(noise).toHaveValue('off');
  await page.locator('.audio-advanced > summary').click(); await page.getByLabel('Allow microphone boost up to +45 dB', { exact: true }).uncheck(); await expect(volume).toHaveValue('250');
  await page.getByRole('button', { name: 'Reset microphone gain', exact: true }).click(); await expect(volume).toHaveValue('100');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click(); await settings(page); await page.getByRole('tab', { name: 'Audio', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.locator('.modal').evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true); await capture(page, 'audio-mobile');
  await page.getByRole('tab', { name: 'Profile', exact: true }).click(); await page.locator('.language-picker select').selectOption('fa-IR');
  await page.getByRole('tab', { name: 'صدا', exact: true }).click(); await expect(page.getByLabel('حذف نویز', { exact: true })).toBeVisible();
  expect(await page.locator('.modal').evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true); await capture(page, 'audio-persian');
});

test('all sixteen pictures load, presets and custom uploads persist and both DM lists share fallback colours', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext(), page = await a.newPage(), friend = await b.newPage();
  try {
    const run = Date.now().toString().slice(-7); await register(page, `AvatarA${run}`); await register(friend, `AvatarB${run}`);
    const me = await api(page, '/auth/me'), other = await api(friend, '/auth/me');
    const dm = await api(page, '/dms', { userId: other.user.id }); await api(page, '/messages', { conversationId: dm.id, content: 'Avatar colour test' });
    await page.locator('.home-nav').click();
    const sidebar = page.locator('.dm-item').filter({ hasText: other.user.displayName }).locator('.avatar'), main = page.locator('.dm-conversation').filter({ hasText: other.user.displayName }).locator('.avatar');
    await expect(main).toBeVisible(); expect(await main.evaluate(e => getComputedStyle(e).backgroundColor)).toBe(await sidebar.evaluate(e => getComputedStyle(e).backgroundColor)); await capture(page, 'dm-colours');
    await settings(page); await page.locator('.avatar-options > summary').click(); await expect(page.locator('.avatar-grid button')).toHaveCount(16);
    await expect.poll(() => page.locator('.avatar-grid img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true); await capture(page, 'avatars-desktop');
    await page.getByRole('button', { name: 'Fox', exact: true }).click(); await expect(page.getByText('Profile picture saved.', { exact: true })).toBeVisible();
    const preset = (await api(page, '/auth/me')).user.avatar; expect(preset).toMatch(/^\/avatars\//);
    await expect(friend.locator('.dm-item img')).toHaveCount(1); await page.getByRole('button', { name: 'Close dialog', exact: true }).click(); await page.reload(); expect((await api(page, '/auth/me')).user.avatar).toBe(preset);
    await settings(page); await page.locator('.avatar-options > summary').click(); await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator('.modal').evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true); await capture(page, 'avatars-mobile');
    const custom = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#83daba' } }).png().toBuffer();
    await page.getByLabel('Change avatar', { exact: true }).setInputFiles({ name: 'own.png', mimeType: 'image/png', buffer: custom });
    await expect.poll(async () => (await api(page, '/auth/me')).user.avatar).not.toBe(preset); expect((await api(page, '/auth/me')).user.id).toBe(me.user.id);
  } finally { await a.close(); await b.close(); }
});

async function dsp(page: Page) {
  const bundle = await build({ entryPoints: ['packages/media/src/microphone-gain.ts'], bundle: true, write: false, format: 'iife', globalName: 'DenoiserTest', platform: 'browser' });
  await page.route('**/denoiser-test.js', route => route.fulfill({ contentType: 'application/javascript', body: bundle.outputFiles![0].text }));
  const speech = await readFile('tests/fixtures/synthetic-voice.wav');
  await page.route('**/synthetic-voice.wav', route => route.fulfill({ contentType: 'audio/wav', body: speech }));
  await page.goto('/'); await page.addScriptTag({ url: '/denoiser-test.js' });
}
test('real RNNoise reduces synthetic background noise at high boost, retains speech and releases its graph', async ({ page }) => {
  test.setTimeout(90000); await dsp(page);
  const result = await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 48000 }); await context.resume();
    const speech = await context.decodeAudioData(await (await fetch('/synthetic-voice.wav')).arrayBuffer());
    const duration = Math.min(6, speech.duration), seconds = duration + 3, length = Math.ceil(seconds * context.sampleRate);
    const buffer = context.createBuffer(1, length, context.sampleRate), data = buffer.getChannelData(0), voice = speech.getChannelData(0); let seed = 9, peak = 0;
    for (const sample of voice) peak = Math.max(peak, Math.abs(sample));
    for (let i = 0; i < length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; data[i] = ((seed / 4294967296) * 2 - 1) * .00045; const j = i - 48000; if (j >= 0 && j < duration * 48000) data[i] += (voice[j] || 0) / peak * .006; }
    async function run(mode: 'off' | 'strong') {
      const source = context.createBufferSource(); source.buffer = buffer; const capture = context.createMediaStreamDestination(); source.connect(capture);
      const gain = new (window as any).DenoiserTest.MicrophoneGain(10 ** (30 / 20)); gain.setClarity(false); gain.setNoiseFilter(false); await gain.setNoiseRemoval(mode); await gain.init({ track: capture.stream.getAudioTracks()[0], audioContext: context });
      const state = gain.getNoiseRemoval(), recorder = new MediaRecorder(new MediaStream([gain.processedTrack]), { mimeType: 'audio/webm;codecs=opus' }); const chunks: Blob[] = [];
      recorder.ondataavailable = e => chunks.push(e.data); const finished = new Promise<ArrayBuffer>(resolve => recorder.onstop = async () => resolve(await new Blob(chunks).arrayBuffer())); recorder.start(); source.start();
      await new Promise<void>(resolve => { source.onended = () => resolve(); }); recorder.stop(); const decoded = await context.decodeAudioData(await finished), samples = decoded.getChannelData(0);
      const rms = (start: number, end: number) => { const part = samples.subarray(start * 48000, Math.min(end * 48000, samples.length)); return Math.sqrt(part.reduce((s, v) => s + v * v, 0) / part.length); };
      await gain.destroy(); const released = !gain.processedTrack;
      source.disconnect(); capture.stream.getTracks().forEach(t => t.stop()); return { state, noise: rms(.4, .9), tailNoise: rms(duration + 1.3, duration + 2.3), speech: rms(1.5, duration + .7), released };
    }
    const off = await run('off'), strong = await run('strong'); await context.close(); return { off, strong, noiseRatio: strong.tailNoise / off.tailNoise, speechRatio: strong.speech / off.speech, generatedVoice: true, inputBoostDb: 30 };
  });
  await mkdir('artifacts/evidence', { recursive: true }); await writeFile('artifacts/evidence/v077-denoiser.json', JSON.stringify(result, null, 2));
  expect(result.strong.state).toMatchObject({ active: 'strong', status: 'ready' }); expect(result.noiseRatio).toBeLessThan(.4); expect(result.speechRatio).toBeGreaterThan(.65); expect(result.strong.released).toBe(true);
});
test('missing model visibly falls back and does not leave the microphone graph silent', async ({ page }) => {
  await page.route('**/audio/rnnoise.wasm', route => route.fulfill({ status: 404, body: 'missing model' })); await dsp(page);
  const result = await page.evaluate(async () => {
    const ctx = new AudioContext({ sampleRate: 48000 }), source = ctx.createOscillator(), capture = ctx.createMediaStreamDestination(); source.connect(capture); source.start(); await ctx.resume();
    const gain = new (window as any).DenoiserTest.MicrophoneGain(); await gain.setNoiseRemoval('strong'); await gain.init({ track: capture.stream.getAudioTracks()[0], audioContext: ctx });
    const meter = ctx.createAnalyser(); const output = ctx.createMediaStreamSource(new MediaStream([gain.processedTrack])); output.connect(meter); await new Promise(r => setTimeout(r, 250)); const values = new Float32Array(2048); meter.getFloatTimeDomainData(values);
    const state = gain.getNoiseRemoval(), rms = Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length); gain.setEnabled(false); await gain.setNoiseRemoval('off'); gain.setGain(10 ** (45 / 20)); await new Promise(r => setTimeout(r, 200)); meter.getFloatTimeDomainData(values); const muted = Math.max(...values.map(Math.abs)); gain.setGain(1); gain.setEnabled(true); await new Promise(r => setTimeout(r, 200)); meter.getFloatTimeDomainData(values); const recovered = Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length); await gain.destroy(); source.stop(); capture.stream.getTracks().forEach(t => t.stop()); await ctx.close(); return { state, rms, muted, recovered };
  });
  expect(result.state).toMatchObject({ requested: 'strong', active: 'standard', status: 'fallback' }); expect(result.rms).toBeGreaterThan(.1); expect(result.muted).toBeLessThan(.000001); expect(result.recovered).toBeGreaterThan(.1);
});
test('bundled default pictures and denoiser assets remain available offline without caching private APIs', async ({ page, context }) => {
  await page.goto('/'); await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  try {
    const assets = await page.evaluate(async () => Promise.all(['/profile-pictures/fox.webp', '/audio/rnnoise.wasm', '/audio/rnnoise-worklet.js'].map(async path => {
      const response = await fetch(path); return { path, status: response.status, bytes: (await response.arrayBuffer()).byteLength };
    })));
    for (const asset of assets) { expect(asset.status).toBe(200); expect(asset.bytes).toBeGreaterThan(100); }
    expect(await page.evaluate(async () => { try { await fetch('/api/v1/auth/me'); return 'cached'; } catch { return 'offline'; } })).toBe('offline');
  } finally { await context.setOffline(false); }
});


test('Strong denoising through isolated SFU preserves speech, mute, capture restart and rejoin', async ({ page, request }) => {
  test.skip(process.env.DORHAM_SFU_ISOLATED_TEST !== '1', 'Requires authorized isolated SFU credentials.');
  test.setTimeout(180000);
  page.on('console', message => { if (message.type() === 'error') console.log('SFU fixture browser:', message.text()); });
  const bundle = await build({ stdin: { contents: "export { LiveKitTransport } from './packages/media/src/livekit'; export { io } from 'socket.io-client';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', globalName: 'SfuFixture', platform: 'browser' });
  await page.route('**/sfu-fixture.js', route => route.fulfill({ contentType: 'application/javascript', body: bundle.outputFiles![0].text }));
  const speech = await readFile('tests/fixtures/synthetic-voice.wav');
  await page.route('**/fixture-voice.wav', route => route.fulfill({ contentType: 'audio/wav', body: speech }));
  const run = Date.now().toString().slice(-8);
  async function call(route: string, body: object, token?: string) {
    const response = await request.post('/api/v1' + route, { headers: { 'X-Dorham-Native': '1', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, data: { requestId: crypto.randomUUID(), ...body } });
    expect(response.ok()).toBe(true); return response.json();
  }
  const a = await call('/auth/register', { username: `SfuA${run}`, displayName: 'SFU fixture A', password: 'synthetic-sfu-fixture-123' });
  const b = await call('/auth/register', { username: `SfuB${run}`, displayName: 'SFU fixture B', password: 'synthetic-sfu-fixture-123' });
  const server = await call('/servers', { name: 'Strong isolated SFU' }, a.accessToken), invite = await call(`/servers/${server.id}/invites`, {}, a.accessToken);
  await call('/invites/join', { code: invite.code }, b.accessToken);
  const boot = await (await request.get('/api/v1/bootstrap', { headers: { Authorization: 'Bearer ' + a.accessToken } })).json();
  const channelId = boot.channels.find((c: any) => c.serverId === server.id && c.kind === 'voice').id;
  expect(boot.mediaTransport).toBe('livekit');
  await page.goto('/ready'); await page.addScriptTag({ url: '/sfu-fixture.js' });
  // Both adapters run in one empty page to keep this signal check below the shared browser RAM budget.
  await page.evaluate(async ({ a, b, channelId }) => {
    const lib = (window as any).SfuFixture, meters = new Map<AudioContext, AnalyserNode>(), connect = AudioNode.prototype.connect;
    (window as any).__sfuMeters = meters;
    AudioNode.prototype.connect = function (destination: any, ...args: any[]): any {
      if (destination === this.context.destination) { const meter = this.context.createAnalyser(); meter.fftSize = 2048; meters.set(this.context as AudioContext, meter); (connect as any).call(this, meter); }
      return (connect as any).call(this, destination, ...args);
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext({ sampleRate: 48000 }); await ctx.resume();
      const buffer = await ctx.decodeAudioData(await (await fetch('/fixture-voice.wav')).arrayBuffer());
      const data = buffer.getChannelData(0); let peak = 0; for (const value of data) peak = Math.max(peak, Math.abs(value));
      for (let i = 0; i < data.length; i++) data[i] = data[i] / peak * .006;
      const source = ctx.createBufferSource(), capture = ctx.createMediaStreamDestination(); source.buffer = buffer; source.loop = true; source.connect(capture); source.start();
      // Generated Web Audio tracks have no hardware device ID; accept the fixture's device-only constraint.
      const track = capture.stream.getTracks()[0]; track.applyConstraints = async () => {};
      track.addEventListener('ended', () => { source.stop(); void ctx.close(); }); return capture.stream;
    };
    const errors: string[] = []; (window as any).__sfuErrors = errors;
    async function adapter(auth: any, strong: boolean) {
      const socket = lib.io(location.origin, { transports: ['websocket'], auth: { token: auth.accessToken } });
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
      const transport = new lib.LiveKitTransport({ socket, userId: auth.user.id, emit: (name: string, value: any) => { if (name === 'error') errors.push(String(value)); }, microphoneGain: strong ? 10 ** (30 / 20) : 1, noiseRemoval: strong ? 'strong' : 'off', voiceClarity: false });
      if (!strong) await transport.setMuted(true);
      await transport.join(channelId); return { transport, socket };
    }
    const sender = await adapter(a, true), receiver = await adapter(b, false);
    (window as any).__sfuFixture = { sender, receiver, channelId };
  }, { a, b, channelId });
  async function state() { return page.evaluate(() => (window as any).__sfuFixture.sender.transport.getNoiseRemoval()); }
  async function rms() { return page.evaluate(async () => { let total = 0; for (let i = 0; i < 10; i++) { for (const [ctx, meter] of (window as any).__sfuMeters as Map<AudioContext, AnalyserNode>) if (ctx.state === 'running') { const data = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(data); total += data.reduce((s, v) => s + v * v, 0) / data.length; } await new Promise(r => setTimeout(r, 30)); } return Math.sqrt(total / 10); }); }
  try {
    await expect.poll(state, { timeout: 45000 }).toMatchObject({ active: 'strong', status: 'ready' });
    await expect.poll(rms, { timeout: 45000 }).toBeGreaterThan(.004);
    const received = await rms();
    await page.evaluate(() => (window as any).__sfuFixture.sender.transport.setMuted(true)); await expect.poll(rms).toBeLessThan(.000001);
    await page.evaluate(async () => { const device = (await navigator.mediaDevices.enumerateDevices()).find(d => d.kind === 'audioinput' && d.deviceId !== 'default'); if (!device) throw Error('Missing fixture device'); await (window as any).__sfuFixture.sender.transport.setDevice(device.deviceId); });
    await expect.poll(state).toMatchObject({ active: 'strong', status: 'ready' }); await expect.poll(rms).toBeLessThan(.000001);
    await page.evaluate(() => (window as any).__sfuFixture.sender.transport.setMuted(false)); await expect.poll(rms).toBeGreaterThan(.004);
    await page.evaluate(async () => { const { sender, channelId } = (window as any).__sfuFixture; await sender.transport.leave(); await sender.transport.join(channelId); });
    await expect.poll(state).toMatchObject({ active: 'strong', status: 'ready' }); await expect.poll(rms, { timeout: 45000 }).toBeGreaterThan(.004);
    const errors = await page.evaluate(() => (window as any).__sfuErrors); expect(errors).toEqual([]);
    await writeFile('artifacts/evidence/v077-strong-sfu.json', JSON.stringify({ transport: 'livekit', boostDb: 30, receivedRms: received, state: await state(), syntheticSpeechReceived: true, muteSilence: true, mutedCaptureRestart: true, rejoin: true, errors, fixture: 'isolated local database and temporary SFU rooms; application media adapters' }, null, 2));
  } finally { await page.evaluate(async () => { for (const value of Object.values((window as any).__sfuFixture) as any[]) if (value?.transport) { await value.transport.destroy(); value.socket.disconnect(); } }); }
});
