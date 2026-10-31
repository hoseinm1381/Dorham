import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { completeRecovery } from './recovery-helper';
import catalog from '../../apps/web/src/emoji-catalog.json' with { type: 'json' };
test.use({ trace: 'off', video: 'off', actionTimeout: 12000 });
async function register(page: Page, name: string) {
  await page.goto('/'); await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill(name); await page.getByLabel('Username', { exact: true }).fill(name); await page.getByLabel('Password', { exact: true }).fill('Emoji-fixture-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click(); await completeRecovery(page);
}
async function api(page: Page, route: string, body?: object) {
  return page.evaluate(async ({ route, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json(), response = await fetch('/api/v1' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf }, body: body ? JSON.stringify({ requestId: crypto.randomUUID(), ...body }) : undefined });
    if (!response.ok) throw Error('API ' + response.status); return response.json();
  }, { route, body });
}
test('bundled emojis send, edit and persist across clients, with mobile Persian search and offline artwork', async ({ browser }) => {
  test.setTimeout(120000);
  const a = await browser.newContext(), b = await browser.newContext(), first = await a.newPage(), second = await b.newPage();
  try {
    const suffix = Date.now().toString().slice(-7); await register(first, `EmojiA${suffix}`); await register(second, `EmojiB${suffix}`);
    const server = await api(first, '/servers', { name: 'Emoji lab' }), invite = await api(first, `/servers/${server.id}/invites`, {}); await api(second, '/invites/join', { code: invite.code });
    for (const page of [first, second]) await page.getByRole('button', { name: 'Open Emoji lab', exact: true }).click();
    const input = first.getByRole('textbox', { name: 'Message', exact: true }); await input.fill('hello world!'); await input.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(6, 11));
    await first.getByRole('button', { name: 'Add emoji', exact: true }).click(); const picker = first.getByRole('dialog', { name: 'Emojis', exact: true }); await expect(picker.locator('.emoji-grid button')).toHaveCount(64);
    await picker.locator('.emoji-grid img').evaluateAll(async images => { await Promise.all(images.map(i => (i as HTMLImageElement).decode())); });
    await mkdir('artifacts/evidence', { recursive: true }); await first.screenshot({ path: 'artifacts/evidence/v103-picker-desktop.png' });
    await picker.getByRole('button', { name: 'Only Dorham', exact: true }).click(); await expect(picker.locator('.emoji-grid button')).toHaveCount(9); await picker.getByRole('button', { name: 'All emojis', exact: true }).click();
    await picker.getByRole('searchbox', { name: 'Search emojis', exact: true }).fill('chai'); await picker.getByRole('searchbox').press('Enter'); await expect(first.getByTestId('message')).toHaveCount(0);
    await picker.getByRole('button', { name: 'Insert Tea Time', exact: true }).click(); await expect(input).toHaveValue('hello :dorham-tea-time:!'); await expect(input).toBeFocused();
    await first.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(second.getByTestId('message').getByRole('img', { name: 'Tea Time', exact: true })).toBeVisible();
    await first.getByTestId('message').hover(); await first.getByRole('button', { name: 'React with thumbs up', exact: true }).click(); await expect(second.locator('.reactions img')).toHaveAttribute('src', /emoji-thumbs-up\.svg$/);
    await first.getByTestId('message').hover(); await first.getByRole('button', { name: 'Edit message', exact: true }).click(); await input.fill('edited :dorham-group-hug:'); await first.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(second.getByRole('img', { name: 'Group Hug', exact: true })).toBeVisible();
    await input.fill(catalog.map(e => `:${e.id}:`).join(' ')); await first.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(second.getByTestId('message').last().locator('.custom-emoji')).toHaveCount(64);
    await second.reload(); await second.getByRole('button', { name: 'Open Emoji lab', exact: true }).click(); await expect(second.getByTestId('message').last().locator('.custom-emoji')).toHaveCount(64);
    await second.screenshot({ path: 'artifacts/evidence/v103-message-emojis.png' });
    const receiver = (await api(second, '/auth/me')).user; const dm = await api(first, '/dms', { userId: receiver.id }); await api(first, '/messages', { conversationId: dm.id, content: ':dorham-hangout:' });
    const history = await api(second, `/conversations/${dm.id}/messages`); expect(JSON.stringify(history)).toContain(':dorham-hangout:');
    await expect.poll(() => first.evaluate(async paths => { await navigator.serviceWorker.ready; const keys = await caches.keys(), cache = await caches.open(keys.find(k => k.startsWith('dorham-shell-'))!); return (await Promise.all(paths.map(p => cache.match(new URL(p, location.href).href, { ignoreVary: true })))).filter(Boolean).length; }, catalog.map(e => e.src))).toBe(64);
    await a.setOffline(true); expect(await first.evaluate(async paths => (await Promise.all(paths.map(async p => (await fetch(p, { cache: 'reload' })).ok))).every(Boolean), catalog.map(e => e.src))).toBe(true); await a.setOffline(false);
    await first.getByRole('button', { name: 'Account settings', exact: true }).click(); await first.getByRole('combobox', { name: 'Language', exact: true }).selectOption('fa-IR'); await first.getByRole('button', { name: 'بستن پنجره', exact: true }).click(); await first.setViewportSize({ width: 390, height: 844 });
    await first.getByRole('button', { name: 'افزودن ایموجی', exact: true }).click(); const faPicker = first.getByRole('dialog', { name: 'ایموجی‌ها', exact: true }); await faPicker.getByRole('searchbox').fill('چای'); await expect(faPicker.locator('.emoji-grid button')).toHaveCount(1);
    const box = await faPicker.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await first.screenshot({ path: 'artifacts/evidence/v103-picker-persian-mobile.png' }); await faPicker.getByRole('searchbox').press('Escape'); await expect(faPicker).toBeHidden(); await expect(first.getByRole('button', { name: 'افزودن ایموجی', exact: true })).toBeFocused();
    await writeFile('artifacts/evidence/v103-emojis-browser.json', JSON.stringify({ artworkDecoded: 64, twoClientSend: true, edit: true, historyReload: true, directMessageHistory: true, existingReactions: true, caretReplacement: true, searchEnterDoesNotSend: true, offlineImages: 64, persianSearch: true, mobileFits: true, escapeReturnsFocus: true, productionAccountsUsed: false }, null, 2));
  } finally { await Promise.allSettled([a.close(), b.close()]); }
});
