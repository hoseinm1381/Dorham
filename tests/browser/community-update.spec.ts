import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
test.use({ trace: 'off', video: 'off' });
const suffix = () => Date.now().toString().slice(-8);
async function api(page: Page, route: string, body?: object, method = body ? 'POST' : 'GET') {
  return page.evaluate(async ({ route, body, method }) => {
    const auth = await (await fetch('/api/v1/auth/me')).json();
    const response = await fetch(`/api/v1${route}`, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrf }, body: body ? JSON.stringify({ requestId: crypto.randomUUID(), ...body }) : undefined });
    if (!response.ok) throw Error(`API ${response.status}`); return response.json();
  }, { route, body, method });
}
async function acceptRecovery(page: Page) {
  const popup = page.getByRole('dialog', { name: 'Protect your account' }); await expect(popup).toBeVisible();
  expect((await popup.locator('pre').innerText()).trim().split('\n')).toHaveLength(8);
  await expect(popup.getByRole('button', { name: 'Continue to Dorham' })).toBeDisabled();
  await popup.getByLabel('I have saved my recovery codes').check(); await popup.getByRole('button', { name: 'Continue to Dorham' }).click(); await expect(popup).toBeHidden();
}
async function register(page: Page, name: string) {
  await page.goto('/'); await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill(name); await page.getByLabel('Username', { exact: true }).fill(name); await page.getByLabel('Password', { exact: true }).fill('correct-horse-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click(); await acceptRecovery(page);
}
async function screenshot(page: Page, name: string) { await mkdir('artifacts/evidence', { recursive: true }); await page.screenshot({ path: `artifacts/evidence/v076-${name}.png`, fullPage: true }); }

test('DM discovery is explicit, empty chats stay hidden and live received messages reorder both lists', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext(), page = await a.newPage(), other = await b.newPage(), run = suffix();
  try {
    await register(page, `Alice${run}`); await register(other, `Bob${run}`);
    const c = await (await page.request.post('/api/v1/auth/register', { headers: { 'X-Dorham-Native': '1' }, data: { username: `Claire${run}`, displayName: `Claire${run}`, password: 'correct-horse-123', requestId: crypto.randomUUID() } })).json();
    const me = await api(page, '/auth/me'); await expect(page.getByRole('heading', { name: 'Start a conversation', exact: true })).toBeVisible();
    await expect(page.locator('.dm-item')).toHaveCount(0); await expect(page.locator('.home-content')).not.toContainText(`Bob${run}`); await screenshot(page, 'dm-empty');
    await page.getByRole('button', { name: 'New direct message', exact: true }).first().click(); await page.getByRole('dialog').getByRole('button').filter({ hasText: `Bob${run}` }).click();
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible(); await expect(page.locator('.dm-item')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('First hello'); await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('.dm-item')).toContainText(`Bob${run}`); await expect(other.locator('.dm-item')).toContainText(`Alice${run}`);
    await page.getByRole('button', { name: 'New direct message', exact: true }).first().click();
    const picker = page.getByRole('dialog', { name: 'Start a conversation.' });
    await expect(picker.getByRole('button').filter({ hasText: `Bob${run}` })).toContainText('Already chatted');
    await expect(picker.getByRole('button').filter({ hasText: `Claire${run}` })).not.toContainText('Already chatted');
    await screenshot(page, 'dm-picker-indicator');
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    const ac = await api(page, '/dms', { userId: c.user.id }); await expect(page.locator('.dm-item')).toHaveCount(1);
    const send = await page.request.post('/api/v1/messages', { headers: { Authorization: `Bearer ${c.accessToken}` }, data: { conversationId: ac.id, content: 'New from Claire', requestId: crypto.randomUUID() } }); expect(send.ok()).toBe(true);
    await expect(page.locator('.dm-item').first()).toContainText(`Claire${run}`);
    const ab = (await api(other, '/bootstrap')).dms.find((dm: any) => dm.user.id === me.user.id);
    await api(other, '/messages', { conversationId: ab.id, content: 'Latest from Bob' }); await expect(page.locator('.dm-item').first()).toContainText(`Bob${run}`);
    await page.reload(); await expect(page.getByRole('dialog', { name: 'Protect your account' })).toBeHidden(); await expect(page.locator('.dm-item').first()).toContainText(`Bob${run}`);
    await expect(page.locator('.dm-conversation')).toHaveCount(2); await screenshot(page, 'dm-recent');
    await page.setViewportSize({ width: 390, height: 844 }); await screenshot(page, 'dm-mobile');
  } finally { await a.close(); await b.close(); }
});

