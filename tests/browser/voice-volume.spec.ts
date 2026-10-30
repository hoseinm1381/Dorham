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
test('person volume changes decoded audio from silence to real 200% amplification and survives rejoin', async ({ browser }) => {
  test.setTimeout(150000);
  const senderContext = await browser.newContext({ permissions: ['microphone'] }), receiverContext = await browser.newContext({ permissions: ['microphone'] });
  const sender = await senderContext.newPage(), receiver = await receiverContext.newPage();
  try {
    for (const page of [sender, receiver]) await instrument(page);
    const suffix = Date.now().toString().slice(-7), sourceName = `VolumeA${suffix}`;
    await register(sender, sourceName); await register(receiver, `VolumeB${suffix}`);
    const server = await api(sender, '/servers', { name: 'Volume lab' }), invite = await api(sender, `/servers/${server.id}/invites`, {});
    await api(receiver, '/invites/join', { code: invite.code });
    for (const page of [sender, receiver]) { await page.getByRole('button', { name: 'Open Volume lab', exact: true }).click(); await page.getByRole('button', { name: 'Lounge', exact: true }).click(); }
    await receiver.getByRole('button', { name: 'Mute microphone', exact: true }).click();
    await receiver.getByRole('button', { name: 'Voice controls', exact: true }).click();
    const slider = () => receiver.getByRole('slider', { name: `Voice volume for ${sourceName}`, exact: true });
    await expect.poll(() => level(receiver), { timeout: 45000 }).toBeGreaterThan(0.01);
    await receiver.waitForTimeout(800); const normal = await level(receiver), measurements: Record<string, number> = { '100': normal };
    for (const [percent, ratio] of [[50, 0.5], [200, 2], [0, 0], [100, 1]]) {
      await slider().fill(String(percent));
      if (percent === 0) await expect.poll(() => level(receiver)).toBeLessThan(0.000001);
      else await expect.poll(async () => (await level(receiver)) / normal).toBeCloseTo(ratio, 1);
      measurements[String(percent)] = await level(receiver);
    }
    await slider().fill('200'); await expect.poll(async () => (await level(receiver)) / normal).toBeCloseTo(2, 1);
    await receiver.evaluate(async () => { for (const context of (window as any).__volumeMeters.keys()) if (context.state === 'running') await context.suspend(); });
    await slider().fill('100'); await expect.poll(async () => (await level(receiver)) / normal).toBeCloseTo(1, 1);
    await slider().fill('200'); await expect.poll(async () => (await level(receiver)) / normal).toBeCloseTo(2, 1);
    await receiver.getByRole('button', { name: 'Deafen', exact: true }).click(); await expect.poll(() => level(receiver)).toBeLessThan(0.000001);
    await receiver.getByRole('button', { name: 'Undeafen', exact: true }).click(); await expect.poll(async () => (await level(receiver)) / normal).toBeCloseTo(2, 1);
    await receiver.getByRole('button', { name: 'Disconnect voice', exact: true }).click(); await expect(receiver.locator('.voice-panel')).toHaveCount(0); await receiver.getByRole('button', { name: 'Lounge', exact: true }).click();
    await expect.poll(async () => (await level(receiver)) / normal, { timeout: 45000 }).toBeCloseTo(2, 1);
    await receiver.reload(); await receiver.getByRole('button', { name: 'Open Volume lab', exact: true }).click(); await receiver.getByRole('button', { name: 'Lounge', exact: true }).click();
    await receiver.getByRole('button', { name: 'Voice controls', exact: true }).click(); await expect(slider()).toHaveValue('200');
    await expect.poll(async () => (await level(receiver)) / normal, { timeout: 45000 }).toBeCloseTo(2, 1);
    const transport = (await api(receiver, '/bootstrap')).mediaTransport;
    await mkdir('artifacts/evidence', { recursive: true });
    await writeFile(`artifacts/evidence/v052-volume-${transport}.json`, JSON.stringify({ transport, measurements, doubledAmplitude: true, zeroSilent: true, resumesSuspendedPlayback: true, savedAfterReload: true, rejoin: true, deafen: true, source: 'quiet synthetic tone over actual decoded WebRTC; physical output not measured' }, null, 2));
  } catch (error) {
    const details = await receiver.evaluate(async () => {
      const peers = [];
      for (const peer of (window as any).__volumePeers as RTCPeerConnection[]) {
        const stats: any[] = []; if (peer.connectionState !== 'closed') (await peer.getStats()).forEach(report => { if (['inbound-rtp', 'candidate-pair'].includes(report.type)) stats.push(report); });
        peers.push({ state: peer.connectionState, ice: peer.iceConnectionState, stats });
      }
      return { peers, contexts: [...(window as any).__volumeMeters.keys()].map((context: AudioContext) => ({ state: context.state, currentTime: context.currentTime })), audio: [...document.querySelectorAll('audio')].map(audio => ({ paused: audio.paused, muted: audio.muted, volume: audio.volume, tracks: audio.srcObject instanceof MediaStream ? audio.srcObject.getAudioTracks().map(track => ({ enabled: track.enabled, muted: track.muted, state: track.readyState })) : [] })), body: document.body.innerText.slice(-1600) };
    });
    await mkdir('artifacts/evidence', { recursive: true }); await writeFile('artifacts/evidence/v052-volume-failure.json', JSON.stringify(details, null, 2));
    throw error;
  } finally { await senderContext.close(); await receiverContext.close(); }
});
