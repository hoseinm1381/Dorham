import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

test.use({ trace: 'off', video: 'off' });
async function api(page: Page, route: string, body?: object) {
  return page.evaluate(async ({ route, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json();
    const response = await fetch('/api/v1' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf }, body: body ? JSON.stringify({ requestId: crypto.randomUUID(), ...body }) : undefined });
    if (!response.ok) throw new Error(`API ${response.status}`); return response.json();
  }, { route, body });
}
async function instrument(page: Page) {
  await page.addInitScript(({ tlsOnly }) => {
    localStorage.setItem('dorham-sounds', JSON.stringify({ voice: false, messages: false }));
    const Peer = RTCPeerConnection; (window as any).__volumePeers = [];
    (window as any).RTCPeerConnection = new Proxy(Peer, { construct(Target, args) {
      const filter = (config: RTCConfiguration) => !tlsOnly ? config : { ...config, iceTransportPolicy: 'relay' as const, iceServers: config.iceServers?.map(server => ({ ...server, urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(url => url.startsWith('turns:')) })).filter(server => server.urls.length) };
      const peer = new Target(filter(args[0] || {})), configure = peer.setConfiguration.bind(peer); peer.setConfiguration = config => configure(filter(config || {})); (window as any).__volumePeers.push(peer); return peer;
    } });
    const meters = new Map<AudioContext, AnalyserNode>(); (window as any).__volumeMeters = meters;
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination: any, ...args: any[]): any {
      if (destination === this.context.destination) {
        let meter = meters.get(this.context as AudioContext);
        if (!meter) { meter = this.context.createAnalyser(); meter.fftSize = 2048; meters.set(this.context as AudioContext, meter); }
        (connect as any).call(this, meter);
      }
      return (connect as any).call(this, destination, ...args);
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain(), output = context.createMediaStreamDestination();
      oscillator.frequency.value = 440; gain.gain.value = 0.04; oscillator.connect(gain).connect(output); oscillator.start(); await context.resume();
      output.stream.getAudioTracks()[0].addEventListener('ended', () => { oscillator.stop(); void context.close(); });
      return output.stream;
    };
  }, { tlsOnly: process.env.DORHAM_AUDIO_TLS_ONLY === '1' });
}
async function level(page: Page) {
  return page.evaluate(async () => {
    let total = 0;
    for (let i = 0; i < 12; i++) {
      for (const [context, meter] of (window as any).__volumeMeters as Map<AudioContext, AnalyserNode>) if (context.state === 'running') {
        const samples = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(samples);
        total += samples.reduce((sum, value) => sum + value * value, 0) / samples.length;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return Math.sqrt(total / 12);
  });
}
async function register(page: Page, name: string) {
  await page.goto('/'); await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill(name); await page.getByLabel('Username', { exact: true }).fill(name);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-volume-fixture');
  await page.getByRole('button', { name: 'Create account', exact: true }).click(); await expect(page.locator('.app')).toBeVisible();
}

async function settings(page: Page) {
  await page.getByRole('button', { name: 'Account settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Audio', exact: true }).click();
}
test('own microphone gain changes transmitted audio at 50–250%, respects mute and survives capture restart, rejoin and reload', async ({ browser }) => {
  test.setTimeout(180000);
  const senderContext = await browser.newContext({ permissions: ['microphone'] }), receiverContext = await browser.newContext({ permissions: ['microphone'] });
  const sender = await senderContext.newPage(), receiver = await receiverContext.newPage();
  try {
    for (const page of [sender, receiver]) await instrument(page);
    const suffix = Date.now().toString().slice(-7);
    await register(sender, `GainA${suffix}`); await register(receiver, `GainB${suffix}`);
    const server = await api(sender, '/servers', { name: 'Microphone gain lab' }), invite = await api(sender, `/servers/${server.id}/invites`, {});
    await api(receiver, '/invites/join', { code: invite.code });
    // Decoded Opus amplitude is checked within 5% relative tolerance.
    // Save before joining to exercise the deferred adapter's initialization.
    await settings(sender); const gain = () => sender.getByRole('slider', { name: 'My microphone gain', exact: true });
    await expect(gain()).toHaveValue('100'); await gain().fill('50');
    await sender.getByRole('button', { name: 'Close dialog', exact: true }).click();
    for (const page of [sender, receiver]) { await page.getByRole('button', { name: 'Open Microphone gain lab', exact: true }).click(); await page.getByRole('button', { name: 'Lounge', exact: true }).click(); }
    await receiver.getByRole('button', { name: 'Mute microphone', exact: true }).click();
    await expect.poll(() => level(receiver), { timeout: 45000 }).toBeGreaterThan(0.005);
    await receiver.waitForTimeout(4000); const initialHalf = await level(receiver); console.log('Settled initial 50% RMS', initialHalf);
    await settings(sender); await gain().fill('100');
    await expect.poll(async () => (await level(receiver)) / initialHalf).toBeCloseTo(2, 1);
    const normal = await level(receiver), measurements: Record<string, number> = {};
    for (const [percent, ratio] of [[50, 0.5], [100, 1], [150, 1.5], [250, 2.5]]) {
      await gain().fill(String(percent)); let measured = 0;
      await expect.poll(async () => { measured = await level(receiver); return measured / normal / ratio; }).toBeCloseTo(1, 1);
      measurements[String(percent)] = measured; console.log('Microphone gain RMS', percent, measured);
    }
    await sender.screenshot({ path: `artifacts/evidence/v053-microphone-gain-settings.png` });
    await sender.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await sender.getByRole('button', { name: 'Mute microphone', exact: true }).click();
    await expect.poll(() => level(receiver)).toBeLessThan(0.000001);
    await settings(sender); await gain().fill('50'); await gain().fill('250');
    await expect.poll(() => level(receiver)).toBeLessThan(0.000001);
    // Switching capture while muted must retain both silence and the saved gain.
    const mic = sender.getByRole('combobox', { name: 'Microphone', exact: true });
    const device = await mic.locator('option').evaluateAll(options => (options as HTMLOptionElement[]).find(option => option.value)?.value);
    if (!device) throw new Error('No synthetic input device for replacement test');
    await mic.selectOption(device); await sender.waitForTimeout(1000);
    await expect.poll(() => level(receiver)).toBeLessThan(0.000001);
    await sender.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await sender.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
    await expect.poll(async () => (await level(receiver)) / normal / 2.5).toBeCloseTo(1, 1);
    await sender.getByRole('button', { name: 'Deafen', exact: true }).click(); await expect.poll(() => level(receiver)).toBeLessThan(0.000001);
    await sender.getByRole('button', { name: 'Undeafen', exact: true }).click(); await expect.poll(async () => (await level(receiver)) / normal / 2.5).toBeCloseTo(1, 1);
    await sender.getByRole('button', { name: 'Disconnect voice', exact: true }).click(); await expect(sender.locator('.voice-panel')).toHaveCount(0);
    await sender.getByRole('button', { name: 'Lounge', exact: true }).click();
    await expect.poll(async () => (await level(receiver)) / normal / 2.5, { timeout: 45000 }).toBeCloseTo(1, 1);
    await sender.reload(); await sender.getByRole('button', { name: 'Open Microphone gain lab', exact: true }).click(); await sender.getByRole('button', { name: 'Lounge', exact: true }).click();
    await expect.poll(async () => (await level(receiver)) / normal / 2.5, { timeout: 45000 }).toBeCloseTo(1, 1);
    await settings(sender); await expect(gain()).toHaveValue('250');
    await sender.getByRole('button', { name: 'Reset microphone gain', exact: true }).click(); await expect(gain()).toHaveValue('100');
    await expect.poll(async () => (await level(receiver)) / normal).toBeCloseTo(1, 1);
    const transport = (await api(receiver, '/bootstrap')).mediaTransport;
    await mkdir('artifacts/evidence', { recursive: true });
    await writeFile(`artifacts/evidence/v053-microphone-gain-${transport}.json`, JSON.stringify({ transport, measurements, savedBeforeJoin: true, muteAndDeafen: true, mutedDeviceReplacement: true, rejoin: true, reload: true, reset: true, source: 'quiet synthetic tone; measured remote decoded WebRTC RMS, no physical acoustic measurement' }, null, 2));
  } finally { await senderContext.close(); await receiverContext.close(); }
});
