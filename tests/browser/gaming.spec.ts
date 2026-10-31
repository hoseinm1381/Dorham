import { completeRecovery, chooseScreen } from './recovery-helper';
import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import fa from '../../apps/web/src/locales/fa-IR.json' with { type: 'json' };
test.use({ trace: 'off', video: 'off' });
async function register(page: Page, name: string) { await page.goto('/'); await page.getByRole('button', { name: 'Create an account', exact: true }).click(); await page.getByLabel('Display name', { exact: true }).fill(name); await page.getByLabel('Username', { exact: true }).fill(name); await page.getByLabel('Password', { exact: true }).fill('Gaming-fixture-2026'); await page.getByRole('button', { name: 'Create account', exact: true }).click(); await completeRecovery(page); await expect(page.locator('.app')).toBeVisible(); }
async function api(page: Page, route: string, body?: any, method = body ? 'POST' : 'GET') { return page.evaluate(async ({ route, body, method }) => { const me = await (await fetch('/api/v1/auth/me')).json(); const r = await fetch('/api/v1' + route, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf }, body: body ? JSON.stringify({ requestId: crypto.randomUUID(), ...body }) : undefined }); if (!r.ok) throw new Error(`API ${r.status}: ${await r.text()}`); return r.json(); }, { route, body, method }); }

test('saved permission denials survive reopening and drafts survive navigation and reload', async ({ page }) => {
  await register(page, `Reliable${Date.now().toString().slice(-7)}`); const server = await api(page, '/servers', { name: 'Reliable gaming' });
  await api(page, `/servers/${server.id}/channels`, { name: 'second', kind: 'text' }); await page.getByRole('button', { name: 'Open Reliable gaming', exact: true }).click();
  await page.getByRole('button', { name: 'general', exact: true }).click(); const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('A draft in general'); await page.getByRole('button', { name: 'second', exact: true }).click(); await composer.fill('A different draft'); await page.getByRole('button', { name: 'general', exact: true }).click(); await expect(composer).toHaveValue('A draft in general');
  await page.waitForTimeout(300); await page.reload(); await page.getByRole('button', { name: 'Open Reliable gaming', exact: true }).click(); await expect(composer).toHaveValue('A draft in general');
  const channel = (await api(page, '/bootstrap')).channels.find((c: any) => c.name === 'general');
  await api(page, `/channels/${channel.id}`, { role: 'member', permissions: { write: false }, expectedRevision: 0 }, 'PATCH');
  await page.locator('.space-heading').click(); await page.getByRole('button', { name: 'permissions', exact: true }).click();
  const write = page.locator('.permission-row').filter({ hasText: /^write/ }).locator('select'); await expect(write).toHaveValue('false');
  await page.getByRole('button', { name: 'Save channel overrides', exact: true }).click(); await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click(); await page.locator('.space-heading').click(); await page.getByRole('button', { name: 'permissions', exact: true }).click(); await expect(write).toHaveValue('false');
  expect((await api(page, `/channels/${channel.id}/overrides?role=member`)).permissions.write).toBe(false);
});

test('reading old history does not mark unseen new messages read and keeps a bounded rendered window', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext(), reader = await a.newPage(), writer = await b.newPage();
  try {
    await register(reader, `Reader${Date.now().toString().slice(-7)}`); await register(writer, `Writer${Date.now().toString().slice(-7)}`);
    const server = await api(reader, '/servers', { name: 'Unread gaming' }), invite = await api(reader, `/servers/${server.id}/invites`, {}); await api(writer, '/invites/join', { code: invite.code });
    const channel = (await api(reader, '/bootstrap')).channels.find((c: any) => c.name === 'general');
    for (let i = 0; i < 65; i++) await api(writer, '/messages', { conversationId: channel.conversationId, content: `History ${i}: ` + 'A longer message to read. '.repeat(12) });
    await reader.bringToFront(); await reader.getByRole('button', { name: 'Open Unread gaming', exact: true }).click(); await expect(reader.getByTestId('message').last()).toBeVisible();
    await reader.waitForTimeout(700); await reader.locator('.message-scroll').evaluate(el => { el.scrollTop = 0; });
    await reader.getByRole('button', { name: 'Load earlier messages', exact: true }).click(); await reader.locator('.message-scroll').evaluate(el => { el.scrollTop = 0; }); await reader.waitForTimeout(300);
    expect(await reader.getByTestId('message').count()).toBeLessThan(65);
    const newEvent = await api(writer, '/messages', { conversationId: channel.conversationId, content: 'This must stay unread below the viewport' });
    await reader.waitForTimeout(900); const snapshot = await api(reader, '/bootstrap');
    expect(snapshot.unread[channel.conversationId].readSequence).toBeLessThan(newEvent.sequence);
    await expect(reader.getByRole('button', { name: 'New messages · Jump to latest', exact: true })).toBeVisible();
    await reader.getByRole('button', { name: 'New messages · Jump to latest', exact: true }).click();
    await expect.poll(async () => (await api(reader, '/bootstrap')).unread[channel.conversationId].readSequence).toBe(newEvent.sequence);
    await mkdir('artifacts/evidence', { recursive: true }); await reader.screenshot({ path: 'artifacts/evidence/v050-history.png' });
  } finally { await a.close(); await b.close(); }
});

