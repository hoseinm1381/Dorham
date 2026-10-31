import { completeRecovery } from './recovery-helper';
import { test, expect, type Page } from '@playwright/test';
import { RoomServiceClient } from 'livekit-server-sdk';
import { mkdir, writeFile } from 'node:fs/promises';

async function api(page: Page, route: string, body?: object) {
  return page.evaluate(async ({ route, body }) => {
    const auth = await (await fetch('/api/v1/auth/me')).json();
    const r = await fetch('/api/v1' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrf }, body: body ? JSON.stringify({ requestId: crypto.randomUUID(), ...body }) : undefined });
    if (!r.ok) throw new Error(`API ${r.status}`); return r.json();
  }, { route, body });
}
async function register(page: Page, name: string) {
  await page.goto('/'); await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill(name); await page.getByLabel('Username', { exact: true }).fill(name); await page.getByLabel('Password', { exact: true }).fill('fixture-password-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click(); await completeRecovery(page); await expect(page.getByRole('heading', { name: `Hey, ${name}.` })).toBeVisible();
}
async function instrument(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('dorham-sounds', JSON.stringify({ voice: false, messages: false }));
    // Feed a constant tone into the actual product peer connection. Meter all
    // real destination edges after their gain; do not infer audibility from a
    // stored slider value or inbound RTP energy before playback controls.
    const monitors = new Map<AudioContext, AnalyserNode>(); (window as any).__outputMonitors = monitors;
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function(destination: any, ...args: any[]): any {
      if (destination === this.context.destination) {
        let analyser = monitors.get(this.context as AudioContext);
        if (!analyser) { analyser = (this.context as AudioContext).createAnalyser(); analyser.fftSize = 2048; monitors.set(this.context as AudioContext, analyser); }
        (connect as any).call(this, analyser, args[0] ?? 0, 0);
      }
      return (connect as any).call(this, destination, ...args);
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext(), oscillator = ctx.createOscillator(), gain = ctx.createGain(), output = ctx.createMediaStreamDestination();
      oscillator.frequency.value = 440; gain.gain.value = 0.08; oscillator.connect(gain).connect(output); oscillator.start(); await ctx.resume();
      output.stream.getAudioTracks()[0].addEventListener('ended', () => { oscillator.stop(); void ctx.close(); }); return output.stream;
    };
  });
}
async function level(page: Page) {
  return page.evaluate(async () => {
    let sum = 0;
    for (let n = 0; n < 12; n++) {
      let energy = 0;
      for (const [ctx, analyser] of (window as any).__outputMonitors as Map<AudioContext, AnalyserNode>) {
        if (ctx.state !== 'running') continue;
        const buffer = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(buffer);
        energy += buffer.reduce((s, v) => s + v * v, 0) / buffer.length;
      }
      sum += energy; await new Promise(resolve => setTimeout(resolve, 25));
    }
    return Math.sqrt(sum / 12);
  });
}
test('real output gain changes at 0/50/100/200 percent and deafen restores the chosen level', async ({ browser }) => {
  test.setTimeout(120000);
  const a = await browser.newContext({ permissions: ['microphone'] }), b = await browser.newContext({ permissions: ['microphone'] });
  const first = await a.newPage(), second = await b.newPage(), suffix = Date.now().toString().slice(-7); let fixtureRoom: string | undefined;
  try {
    for (const page of [first, second]) await instrument(page);
    await register(first, `GainA${suffix}`); await register(second, `GainB${suffix}`);
    const server = await api(first, '/servers', { name: 'Audio output lab' }), invite = await api(first, `/servers/${server.id}/invites`, {});
    fixtureRoom = (await api(first, '/bootstrap')).channels.find((c: any) => c.serverId === server.id && c.kind === 'voice').id;
    await api(second, '/invites/join', { code: invite.code });
    for (const page of [first, second]) { await page.getByRole('button', { name: 'Open Audio output lab', exact: true }).click(); await page.getByRole('button', { name: 'Lounge', exact: true }).click(); }
    await expect.poll(() => level(second), { timeout: 40000 }).toBeGreaterThan(0.045);
    await second.getByRole('button', { name: 'Voice controls', exact: true }).click();
    const slider = second.getByRole('slider'); const full = await level(second); expect(full).toBeGreaterThan(0.045);
    await slider.fill('50'); await expect.poll(async () => (await level(second)) / full).toBeCloseTo(0.5, 1); const half = await level(second); expect(half / full).toBeLessThan(0.56);
    await slider.fill('0'); await expect.poll(() => level(second)).toBeLessThan(0.000001);
    await slider.fill('200'); await expect.poll(async () => (await level(second)) / full).toBeGreaterThan(1.8); const doubled = await level(second); expect(doubled / full).toBeLessThan(2.2);
    await slider.fill('50'); await second.getByRole('button', { name: 'Deafen', exact: true }).click(); await expect.poll(() => level(second)).toBeLessThan(0.000001);
    // Changing volume while deafened must remain silent.
    await slider.fill('100'); expect(await level(second)).toBeLessThan(0.000001);
    await first.getByRole('button', { name: 'Disconnect voice', exact: true }).click();
    await expect(second.locator('.voice-mini-members button')).toHaveCount(1);
    await first.getByRole('button', { name: 'Lounge', exact: true }).click();
    await expect(second.locator('.voice-mini-members button')).toHaveCount(2);
    await expect.poll(() => level(second)).toBeLessThan(0.000001);
    await second.getByRole('button', { name: 'Undeafen', exact: true }).click(); await expect.poll(async () => (await level(second)) / full).toBeGreaterThan(0.9);
    await expect.poll(() => second.evaluate(() => [...document.querySelectorAll('audio')].every(e => e.muted && e.volume === 0))).toBe(true);
    const transport = (await api(second, '/bootstrap')).mediaTransport;
    await mkdir('artifacts/evidence', { recursive: true }); await writeFile(`artifacts/evidence/audio-output-${transport}.json`, JSON.stringify({ transport, full, half, doubled, deafenSilence: true, volumeZeroSilence: true, restored: true, limitation: 'Synthetic decoded WebRTC through the real destination graph; physical speaker output and acoustic echo are untested.' }, null, 2));
  } finally {
    await a.close(); await b.close();
    if (fixtureRoom && process.env.DORHAM_SFU_ISOLATED_TEST === '1') { const client = new RoomServiceClient(process.env.LIVEKIT_API_URL!, process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!); await client.deleteRoom(fixtureRoom).catch(() => {}); }
  }
});
