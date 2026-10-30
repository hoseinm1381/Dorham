import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import fa from '../../apps/web/src/locales/fa-IR.json' with { type: 'json' };

test.use({ trace: 'off', video: 'off' });
const translate = (key: keyof typeof fa) => fa[key];
async function api(page: Page, route: string, body?: unknown) {
  return page.evaluate(async ({ route, body }) => {
    const me = await (await fetch('/api/v1/auth/me')).json();
    const response = await fetch('/api/v1' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf }, body: body ? JSON.stringify({ requestId: crypto.randomUUID(), ...body }) : undefined });
    if (!response.ok) throw Error(await response.text()); return response.json();
  }, { route, body: body as Record<string, unknown> | undefined });
}
async function register(page: Page, username: string, displayName: string, persian = false) {
  const text = (key: keyof typeof fa) => persian ? translate(key) : key;
  await page.goto('/'); await page.getByRole('button', { name: text('Create an account'), exact: true }).click();
  await page.getByLabel(text('Display name'), { exact: true }).fill(displayName);
  await page.getByLabel(text('Username'), { exact: true }).fill(username);
  await page.getByLabel(text('Password'), { exact: true }).fill('persian-test-123');
  await page.getByRole('button', { name: text('Create account'), exact: true }).click();
  await expect(page.locator('.app')).toBeVisible();
}

test('Persian typography, mixed messages, Arabic-keyboard search, ping badges and mobile RTL work together', async ({ browser }) => {
  test.setTimeout(90000);
  const a = await browser.newContext({ locale: 'fa-IR', viewport: { width: 1440, height: 1000 } });
  const b = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  const first = await a.newPage(), other = await b.newPage(), suffix = Date.now().toString().slice(-7);
  const originalName = 'علي كريمي', content = 'سلام Chris! این یک پیام با نیم‌فاصله است: https://example.com/hello?q=123';
  try {
    await register(first, `Persian${suffix}`, originalName, true);
    await register(other, `English${suffix}`, 'Chris');
    await expect(first.locator('html')).toHaveAttribute('lang', 'fa-IR');
    await expect(first.locator('html')).toHaveAttribute('dir', 'rtl');
    await first.evaluate(() => document.fonts.load('16px Vazirmatn', 'سلام فارسی'));
    expect(await first.evaluate(() => document.fonts.check('16px Vazirmatn', 'سلام فارسی'))).toBe(true);
    expect(await first.locator('body').evaluate(el => getComputedStyle(el).fontFamily)).toContain('Vazirmatn');
    const server = await api(first, '/servers', { name: 'جمع دوستان' });
    const invite = await api(first, `/servers/${server.id}/invites`, {}); await api(other, '/invites/join', { code: invite.code });
    for (const page of [first, other]) await page.getByTitle('جمع دوستان', { exact: true }).click();
    const composer = first.getByRole('textbox', { name: translate('Message'), exact: true });
    await expect(first.locator('.file-composer')).toContainText('مگابایت');
    await expect(first.locator('.file-composer')).not.toContainText(/میبی|گیبی/);
    await composer.fill(content); await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    await expect(first.getByTestId('message')).toHaveCount(0);
    await composer.press('Enter');
    const incoming = other.getByTestId('message').filter({ hasText: content });
    await expect(incoming).toBeVisible(); await expect(incoming.locator('.message-byline bdi')).toHaveText(originalName);
    expect(await incoming.locator('.message-text').evaluate(el => getComputedStyle(el).direction)).toBe('rtl');
    expect(await incoming.locator('.message-body>p').evaluate(el => getComputedStyle(el).direction)).toBe('rtl');
    expect(await incoming.locator('.message-text').evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); return el.parentElement!.getBoundingClientRect().right - Math.max(...[...range.getClientRects()].map(r => r.right)); })).toBeLessThan(5);
    await expect(incoming.locator('a')).toHaveAttribute('dir', 'ltr');
    await expect(incoming.getByTestId('connection-ping')).toHaveAttribute('data-ping-ms', /^\d+$/, { timeout: 22000 });
    await other.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello! English reply 123.');
    await other.getByRole('button', { name: 'Send message', exact: true }).click();
    const english = first.getByTestId('message').filter({ hasText: 'Hello! English reply 123.' }); await expect(english).toBeVisible();
    expect(await english.locator('.message-text').evaluate(el => getComputedStyle(el).direction)).toBe('ltr');
    expect(await english.locator('.message-body>p').evaluate(el => getComputedStyle(el).direction)).toBe('ltr');
    expect(await english.locator('.message-text').evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); return Math.min(...[...range.getClientRects()].map(r => r.left)) - el.parentElement!.getBoundingClientRect().left; })).toBeLessThan(5);
    await expect(english.getByTestId('connection-ping')).toContainText('میلی‌ثانیه', { timeout: 22000 });
    await expect(english.getByTestId('connection-ping')).toHaveText(/[۰-۹]+ میلی‌ثانیه/);
    await mkdir('artifacts/evidence', { recursive: true }); await first.screenshot({ path: 'artifacts/evidence/persian-chat-desktop.png' });
    await other.getByRole('button', { name: 'Home', exact: true }).click();
    await other.getByRole('textbox', { name: 'Find a person', exact: true }).fill('علی کریمی');
    await expect(other.locator('.person-row')).toHaveCount(1); await expect(other.locator('.person-row')).toContainText(originalName);
    await first.getByRole('button', { name: translate('Account settings'), exact: true }).click();
    await first.getByRole('tab', { name: translate('Audio'), exact: true }).click();
    await expect(first.getByRole('heading', { name: translate('Voice input & hotkeys'), exact: true })).toBeVisible();
    await first.getByLabel(translate('Voice input mode'), { exact: true }).selectOption('push');
    await expect(first.getByRole('button', { name: translate('Record talk hotkey'), exact: true })).toBeVisible();
    await first.screenshot({ path: 'artifacts/evidence/persian-settings.png' });
    await first.getByRole('button', { name: translate('Close dialog'), exact: true }).click();
    await first.setViewportSize({ width: 390, height: 844 });
    await first.getByRole('button', { name: translate('Toggle navigation'), exact: true }).click();
    await expect(first.locator('.app')).toHaveClass(/nav-open/);
    await expect.poll(() => first.locator('.sidebar').evaluate(el => Math.round(el.getBoundingClientRect().right))).toBeLessThanOrEqual(390);
    expect(await first.locator('.sidebar').evaluate(el => el.getBoundingClientRect().left)).toBeGreaterThanOrEqual(0);
    expect(await first.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expect.poll(() => first.locator('.server-rail').evaluate(el => Math.round(el.getBoundingClientRect().right))).toBe(390);
    await first.screenshot({ path: 'artifacts/evidence/persian-mobile-navigation.png' });
    await first.locator('.mobile-scrim').click({ position: { x: 15, y: 200 } });
    await expect(first.locator('.app')).not.toHaveClass(/nav-open/);
    await expect.poll(() => first.locator('.server-rail').evaluate(el => Math.round(el.getBoundingClientRect().left))).toBeGreaterThanOrEqual(390);
    await first.screenshot({ path: 'artifacts/evidence/persian-mobile.png' });
    const ping = await english.getByTestId('connection-ping').getAttribute('data-ping-ms');
    await b.close();
    await expect(english.getByTestId('connection-ping')).toHaveCount(0);
    await writeFile('artifacts/evidence/persian-ping-browser.json', JSON.stringify({ testedAt: new Date().toISOString(), fontLoaded: true, mixedMessagesAndLinks: true, originalNamePreserved: true, keyboardVariantsSearch: true, imeEnterDidNotSend: true, serverMeasuredPing: ping, disconnectedPingRemoved: true, persianDigits: true, mobileRtl: true }, null, 2));
  } finally { await a.close(); await b.close(); }
});