test('guest invitation opens its destination directly including the last allowed join', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext(), page = await a.newPage(), guest = await b.newPage();
  try {
    await register(page, `Invite${suffix()}`); const server = await api(page, '/servers', { name: 'Guest destination' });
    const target = await api(page, `/servers/${server.id}/channels`, { name: 'welcome-here', kind: 'text' });
    const link = await api(page, `/servers/${server.id}/invites`, { channelId: target.id, uses: 1 });
    await guest.goto(`/?invite=${link.code}`); await expect(guest.getByLabel('Guest display name')).toBeVisible(); await guest.getByLabel('Guest display name').fill('Invited guest'); await guest.getByRole('button', { name: 'Continue as guest', exact: true }).click();
    await expect(guest.getByRole('heading', { name: 'Welcome to #welcome-here' })).toBeVisible(); await expect(guest.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    await expect(guest.locator('.space-heading')).toContainText('Guest destination'); await expect(guest).toHaveURL('/'); await screenshot(guest, 'guest-landing');
    const voice = (await api(page, '/bootstrap')).channels.find((channel: any) => channel.serverId === server.id && channel.kind === 'voice');
    const voiceInvite = await api(page, `/servers/${server.id}/invites`, { channelId: voice.id, uses: 1 }); await b.clearCookies(); await guest.goto(`/?invite=${voiceInvite.code}`);
    await guest.getByLabel('Guest display name').fill('Voice guest'); await guest.getByRole('button', { name: 'Continue as guest', exact: true }).click();
    await expect(guest.locator('.invite-voice-landing')).toContainText('Invited to Lounge'); await expect(guest.getByRole('button', { name: 'Join voice', exact: true })).toBeVisible(); await expect(guest.locator('.voice-panel')).toHaveCount(0);
  } finally { await a.close(); await b.close(); }
});

test('legacy account recovery popup preserves saved codes and remains dismissed across reload', async ({ page }) => {
  await page.goto('/'); const name = `Legacy${suffix()}`;
  const registration = await (await page.request.post('/api/v1/auth/register', { data: { username: name, displayName: name, password: 'correct-horse-123', requestId: crypto.randomUUID() } })).json();
  await page.reload(); const popup = page.getByRole('dialog', { name: 'Protect your account' }); await expect(popup).toBeVisible();
  await expect(popup.locator('pre')).toHaveCount(0); await popup.getByText('How to reset your password', { exact: true }).click(); await expect(popup).toContainText('one unused recovery code');
  await popup.getByRole('button', { name: 'I already saved my codes' }).click(); await expect(popup).toBeHidden(); await page.reload(); await expect(popup).toBeHidden();
  expect((await api(page, '/auth/recovery')).codesRemaining).toBe(registration.recoveryCodes.length);
});

test('signed-in recovery popup resets a forgotten password and generates codes with the new password', async ({ page }) => {
  await page.goto('/'); const name = `Forgot${suffix()}`;
  await page.request.post('/api/v1/auth/register', { data: { username: name, displayName: name, password: 'forgotten-original-password', requestId: crypto.randomUUID() } });
  await page.reload(); const popup = page.getByRole('dialog', { name: 'Protect your account' }); await expect(popup).toBeVisible();
  await popup.getByText('Reset password while signed in', { exact: true }).click();
  const reset = popup.locator('.signed-in-password-reset'); await expect(reset.getByLabel('Current password', { exact: true })).toHaveCount(0);
  await reset.getByLabel('New password', { exact: true }).fill('remembered-new-password'); await reset.getByRole('button', { name: 'Save new password' }).click();
  await expect(reset.getByRole('status')).toContainText('Password updated.'); await screenshot(page, 'signed-in-reset');
  await popup.getByLabel('Current password', { exact: true }).fill('remembered-new-password'); await popup.getByRole('button', { name: 'Generate recovery codes', exact: true }).click();
  await popup.getByLabel('I have saved my recovery codes').check(); await popup.getByRole('button', { name: 'Continue to Dorham' }).click();
  await page.getByRole('button', { name: 'Account settings', exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill(name); await page.getByLabel('Password', { exact: true }).fill('remembered-new-password');
  await page.getByRole('button', { name: 'Let’s get you in', exact: true }).click(); await expect(page.locator('.app')).toBeVisible();
});

test('screen presets are a popup, advanced controls are independent and cancelling does not capture', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__captures = 0; navigator.mediaDevices.getDisplayMedia = async () => { (window as any).__captures++; throw new DOMException('Cancelled', 'NotAllowedError'); };
  });
  await register(page, `Share${suffix()}`); await api(page, '/servers', { name: 'Sharing lab' }); await page.getByRole('button', { name: 'Open Sharing lab', exact: true }).click(); await page.getByRole('button', { name: 'Lounge', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Share screen', exact: true })).toBeEnabled(); await expect(page.getByLabel('Screen bandwidth', { exact: true })).toHaveCount(0); await expect(page.getByText('Share sound', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Share screen', exact: true }).click(); const popup = page.getByRole('dialog', { name: 'Screen sharing', exact: true }); await expect(popup).toBeVisible();
  for (const name of ['Save data', 'Balanced', 'High quality']) await expect(popup.getByRole('button').filter({ hasText: name }).first()).toBeVisible();
  await popup.getByRole('button').filter({ hasText: 'Save data' }).click(); await popup.getByRole('button', { name: 'Advanced', exact: true }).click();
  await popup.getByLabel('Screen resolution', { exact: true }).selectOption('720'); await popup.getByLabel('Screen FPS', { exact: true }).selectOption('15'); await popup.getByLabel('Screen bandwidth', { exact: true }).selectOption('300000');
  await screenshot(page, 'share-popup'); await popup.getByRole('button', { name: 'Close dialog', exact: true }).click(); expect(await page.evaluate(() => (window as any).__captures)).toBe(0);
  await page.getByRole('button', { name: 'Share screen', exact: true }).click(); await popup.getByRole('button', { name: 'Choose screen', exact: true }).click(); await expect.poll(() => page.evaluate(() => (window as any).__captures)).toBe(1); await expect(popup).toBeVisible();
});

