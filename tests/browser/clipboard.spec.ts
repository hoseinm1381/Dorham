import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';

async function register(page: Page, name: string) {
  await page.goto('/'); await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill(name); await page.getByLabel('Username', { exact: true }).fill(name); await page.getByLabel('Password', { exact: true }).fill('clipboard-fixture-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click(); await expect(page.getByRole('heading', { name: `Hey, ${name}.` })).toBeVisible();
}
async function api(page: Page, route: string, body?: any) {
  return page.evaluate(async ({ route, body }) => {
    const auth = await (await fetch('/api/v1/auth/me')).json();
    const r = await fetch('/api/v1' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrf }, body: body ? JSON.stringify({ requestId: crypto.randomUUID(), ...body }) : undefined });
    if (!r.ok) throw new Error(`API ${r.status}`); return r.json();
  }, { route, body });
}
async function pasteImage(page: Page, buffer: Buffer, name: string) {
  return page.getByLabel('Message', { exact: true }).evaluate((input, { bytes, name }) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], name, { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }); input.dispatchEvent(event); return event.defaultPrevented;
  }, { bytes: [...buffer], name });
}
test('clipboard pictures prepare attachments in channels and DMs without sending automatically', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext(), page = await a.newPage(), other = await b.newPage(), suffix = Date.now().toString().slice(-7);
  try {
    await register(page, `PasteA${suffix}`); await register(other, `PasteB${suffix}`);
    const png = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#34bca5' } }).png().toBuffer();
    await api(page, '/servers', { name: 'Clipboard lab' }); await page.getByRole('button', { name: 'Open Clipboard lab', exact: true }).click();
    await page.getByLabel('Message', { exact: true }).fill('Caption retained'); expect(await pasteImage(page, png, 'clipboard-channel.png')).toBe(true);
    await expect(page.locator('.attachment-draft')).toContainText('clipboard-channel.png'); await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Caption retained'); await expect(page.getByTestId('message')).toHaveCount(0);
    await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expect.poll(() => page.locator('.attachment-preview img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(320);
    const me = (await api(other, '/auth/me')).user; await api(page, '/dms', { userId: me.id }); await page.getByRole('button', { name: 'Home', exact: true }).click(); await page.locator('.dm-item').click();
    expect(await pasteImage(page, png, 'clipboard-dm.png')).toBe(true); await expect(page.locator('.attachment-draft')).toContainText('clipboard-dm.png');
    await page.getByRole('button', { name: 'Send message', exact: true }).click(); await other.locator('.dm-item').click(); await expect.poll(() => other.locator('.attachment-preview img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(320);
    // Plain text must retain the browser's ordinary paste handling.
    expect(await page.getByLabel('Message', { exact: true }).evaluate(input => { const data = new DataTransfer(); data.setData('text/plain', 'Normal text'); const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }); input.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
    for (let n = 0; n < 4; n++) { await pasteImage(page, png, `limit-${n}.png`); await expect(page.locator('.attachment-draft')).toHaveCount(n + 1); }
    await pasteImage(page, png, 'excess.png'); await expect(page.getByRole('alert')).toContainText('up to four files'); await expect(page.locator('.attachment-draft')).toHaveCount(4);
    await mkdir('artifacts/evidence', { recursive: true }); await page.screenshot({ path: 'artifacts/evidence/clipboard-picture.png' });
    await writeFile('artifacts/evidence/clipboard-picture.json', JSON.stringify({ channelImageDecoded: true, dmImageDecodedByRecipient: true, explicitSendRequired: true, captionPreserved: true, plainTextPasteNotIntercepted: true, fourFileLimitEnforced: true, method: 'Real browser ClipboardEvent and image File through actual upload/API/database; OS clipboard contents were not accessed.' }, null, 2));
  } finally { await a.close(); await b.close(); }
});