test('the Persian font stays available with only the cached public shell offline', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'fa-IR' }), page = await context.newPage();
  try {
    await page.goto('/'); await expect(page.getByRole('heading', { name: translate('Welcome back.'), exact: true })).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(() => page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(r => r.url)))).flat().some(url => /\/assets\/.*\.woff2$/.test(url)))).toBe(true);
    const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(r => r.url)))).flat());
    expect(cached.some(url => /\/(api|avatars|socket.io)\//.test(url))).toBe(false);
    await context.setOffline(true); await page.reload();
    await expect(page.getByRole('heading', { name: translate('Welcome back.'), exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.load('16px Vazirmatn', 'فارسی بدون اینترنت'));
    expect(await page.evaluate(() => document.fonts.check('16px Vazirmatn', 'فارسی بدون اینترنت'))).toBe(true);
  } finally { await context.close(); }
});

test('uploaded file sizes use familiar Persian wording and localized digits', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'fa-IR' }), page = await context.newPage();
  try {
    await register(page, `Size${Date.now().toString().slice(-7)}`, 'آزمایش فایل', true);
    await api(page, '/servers', { name: 'فایل فارسی' }); await page.getByTitle('فایل فارسی', { exact: true }).click();
    await page.locator('.file-composer input[type=file]').setInputFiles({ name: 'آزمایش.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1048576, 'x') });
    await expect(page.locator('.attachment-draft')).toContainText('آزمایش.txt');
    await page.getByRole('button', { name: translate('Send message'), exact: true }).click();
    await expect(page.locator('.attachment-caption small')).toContainText('۱ مگابایت');
    await expect(page.locator('.attachment-caption small')).not.toContainText(/MiB|میبی|گیبی/);
  } finally { await context.close(); }
});