test('server icon updates immediately and microphone boost requires opt-in with a safe return to the normal range', async ({ page }) => {
  await register(page, `Settings${suffix()}`); const server = await api(page, '/servers', { name: 'Icon and audio' });
  await page.getByRole('button', { name: 'Open Icon and audio', exact: true }).click(); await page.locator('.space-heading').click();
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#886ef0' } }).png().toBuffer();
  await page.getByLabel('Change server icon', { exact: true }).setInputFiles({ name: 'server.png', mimeType: 'image/png', buffer: image });
  await expect(page.getByRole('button', { name: 'Open Icon and audio', exact: true }).locator('img')).toBeVisible(); await screenshot(page, 'server-icon');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click(); await page.getByRole('button', { name: 'Account settings', exact: true }).click(); await page.getByRole('tab', { name: 'Audio', exact: true }).click(); await page.locator('.audio-advanced > summary').click();
  const gain = page.getByRole('slider', { name: 'Microphone volume', exact: true }), boost = page.getByLabel('Allow microphone boost up to +45 dB', { exact: true });
  await expect(gain).toHaveAttribute('max', '250'); await expect(boost).not.toBeChecked();
  await boost.check(); await expect(gain).toHaveAttribute('max', '45'); await gain.fill('30'); await expect(page.locator('.microphone-gain output').first()).toHaveText('+30.0 dB');
  expect(await page.evaluate(() => Number(localStorage.getItem('dorham.microphoneGain.v1')))).toBeCloseTo(10 ** 1.5);
  await expect(page.locator('.boost-warning')).toBeVisible(); await page.getByLabel('Voice clarity', { exact: true }).uncheck(); await screenshot(page, 'audio-boost');
  await boost.uncheck(); await expect(gain).toHaveValue('250'); await page.getByRole('button', { name: 'Close dialog', exact: true }).click(); await page.reload();
  await page.getByRole('button', { name: 'Account settings', exact: true }).click(); await page.getByRole('tab', { name: 'Audio', exact: true }).click(); await page.locator('.audio-advanced > summary').click(); await expect(boost).not.toBeChecked(); await expect(gain).toHaveValue('250'); await expect(page.getByLabel('Voice clarity', { exact: true })).not.toBeChecked();
  expect((await api(page, '/bootstrap')).servers.find((s: any) => s.id === server.id).icon).toMatch(/^\/avatars\//);
});

test('real Web Audio clarity removes rumble, bypass preserves amplitude and +30 dB gain reaches its actual output', async ({ page }) => {
  const bundle = await build({ entryPoints: ['packages/media/src/voice-clarity.ts'], bundle: true, write: false, outdir: 'unused', format: 'iife', globalName: 'DSP', platform: 'browser' });
  await page.goto('about:blank'); for (const file of bundle.outputFiles!) await page.addScriptTag({ content: file.text });
  const gainBundle = await build({ entryPoints: ['packages/media/src/microphone-gain.ts'], bundle: true, write: false, format: 'iife', globalName: 'GainDSP', platform: 'browser' });
  await page.addScriptTag({ content: gainBundle.outputFiles![0].text });
  const results = await page.evaluate(async () => {
    const sampleRate = 48000, frames = 24000;
    async function rendered(frequency: number, enabled: boolean) {
      const ctx = new OfflineAudioContext(1, frames, sampleRate), source = ctx.createOscillator(); source.frequency.value = frequency;
      const graph = new (window as any).DSP.VoiceClarity(ctx, source, ctx.destination); graph.setEnabled(enabled); source.start();
      const buffer = (await ctx.startRendering()).getChannelData(0); const values = buffer.slice(8000); const rms = Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length); graph.destroy(); return rms;
    }
    const rumbleOff = await rendered(30, false), rumbleOn = await rendered(30, true), speechOff = await rendered(2500, false), speechOn = await rendered(2500, true);
    const ctx = new AudioContext(), osc = ctx.createOscillator(), quiet = ctx.createGain(), capture = ctx.createMediaStreamDestination(); quiet.gain.value = 0.001; osc.frequency.value = 500; osc.connect(quiet).connect(capture); osc.start();
    const processor = new (window as any).GainDSP.MicrophoneGain(); await processor.init({ track: capture.stream.getAudioTracks()[0], audioContext: ctx });
    const source = ctx.createMediaStreamSource(new MediaStream([processor.processedTrack])), meter = ctx.createAnalyser(); meter.fftSize = 2048; source.connect(meter); const samples = new Float32Array(2048);
    async function level() { await new Promise(r => setTimeout(r, 200)); meter.getFloatTimeDomainData(samples); return Math.sqrt(samples.reduce((s, v) => s + v * v, 0) / samples.length); }
    const base = await level(); processor.setGain(10 ** (30 / 20)); const boosted = await level(); processor.setEnabled(false); const muted = await level();
    await processor.destroy(); osc.stop(); capture.stream.getTracks().forEach(t => t.stop()); await ctx.close();
    return { rumbleRatio: rumbleOn / rumbleOff, presenceRatio: speechOn / speechOff, gainRatio: boosted / base, muted };
  });
  expect(results.rumbleRatio).toBeLessThan(0.2); expect(results.presenceRatio).toBeGreaterThan(1.2); expect(results.presenceRatio).toBeLessThan(1.3); expect(results.gainRatio).toBeGreaterThan(30); expect(results.gainRatio).toBeLessThan(33); expect(results.muted).toBeLessThan(0.00001);
  await mkdir('artifacts/evidence', { recursive: true }); await writeFile('artifacts/evidence/v076-audio-measurements.json', JSON.stringify(results, null, 2));
});

