import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { completeRecovery } from './recovery-helper';

test.use({ trace: 'off', launchOptions: { args: ['--disable-gpu', '--renderer-process-limit=2', '--autoplay-policy=no-user-gesture-required'] } });
test('channel tags offer Persian search, notify the recipient once, and open the right channel', async ({ browser, request }) => {
  const suffix = Date.now().toString().slice(-8), password = 'mentions-browser-fixture';
  async function account(name: string, displayName: string) { const r = await request.post('/api/v1/auth/register', { headers: { 'X-Dorham-Native': '1' }, data: { username: name + suffix, displayName, password, requestId: randomUUID() } }); expect(r.status()).toBe(201); return r.json(); }
  const sender = await account('tagger', 'Tagger'), target = await account('tagged', 'علی دوست');
  async function api(u: any, path: string, body?: any, method = 'POST') { const r = await request.fetch('/api/v1' + path, { method, headers: { Authorization: 'Bearer ' + u.accessToken }, data: body === undefined ? undefined : { requestId: randomUUID(), ...body } }); expect(r.ok(), await r.text()).toBe(true); return r.json(); }
  const server = await api(sender, '/servers', { name: 'Tag lab' }), invite = await api(sender, `/servers/${server.id}/invites`, {});
  await api(target, '/invites/join', { code: invite.code });
  const bootstrap = await api(sender, '/bootstrap', undefined, 'GET'), chat = bootstrap.channels.find((c: any) => c.kind === 'text');
  const a = await browser.newContext(), b = await browser.newContext(), page = await a.newPage(), other = await b.newPage();
  async function login(p: Page, u: any) { await p.goto('/'); await p.getByLabel('Username', { exact: true }).fill(u.user.username); await p.getByLabel('Password', { exact: true }).fill(password); await p.getByRole('button', { name: 'Let’s get you in', exact: true }).click(); await completeRecovery(p); await p.getByRole('button', { name: 'Open Tag lab', exact: true }).click(); }
  try {
    page.setDefaultTimeout(15000); other.setDefaultTimeout(15000);
    await login(page, sender); await login(other, target);
    await other.evaluate(() => { (window as any).__messageCues = 0; window.addEventListener('dorham-sound-played', e => { if ((e as CustomEvent).detail === 'message') (window as any).__messageCues++; }); });
    await other.getByRole('button', { name: 'Home', exact: true }).click();
    const input = page.getByLabel('Message', { exact: true }), picker = page.getByRole('listbox', { name: 'Tag a member', exact: true });
    await input.fill('سلام @علی'); await expect(picker.getByRole('option')).toHaveCount(1); await expect(picker).toContainText(target.user.username);
    await page.screenshot({ path: 'artifacts/evidence/v107-mention-picker.png' });
    await input.press('Enter'); await expect(input).toHaveValue(`سلام @${target.user.username} `); await expect(page.getByTestId('message')).toHaveCount(0); // Choosing a member must not send.
    await input.press('End'); await input.pressSequentially('ready'); await input.press('Enter');
    const notice = other.locator('.message-notice'); await expect(notice).toContainText('Tagger mentioned you in #general');
    await expect.poll(() => other.evaluate(() => (window as any).__messageCues)).toBe(1);
    await other.screenshot({ path: 'artifacts/evidence/v107-mention-notification.png' });
    await notice.getByRole('button', { name: 'Tagger mentioned you in #general', exact: true }).click();
    await expect(other.locator('.channel-item.selected')).toContainText('general'); await expect(other.locator('.message.mentioned .message-mention.self')).toHaveText('@' + target.user.username); await expect(notice).toHaveCount(0);
    const history = await api(sender, `/conversations/${chat.conversationId}/messages`, undefined, 'GET'), message = history.messages[0];
    await api(sender, `/messages/${message.id}`, { content: `Edited @${target.user.username}` }, 'PATCH'); await expect(other.getByTestId('message')).toContainText('Edited');
    await api(sender, `/messages/${message.id}`, { emoji: '👍' }, 'PATCH'); await expect(other.locator('.reactions')).toContainText('1'); expect(await notice.count()).toBe(0); expect(await other.evaluate(() => (window as any).__messageCues)).toBe(1);
    // Normal channel text does not notify someone who is elsewhere.
    await other.getByRole('button', { name: 'Home', exact: true }).click();
    await api(sender, '/messages', { conversationId: chat.conversationId, content: 'Ordinary channel text' });
    await api(sender, '/messages', { conversationId: chat.conversationId, content: `mail@${target.user.username} https://example.test/@${target.user.username} \`@${target.user.username}\`` });
    await api(target, '/profile', { displayName: target.user.displayName, bio: '', status: 'busy' }, 'PATCH'); await expect(other.locator('.account-info small')).toHaveText('busy');
    await api(sender, '/messages', { conversationId: chat.conversationId, content: `Quiet @${target.user.username}` }); await expect(notice).toContainText('mentioned you'); expect(await other.evaluate(() => (window as any).__messageCues)).toBe(1);
    await notice.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
    await api(target, '/profile', { displayName: target.user.displayName, bio: '', status: 'online' }, 'PATCH'); await expect(other.locator('.account-info small')).toHaveText('online');
    await other.getByRole('button', { name: 'Account settings', exact: true }).click(); await other.getByRole('tab', { name: 'Notifications', exact: true }).click(); await other.getByRole('checkbox', { name: 'Direct message and mention sounds', exact: true }).uncheck(); await other.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await api(sender, '/messages', { conversationId: chat.conversationId, content: `Preference @${target.user.username}` }); await expect(notice).toContainText('mentioned you'); expect(await other.evaluate(() => (window as any).__messageCues)).toBe(1);
    await other.reload(); await expect(other.getByRole('button', { name: 'Open Tag lab', exact: true })).toBeVisible(); await other.getByRole('button', { name: 'Open Tag lab', exact: true }).click(); await expect(other.locator('.message.mentioned')).toHaveCount(3); await expect(notice).toHaveCount(0);
    // Pointer selection, Escape, and normal multiline composition remain usable.
    await input.fill('@tagged'); await expect(picker.getByRole('option')).toHaveCount(1); await picker.getByRole('option').click(); await expect(input).toHaveValue(`@${target.user.username} `);
    await input.fill('@tag'); await input.press('Escape'); await expect(picker).toHaveCount(0); await input.press('Shift+Enter'); await expect(input).toHaveValue('@tag\n');
    await page.getByRole('button', { name: 'Account settings', exact: true }).click(); await page.getByLabel('Language', { exact: true }).selectOption('fa-IR'); await page.getByRole('button', { name: 'بستن پنجره', exact: true }).click();
    await page.locator('.composer textarea').fill('@علی'); const rtlPicker = page.getByRole('listbox', { name: 'اشاره به یک عضو', exact: true }); await expect(rtlPicker).toBeVisible(); await expect(page.locator('html')).toHaveAttribute('dir', 'rtl'); await page.screenshot({ path: 'artifacts/evidence/v107-mention-picker-rtl.png' });
    await writeFile('artifacts/evidence/v107-mentions-browser.json', JSON.stringify({ realClients: 2, persianAndUsernameSearch: true, keyboardAndPointerSelection: true, selectingDoesNotSend: true, liveMentionBannerAndSound: true, bannerOpensCorrectServerChannel: true, ownTagsAndMessageHighlighted: true, editsAndReactionsDoNotPing: true, ordinaryTextEmailUrlCodeDoNotPing: true, dndAndSoundPreferenceRespected: true, historyDoesNotPing: true, escapeAndShiftEnter: true, persianRtl: true, fixtureOnly: true }, null, 2));
  } finally { await a.close(); await b.close(); }
});

