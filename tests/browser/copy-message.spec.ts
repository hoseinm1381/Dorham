import { test, expect } from '@playwright/test';
import { completeRecovery } from './recovery-helper';
import { writeFile } from 'node:fs/promises';

test('message copy preserves English, Persian and newlines on touch screens', async ({ browser }) => {
 const context = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
 const page = await context.newPage();
 try {
  await page.addInitScript(() => {
   (window as any).__copied = [];
   Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { (window as any).__copied.push(text); } } });
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  const name = 'Copy' + Date.now();
  await page.getByLabel('Display name', { exact: true }).fill(name); await page.getByLabel('Username', { exact: true }).fill(name);
  await page.getByLabel('Password', { exact: true }).fill('copy-browser-fixture'); await page.getByRole('button', { name: 'Create account', exact: true }).click(); await completeRecovery(page);
  await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Create a server', exact: true }).click(); await page.getByLabel('Server name', { exact: true }).fill('Copy lab'); await page.getByRole('button', { name: 'Create space', exact: true }).click();
  if (!await page.locator('.app').evaluate(e => e.classList.contains('nav-open'))) await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
  await page.getByRole('button', { name: 'general', exact: true }).click();
  const text = 'Hello سلام 👋\nSecond line — خط دوم';
  await page.getByLabel('Message', { exact: true }).fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const message = page.getByTestId('message').filter({ hasText: 'Second line' });
  const copy = message.getByRole('button', { name: 'Copy message text', exact: true });
  await expect(copy).toBeVisible(); await copy.tap(); await expect.poll(() => page.evaluate(() => (window as any).__copied)).toEqual([text]);
  await expect(copy).toHaveText('Copied'); await expect(message.locator('.message-body>p')).toContainText(text);
  await page.screenshot({ path: 'artifacts/evidence/android106-copy-mobile.png' });
  await message.getByRole('button', { name: 'Delete message', exact: true }).focus(); await message.getByRole('button', { name: 'Delete message', exact: true }).click(); await expect(page.getByTestId('message').first()).toContainText('Message deleted'); await expect(page.getByTestId('message').first().getByRole('button', { name: 'Copy message text', exact: true })).toHaveCount(0);
  await writeFile('artifacts/evidence/android106-copy-browser.json', JSON.stringify({ touchCopyVisible: true, exactPersianEnglishEmojiAndNewlineText: true, messageUnchanged: true, deletedMessageNotCopyable: true, method: 'Mobile Chrome rendering and intercepted clipboard write; native Android clipboard requires physical device test.' }, null, 2));
 } finally { await context.close(); }
});
