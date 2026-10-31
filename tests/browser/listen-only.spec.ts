import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { completeRecovery } from './recovery-helper';
test.use({ trace: 'off', video: 'off' });
async function api(page: Page, route: string, body?: object) {
  return page.evaluate(async ({ route, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json();
    const response = await fetch('/api/v1' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf }, body: body ? JSON.stringify({ requestId: crypto.randomUUID(), ...body }) : undefined });
    if (!response.ok) throw new Error(`API ${response.status}`); return response.json();
  }, { route, body });
}
async function register(page: Page, name: string) {
  await page.goto('/'); await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill(name); await page.getByLabel('Username', { exact: true }).fill(name);
  await page.getByLabel('Password', { exact: true }).fill('listen-only-test-fixture');
  await page.getByRole('button', { name: 'Create account', exact: true }).click(); await completeRecovery(page);
  await expect(page.locator('.app')).toBeVisible();
}
async function level(page: Page) {
  return page.evaluate(async () => {
    let sum = 0;
    for (let i = 0; i < 6; i++) {
      for (const [context, meter] of (window as any).__listenMeters as Map<AudioContext, AnalyserNode>) if (context.state === 'running') {
        const samples = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(samples);
        sum += samples.reduce((a, b) => a + b * b, 0) / samples.length;
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    return Math.sqrt(sum / 6);
  });
}
for (const failure of ['NotFoundError', 'NotAllowedError', 'UnavailableAPI']) test(`receives decoded voice without microphone: ${failure}`, async ({ browser }) => {
  test.setTimeout(120000);
  const a = await browser.newContext(), b = await browser.newContext(), sender = await a.newPage(), receiver = await b.newPage();
  try {
    await sender.addInitScript(() => {
      localStorage.setItem('dorham-sounds', JSON.stringify({ voice: false, messages: false }));
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain(), output = context.createMediaStreamDestination();
        oscillator.frequency.value = 440; gain.gain.value = 0.04; oscillator.connect(gain).connect(output); oscillator.start(); await context.resume();
        output.stream.getAudioTracks()[0].addEventListener('ended', () => { oscillator.stop(); void context.close(); }); return output.stream;
      };
    });
    await receiver.addInitScript(({ failure }) => {
      localStorage.setItem('dorham-sounds', JSON.stringify({ voice: false, messages: false }));
      (window as any).__micRequests = 0;
      if (failure === 'UnavailableAPI') Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: undefined });
      else navigator.mediaDevices.getUserMedia = async () => { (window as any).__micRequests++; throw new DOMException('Synthetic microphone failure', failure); };
      const meters = new Map<AudioContext, AnalyserNode>(); (window as any).__listenMeters = meters;
      const connect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (destination: any, ...args: any[]): any {
        if (destination === this.context.destination) {
          let meter = meters.get(this.context as AudioContext);
          if (!meter) { meter = this.context.createAnalyser(); meter.fftSize = 2048; meters.set(this.context as AudioContext, meter); }
          (connect as any).call(this, meter);
        }
        return (connect as any).call(this, destination, ...args);
      };
    }, { failure });
    const suffix = Date.now().toString().slice(-8);
    await register(sender, 'Talk' + suffix); await register(receiver, 'Hear' + suffix);
    const server = await api(sender, '/servers', { name: 'Listen lab' }), invite = await api(sender, `/servers/${server.id}/invites`, {});
    await api(receiver, '/invites/join', { code: invite.code });
    for (const page of [sender, receiver]) { await page.getByRole('button', { name: 'Open Listen lab', exact: true }).click(); await page.getByRole('button', { name: 'Lounge', exact: true }).click(); }
    await expect(receiver.locator('.voice-panel')).toContainText('Listening only');
    await expect(receiver.getByRole('button', { name: 'Microphone unavailable. Rejoin to try again.', exact: true })).toBeDisabled();
    await expect.poll(() => level(receiver), { timeout: 45000 }).toBeGreaterThan(0.005);
    await receiver.waitForTimeout(5500); const heard = await level(receiver); expect(heard).toBeGreaterThan(0.005);
    await receiver.getByRole('button', { name: 'Deafen', exact: true }).click(); await expect.poll(() => level(receiver)).toBeLessThan(0.000001);
    await receiver.getByRole('button', { name: 'Undeafen', exact: true }).click(); await expect.poll(() => level(receiver)).toBeGreaterThan(0.005);
    expect(await receiver.evaluate(() => (window as any).__micRequests)).toBe(failure === 'UnavailableAPI' ? 0 : 1);
    await receiver.getByRole('button', { name: 'Disconnect voice', exact: true }).click(); await expect(receiver.locator('.voice-panel')).toHaveCount(0);
    await receiver.getByRole('button', { name: 'Lounge', exact: true }).click(); await expect.poll(() => level(receiver)).toBeGreaterThan(0.005);
    const transport = (await api(receiver, '/bootstrap')).mediaTransport;
    await receiver.screenshot({ path: `artifacts/evidence/v101-listen-only-${transport}-${failure}.png` });
    await writeFile(`artifacts/evidence/v101-listen-only-${transport}-${failure}.json`, JSON.stringify({ transport, failure, decodedAudio: true, rms: heard, heartbeatSurvived: true, deafen: true, rejoin: true, noRepeatedPermissionRequests: true }, null, 2));
  } finally { await a.close(); await b.close(); }
});

test('native sign-in and registration hide server address', async ({ page }) => {
  await page.addInitScript(() => { (window as any).desktop = { getServer: async () => location.origin, getSecret: async () => null, configureVoiceHotkey: async () => ({}), onVoiceHotkey: () => () => {} }; });
  await page.goto('/'); await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Server address', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await expect(page.getByLabel('Display name', { exact: true })).toBeVisible(); await expect(page.locator('input[type=url]')).toHaveCount(0);
});
