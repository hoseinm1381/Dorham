import { test, expect, type Page } from '@playwright/test';
import { completeRecovery } from './recovery-helper';
import { writeFile } from 'node:fs/promises';
test.use({ trace: 'off', video: 'off', actionTimeout: 12000 });
async function api(page: Page, route: string, body?: object) { return page.evaluate(async ({ route, body }) => { const me = await (await fetch('/api/v1/auth/me')).json(), response = await fetch('/api/v1' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf }, body: body ? JSON.stringify({ requestId: crypto.randomUUID(), ...body }) : undefined }); if (!response.ok) throw Error('API ' + response.status); return response.json(); }, { route, body }); }
async function register(page: Page, name: string) { await page.goto('/'); await page.getByRole('button', { name: 'Create an account', exact: true }).click(); await page.getByLabel('Display name', { exact: true }).fill(name); await page.getByLabel('Username', { exact: true }).fill(name); await page.getByLabel('Password', { exact: true }).fill('Speech-fixture-password'); await page.getByRole('button', { name: 'Create account', exact: true }).click(); await completeRecovery(page); }
test('voice-only TTS plays decoded audio, checkbox and command retain text, and outside-voice/deafened clients hear nothing', async ({ browser }) => {
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ permissions: ['microphone'] }))), pages = await Promise.all(contexts.map(c => c.newPage()));
  try {
    for (const page of pages) await page.addInitScript(() => { (window as any).__speech = []; const start = AudioBufferSourceNode.prototype.start; AudioBufferSourceNode.prototype.start = function(...args: any[]) { if (this.buffer) (window as any).__speech.push({ duration: this.buffer.duration, running: this.context.state === 'running', rms: Math.sqrt(this.buffer.getChannelData(0).reduce((n, v) => n + v * v, 0) / this.buffer.length) }); return (start as any).apply(this, args); }; });
    const suffix = Date.now().toString().slice(-6); for (let i = 0; i < 3; i++) await register(pages[i], `Tts${i}${suffix}`);
    const [first, second, outside] = pages, server = await api(first, '/servers', { name: 'Voice TTS lab' }), invite = await api(first, `/servers/${server.id}/invites`, { uses: 10 }); for (const page of [second, outside]) await api(page, '/invites/join', { code: invite.code });
    for (const page of pages) await page.getByRole('button', { name: 'Open Voice TTS lab', exact: true }).click();
    const input = first.getByRole('textbox', { name: 'Message', exact: true }), count = (page: Page) => page.evaluate(() => (window as any).__speech.length);
    await input.fill('/tts normal outside voice'); await first.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(second.getByTestId('message').last()).toContainText('normal outside voice'); expect(await count(second)).toBe(0);
    await api(first, `/servers/${server.id}/channels`, { kind: 'voice', name: 'Elsewhere' }); await outside.getByRole('button', { name: 'Elsewhere', exact: true }).click();
    for (const page of [first, second]) { await page.getByRole('button', { name: 'Lounge', exact: true }).click(); await expect(page.locator('.gaming-voice')).toBeVisible(); }
    await input.fill('/tts سلام friends'); await first.getByRole('button', { name: 'Send message', exact: true }).click(); await expect.poll(() => count(second)).toBe(1); expect(await count(outside)).toBe(0); await expect(second.getByTestId('message').last()).toContainText('سلام friends');
    const decoded = await second.evaluate(() => (window as any).__speech[0]); expect(decoded.running).toBe(true); expect(decoded.rms).toBeGreaterThan(0.02);
    await first.getByRole('checkbox', { name: 'Send as TTS', exact: true }).check(); await input.fill('Hello again'); await first.waitForTimeout(4100); await first.getByRole('button', { name: 'Send message', exact: true }).click(); await expect.poll(() => count(second)).toBe(2);
    await second.getByRole('button', { name: 'Deafen', exact: true }).click(); await first.waitForTimeout(4100); await input.fill('deafened listeners get text'); await first.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(second.getByTestId('message').last()).toContainText('deafened listeners get text'); await second.waitForTimeout(500); expect(await count(second)).toBe(2);
    await first.screenshot({ path: 'artifacts/evidence/v104-voice-tts.png' });
    await writeFile('artifacts/evidence/v104-voice-tts-browser.json', JSON.stringify({ decodedPcm: true, sourceRunning: decoded.running, rms: decoded.rms, sameVoiceOnly: true, outsideVoiceNormalText: true, slashCommand: true, checkbox: true, deafen: true, fixtureSpeech: true, realPiperSeparate: true }, null, 2));
  } finally { await Promise.allSettled(contexts.map(c => c.close())); }
});
