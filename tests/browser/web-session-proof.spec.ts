import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { completeRecovery } from './recovery-helper';

test('shared-cookie tabs recover the same account proof without duplicating a message', async ({ page, context, request }) => {
  const suffix = randomUUID().slice(0, 8), password = 'session-proof-fixture-password';
  const registered = await request.post('/api/v1/auth/register', { headers: { 'X-Dorham-Native': '1' }, data: { username: 'proof' + suffix, displayName: 'Proof tester', password, requestId: randomUUID() } });
  expect(registered.status()).toBe(201); const user = await registered.json();
  const serverResponse = await request.post('/api/v1/servers', { headers: { Authorization: 'Bearer ' + user.accessToken }, data: { name: 'Session lab', requestId: randomUUID() } }); expect(serverResponse.ok()).toBe(true);
  await page.goto('/'); await page.getByLabel('Username', { exact: true }).fill(user.user.username); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Let’s get you in', exact: true }).click(); await completeRecovery(page);
  await page.getByRole('button', { name: 'Open Session lab', exact: true }).click();
  const content = 'Exactly one message after another tab signs in ' + suffix;
  const input = page.getByRole('textbox', { name: 'Message', exact: true }); await input.fill(content); await input.press('Enter');
  await expect(page.getByTestId('message').filter({ hasText: content })).toHaveCount(1);
  const second = await context.newPage(); await second.goto('/');
  await expect(second.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
  await expect(second.locator('.connection-pill')).toContainText('All connected');
  // A login in another tab replaces the shared HttpOnly cookie while this tab
  // retains its old in-memory CSRF proof. Use the real Go login/cookie path.
  const login = await second.request.post('/api/v1/auth/login', { data: { username: user.user.username, password, requestId: randomUUID() } }); expect(login.ok()).toBe(true);
  const statuses: number[] = []; page.on('response', r => { if (r.url().includes('/api/v1/messages/') && r.request().method() === 'PATCH') statuses.push(r.status()); });
  const edited = content + ' edited';
  await page.getByTestId('message').hover(); await page.getByRole('button', { name: 'Edit message', exact: true }).click(); await input.fill(edited); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => statuses).toEqual([403, 200]);
  await expect(page.getByTestId('message').filter({ hasText: edited })).toHaveCount(1);
  const bootstrap = await (await request.get('/api/v1/bootstrap', { headers: { Authorization: 'Bearer ' + user.accessToken } })).json();
  const channel = bootstrap.channels.find((c: any) => c.serverId === bootstrap.servers.find((s: any) => s.name === 'Session lab').id && c.kind === 'text');
  const messages = await (await request.get('/api/v1/conversations/' + channel.conversationId + '/messages', { headers: { Authorization: 'Bearer ' + user.accessToken } })).json();
  expect(messages.messages.filter((m: any) => m.content === edited)).toHaveLength(1);
  await context.setOffline(true); await context.setOffline(false);
  await expect(page.locator('.connection-pill')).toContainText('All connected');
  await writeFile('artifacts/evidence/web-session-proof-browser.json', JSON.stringify({ actualGoCookieRotation: true, twoSharedCookieTabs: true, rejectedStaleProofBeforeRecovery: true, messageStoredExactlyOnce: true, socketReconnect: true }, null, 2));
});