test('final mention smoke uses one browser and a real API sender under limited memory', async ({ page, request }) => {
  const suffix = Date.now().toString().slice(-8), password = 'mention-smoke-fixture';
  async function account(name: string, displayName: string) { const r = await request.post('/api/v1/auth/register', { headers: { 'X-Dorham-Native': '1' }, data: { username: name + suffix, displayName, password, requestId: randomUUID() } }); expect(r.status()).toBe(201); return r.json(); }
  const sender = await account('smoke_sender', 'علی'), target = await account('smoke_target', 'Recipient');
  async function api(u: any, path: string, body?: any, method = 'POST') { const r = await request.fetch('/api/v1' + path, { method, headers: { Authorization: 'Bearer ' + u.accessToken }, data: body === undefined ? undefined : { requestId: randomUUID(), ...body } }); expect(r.ok(), await r.text()).toBe(true); return r.json(); }
  const server = await api(sender, '/servers', { name: 'Final tag lab' }), invite = await api(sender, `/servers/${server.id}/invites`, {}); await api(target, '/invites/join', { code: invite.code });
  const chat = (await api(sender, '/bootstrap', undefined, 'GET')).channels.find((c: any) => c.kind === 'text');
  await page.goto('/'); await page.getByLabel('Username', { exact: true }).fill(target.user.username); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Let’s get you in', exact: true }).click(); await completeRecovery(page); await page.getByRole('button', { name: 'Open Final tag lab', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Message', exact: true }), picker = page.getByRole('listbox', { name: 'Tag a member', exact: true });
  await input.fill('@علی'); await expect(picker.getByRole('option')).toHaveCount(1); await input.press('Home'); await expect(picker).toHaveCount(0); await input.press('End'); await expect(picker).toBeVisible(); await input.press('Enter'); await expect(input).toHaveValue(`@${sender.user.username} `); await expect(page.getByTestId('message')).toHaveCount(0);
  await page.evaluate(() => { (window as any).__messageCues = 0; window.addEventListener('dorham-sound-played', e => { if ((e as CustomEvent).detail === 'message') (window as any).__messageCues++; }); });
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  const body = { requestId: randomUUID(), conversationId: chat.conversationId, content: `سلام @${target.user.username} @${target.user.username}` }, sent = await api(sender, '/messages', body);
  await expect(page.locator('.message-notice')).toContainText('mentioned you in #general'); await expect.poll(() => page.evaluate(() => (window as any).__messageCues)).toBe(1); await page.locator('.message-notice > button').first().click(); await expect(page.locator('.message-mention.self')).toHaveCount(2);
  await api(sender, '/messages', body); await api(sender, `/messages/${sent.payload.id}`, { content: `edited @${target.user.username}` }, 'PATCH'); await expect(page.getByTestId('message')).toContainText('edited'); expect(await page.evaluate(() => (window as any).__messageCues)).toBe(1); await expect(page.locator('.message-notice')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/evidence/v107-mentions-final-smoke.png' });
  await writeFile('artifacts/evidence/v107-mentions-final-smoke.json', JSON.stringify({ oneChromeClient: true, realApiSender: true, finalTextAreaRemainsAccessibleTextbox: true, persianAutocompleteAndCaretBoundary: true, selectionDoesNotSend: true, duplicateTagSingleAlert: true, liveBannerSoundAndNavigation: true, highlightedRecipient: true, retryAndEditNoRepeat: true, fixtureOnly: true }, null, 2));
});