test('boost noise filter suppresses low-level background, preserves speech, bypasses and supports quiet microphones', async ({ page }) => {
  const bundle = await build({ entryPoints: ['packages/media/src/boost-noise-filter.ts'], bundle: true, write: false, format: 'iife', globalName: 'NoiseDSP', platform: 'browser' });
  await page.goto('about:blank'); await page.addScriptTag({ content: bundle.outputFiles![0].text });
  const measured = await page.evaluate(async () => {
    async function render(amplitude: number, enabled: boolean, threshold = -70) {
      const ctx = new OfflineAudioContext(1, 48000, 48000), osc = ctx.createOscillator(), source = ctx.createGain(); osc.frequency.value = 440; source.gain.value = amplitude;
      osc.connect(source); const filter = new (window as any).NoiseDSP.BoostNoiseFilter(ctx, source, ctx.destination); filter.configure(enabled, threshold); osc.start();
      const samples = (await ctx.startRendering()).getChannelData(0).slice(24000); filter.destroy(); return Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
    }
    return { noiseRatio: await render(0.00001, true) / await render(0.00001, false), speechRatio: await render(0.002, true) / await render(0.002, false), quietVoiceRatio: await render(0.00005, true, -90) / await render(0.00005, false) };
  });
  expect(measured.noiseRatio).toBeLessThan(0.02); expect(measured.speechRatio).toBeGreaterThan(0.98); expect(measured.speechRatio).toBeLessThan(1.02); expect(measured.quietVoiceRatio).toBeGreaterThan(0.98);
  await mkdir('artifacts/evidence', { recursive: true }); await writeFile('artifacts/evidence/v076-noise-filter.json', JSON.stringify(measured, null, 2));
});
