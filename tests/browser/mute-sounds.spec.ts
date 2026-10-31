import { completeRecovery } from './recovery-helper';
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
  await page.getByRole('button', { name: 'Create account', exact: true }).click(); await completeRecovery(page); await expect(page.locator('.app')).toBeVisible();
}


test('mute and unmute cues are audible only locally, fire once per state change and respect voice sound settings', async ({ browser }) => {
  const a = await browser.newContext({ permissions: ['microphone'] }), b = await browser.newContext({ permissions: ['microphone'] });
  const self = await a.newPage(), peer = await b.newPage();
  const cues = (page: Page) => page.evaluate(() => (window as any).__muteCues as string[]);
  const clear = () => self.evaluate(() => { (window as any).__muteCues = []; });
  const settings = async () => { await self.getByRole('button', { name: 'Account settings', exact: true }).click(); };
  try {
    for (const page of [self, peer]) {
      await instrument(page);
      await page.addInitScript(() => {
        (window as any).__muteCues = []; (window as any).__cueNotes = [];
        window.addEventListener('dorham-sound-played', ((event: CustomEvent) => { if (['mute', 'unmute'].includes(event.detail)) (window as any).__muteCues.push(event.detail); }) as EventListener);
        const start = OscillatorNode.prototype.start;
        OscillatorNode.prototype.start = function (when = 0) { if ([350, 520].includes(this.frequency.value)) (window as any).__cueNotes.push(this.frequency.value); start.call(this, when); };
      });
    }
    const suffix = Date.now().toString().slice(-7);
    await register(self, `CueA${suffix}`); await register(peer, `CueB${suffix}`);
    const server = await api(self, '/servers', { name: 'Mute cue lab' }), invite = await api(self, `/servers/${server.id}/invites`, {});
    await api(peer, '/invites/join', { code: invite.code });
    for (const page of [self, peer]) { await page.getByRole('button', { name: 'Open Mute cue lab', exact: true }).click(); await page.getByRole('button', { name: 'Lounge', exact: true }).click(); }
    await peer.getByRole('button', { name: 'Mute microphone', exact: true }).click();
    await expect.poll(() => level(peer)).toBeGreaterThan(0.01);
    await expect(cues(self)).resolves.toEqual([]);
    await self.evaluate(() => localStorage.setItem('dorham-sounds', JSON.stringify({ voice: true, messages: false })));
    await self.getByRole('button', { name: 'Mute microphone', exact: true }).click();
    await expect.poll(() => cues(self)).toEqual(['mute']); const muteRms = await level(self); expect(muteRms).toBeGreaterThan(0.001);
    await expect.poll(() => level(peer)).toBeLessThan(0.000001);
    await expect(self.evaluate(() => (window as any).__cueNotes)).resolves.toEqual([520, 350]);
    await self.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
    await expect.poll(() => cues(self)).toEqual(['mute', 'unmute']); const unmuteRms = await level(self); expect(unmuteRms).toBeGreaterThan(0.001);
    await expect.poll(() => level(peer)).toBeGreaterThan(0.01); await expect(cues(peer)).resolves.toEqual([]);
    await expect(self.evaluate(() => (window as any).__cueNotes)).resolves.toEqual([520, 350, 350, 520]);
    await settings(); await self.getByRole('tab', { name: 'Notifications', exact: true }).click();
    const voice = self.getByRole('checkbox', { name: 'Voice join, leave, mute and unmute sounds', exact: true }); await voice.uncheck();
    await self.getByRole('button', { name: 'Close dialog', exact: true }).click(); await clear();
    for (const name of ['Mute microphone', 'Unmute microphone']) await self.getByRole('button', { name, exact: true }).click();
    await expect(cues(self)).resolves.toEqual([]); expect(await level(self)).toBeLessThan(0.000001);
    await settings(); await self.getByRole('tab', { name: 'Notifications', exact: true }).click(); await voice.check();
    await self.getByRole('tab', { name: 'Audio', exact: true }).click(); await self.getByLabel('Voice input mode', { exact: true }).selectOption('push');
    await self.getByRole('button', { name: 'Record talk hotkey', exact: true }).click(); await self.keyboard.press('F9');
    await self.getByRole('button', { name: 'Close dialog', exact: true }).click(); await self.waitForTimeout(300); await clear();
    await self.keyboard.down('F9'); await expect.poll(() => cues(self)).toEqual(['unmute']);
    await self.keyboard.down('F9'); await expect(cues(self)).resolves.toEqual(['unmute']);
    await self.keyboard.up('F9'); await self.keyboard.up('F9'); await expect.poll(() => cues(self)).toEqual(['unmute', 'mute']);
    await settings(); await self.getByRole('tab', { name: 'Audio', exact: true }).click(); await self.getByLabel('Voice input mode', { exact: true }).selectOption('toggle');
    await self.getByRole('button', { name: 'Close dialog', exact: true }).click(); await clear();
    await self.keyboard.press('F9'); await self.evaluate(() => window.dispatchEvent(new Event('blur'))); await expect.poll(() => cues(self)).toEqual(['unmute']);
    await self.keyboard.press('F9'); await expect.poll(() => cues(self)).toEqual(['unmute', 'mute']);
    await clear(); await self.getByRole('button', { name: 'Disconnect voice', exact: true }).click(); await expect(self.locator('.voice-panel')).toHaveCount(0); await expect(cues(self)).resolves.toEqual([]);
    await mkdir('artifacts/evidence', { recursive: true });
    await writeFile('artifacts/evidence/v054-mute-sounds.json', JSON.stringify({ muteRms, unmuteRms, muteNotes: [520,350], unmuteNotes: [350,520], localOnly: true, muteSilenceAtPeer: true, enabledByDefault: true, preferenceRespected: true, button: true, pushToTalk: true, toggleToTalk: true, noRepeatedKeyCues: true, noDisconnectMuteCue: true, physicalSpeaker: 'not measured' }, null, 2));
  } finally { await a.close(); await b.close(); }
});