test('a response lost after commit retries once without duplicates and cannot clear another channel draft', async ({ page }) => {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close()); await page.route('**/socket.io/**', route => route.abort());
  await register(page, `Outbox${Date.now().toString().slice(-7)}`); const server = await api(page, '/servers', { name: 'Outbox gaming' }); await api(page, `/servers/${server.id}/channels`, { name: 'other', kind: 'text' });
  await page.reload(); await page.getByRole('button', { name: 'Open Outbox gaming', exact: true }).click(); await page.getByRole('button', { name: 'general', exact: true }).click();
  const channel = (await api(page, '/bootstrap')).channels.find((c: any) => c.name === 'general'), requests: string[] = [];
  await page.route('**/api/v1/messages', async route => { requests.push(route.request().postDataJSON().requestId); if (requests.length === 1) { await route.fetch(); await route.abort(); } else await route.continue(); });
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Only one committed copy'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(page.getByRole('button', { name: 'Retry message', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A newer unsent draft');
  await page.getByRole('button', { name: 'Retry message', exact: true }).click(); await expect(page.getByTestId('pending-send')).toHaveCount(0); await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('A newer unsent draft');
  expect(requests).toHaveLength(2); expect(requests[0]).toBe(requests[1]); expect((await api(page, `/conversations/${channel.conversationId}/messages`)).messages.filter((m: any) => m.content === 'Only one committed copy')).toHaveLength(1);
  let release!: () => void, intercepted!: () => void; const gate = new Promise<void>(r => { release = r; }), arrived = new Promise<void>(r => { intercepted = r; });
  await page.unroute('**/api/v1/messages'); await page.route('**/api/v1/messages', async route => { const response = await route.fetch(); intercepted(); await gate; await route.fulfill({ response }); });
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A slow committed response'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await arrived;
  await page.getByRole('button', { name: 'other', exact: true }).click(); await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this newer draft'); release(); await page.waitForTimeout(400); await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Keep this newer draft');
});

test('watch is explicit, decoded video fills the viewer, chat drawer and navigation preserve voice', async ({ browser }) => {
  const a = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 1000 } }), b = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 1000 } }), first = await a.newPage(), second = await b.newPage();
  try {
    for (const page of [first, second]) await page.addInitScript(() => { (window as any).__captureCount = 0; navigator.mediaDevices.getDisplayMedia = async () => { (window as any).__captureCount++; const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720; const context = canvas.getContext('2d')!; let n = 0; const timer = setInterval(() => { context.fillStyle = n++ % 2 ? '#34bca5' : '#7567d8'; context.fillRect(0, 0, canvas.width, canvas.height); }, 66); const stream = canvas.captureStream(15); stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer)); return stream; }; });
    await register(first, `GamingA${Date.now().toString().slice(-7)}`); await register(second, `GamingB${Date.now().toString().slice(-7)}`);
    const server = await api(first, '/servers', { name: 'Stream gaming' }), invite = await api(first, `/servers/${server.id}/invites`, {}); await api(second, '/invites/join', { code: invite.code });
    for (const page of [first, second]) { await page.getByRole('button', { name: 'Open Stream gaming', exact: true }).click(); await page.getByRole('button', { name: 'Lounge', exact: true }).click(); }
    await expect(first.locator('.voice-mini-members button')).toHaveCount(2); await first.getByRole('button', { name: 'Share screen', exact: true }).click(); await chooseScreen(first);
    const watch = second.getByRole('button', { name: 'Watch stream', exact: true }); await expect(watch).toBeVisible(); expect((await watch.boundingBox())!.height).toBeGreaterThanOrEqual(34); await expect(second.locator('.screen video')).toHaveCount(0);
    await watch.click(); await expect.poll(() => second.locator('.screen video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
    const stage = await second.locator('.gaming-voice').boundingBox(); expect(stage!.height).toBeGreaterThan(500);
    await second.getByRole('button', { name: 'Show chat', exact: true }).click(); await expect(second.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    await second.getByRole('button', { name: 'Lounge', exact: true }).click(); await expect(second.locator('.voice-mini-members button')).toHaveCount(2);
    await mkdir('artifacts/evidence', { recursive: true }); await second.screenshot({ path: 'artifacts/evidence/v050-stream-viewer.png' });
    await second.getByRole('button', { name: 'Home', exact: true }).click(); await expect(second.locator('.screen video')).toHaveCount(0); await expect(second.locator('.voice-panel')).toBeVisible();
    await second.getByRole('button', { name: 'Account settings', exact: true }).click(); await second.getByRole('tab', { name: 'Audio', exact: true }).click(); await expect(second.getByLabel('Speakers or headset', { exact: true })).toBeVisible(); await second.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await second.getByRole('button', { name: 'Account settings', exact: true }).click(); await expect(second.locator('.app-version')).toContainText('0.5.1'); await second.getByRole('combobox', { name: 'Language', exact: true }).selectOption('fa-IR'); await expect(second.locator('html')).toHaveAttribute('dir', 'rtl');
    for (let i=0;i<12;i++) { await second.keyboard.press('Tab'); expect(await second.evaluate(() => Boolean(document.activeElement?.closest('dialog')))).toBe(true); }
    await second.getByRole('button', { name: fa['Close dialog'], exact: true }).click(); await second.getByTitle('Stream gaming', { exact: true }).click(); await second.getByRole('button', { name: fa['Watch stream'], exact: true }).click(); await expect.poll(() => second.locator('.screen video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
    await second.setViewportSize({ width: 390, height: 844 }); await expect.poll(() => second.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390); await second.screenshot({ path: 'artifacts/evidence/v050-persian-mobile-viewer.png' });
    await writeFile('artifacts/evidence/v050-viewer-result.json', JSON.stringify({ decodedVideo: true, explicitWatch: true, largeStageHeight: stage!.height, voicePreservedOnNavigation: true }, null, 2));
  } finally { await a.close(); await b.close(); }
});
