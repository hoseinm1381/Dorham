import { expect, test } from '@playwright/test';
import { completeRecovery } from './recovery-helper';

test('retries invalid and lost send acknowledgments without sending twice', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill('Reliability check');
  await page.getByLabel('Username', { exact: true }).fill('delivery' + Date.now().toString().slice(-9));
  await page.getByLabel('Password', { exact: true }).fill('browser-fixture-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await completeRecovery(page);
  const notice = page.getByRole('dialog', { name: /^What’s new/ });
  if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click();

  const fixture = await page.evaluate(async () => {
    const auth = await (await fetch('/api/v1/auth/me')).json();
    const server = await (await fetch('/api/v1/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrf },
      body: JSON.stringify({ requestId: crypto.randomUUID(), name: 'Message reliability' })
    })).json();
    const bootstrap = await (await fetch('/api/v1/bootstrap')).json();
    return { conversation: bootstrap.channels.find((channel: any) => channel.serverId === server.id && channel.kind === 'text').conversationId };
  });
  await page.getByRole('button', { name: 'Open Message reliability', exact: true }).click();

  const requests: string[] = [];
  await page.route('**/api/v1/messages?sender=*', async route => {
    requests.push(route.request().postDataJSON().requestId);
    if (requests.length === 1) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Temporary gateway page</h1>' });
    } else if (requests.length === 2) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort('connectionreset');
    } else await route.continue();
  });
  const composer = page.locator('.composer textarea');
  await composer.fill('گفت‌وگوی يك‌شنبه ۱۲');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(new Set(requests).size).toBe(1);
  await expect(page.getByLabel('Outgoing messages')).toHaveCount(0);
  const history = await page.request.get(`/api/v1/conversations/${fixture.conversation}/messages`);
  expect((await history.json()).messages).toHaveLength(1);

  await page.getByRole('button', { name: 'Search messages', exact: true }).click();
  const search = page.getByRole('dialog', { name: 'Search messages', exact: true });
  await search.getByRole('searchbox').fill('یک شنبه 12');
  const searchResponse = page.waitForResponse(response => response.url().includes('/api/v1/messages/search?'));
  await search.getByRole('button', { name: 'Search', exact: true }).click();
  expect((await searchResponse).status()).toBe(200);
  await search.getByRole('button', { name: /گفت‌وگوی/ }).click();
  await expect(page.locator('[data-highlight=true]')).toContainText('گفت‌وگوی يك‌شنبه ۱۲');
});
