import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
test.use({ trace: 'off', video: 'off' });
async function api(page: Page, route: string, body?: any, method = body ? 'POST' : 'GET') {
  return page.evaluate(async ({ route, body, method }) => { const me = await (await fetch('/api/v1/auth/me')).json(); const result = await fetch(`/api/v1${route}`, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf }, body: body ? JSON.stringify({ requestId: crypto.randomUUID(), ...body }) : undefined }); if (!result.ok) throw new Error(await result.text()); return result.json(); }, { route, body, method });
}
async function register(page: Page, username: string) {
  await page.goto('/'); await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill(username); await page.getByLabel('Username', { exact: true }).fill(username); await page.getByLabel('Password', { exact: true }).fill('eight888');
  await page.getByRole('button', { name: 'Create account', exact: true }).click(); await expect(page.getByRole('heading', { name: `Hey, ${username}.` })).toBeVisible();
}
test('restricted network supports guests, persistent conversion, safe links, attachments and RTL', async ({ browser, baseURL }) => {
  const a = await browser.newContext({ locale: 'en-US' }), b = await browser.newContext({ locale: 'en-US' });
  const allowedOrigin = new URL(baseURL!).origin, requests: string[] = [], blocked: string[] = [];
  for (const context of [a, b]) await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === allowedOrigin || ['data:', 'blob:'].includes(url.protocol)) { requests.push(`${route.request().method()} ${url.pathname}`); return route.continue(); } blocked.push(url.origin); return route.abort('blockedbyclient'); });
  const page = await a.newPage(), other = await b.newPage(), name = `Expand${Date.now().toString().slice(-7)}`;
  try {
    await register(page, name);
    const server = await api(page, '/servers', { name: 'Expansion browser lab' }), snapshot = await api(page, '/bootstrap'), channel = snapshot.channels.find((c: any) => c.serverId === server.id && c.kind === 'text'), voice = snapshot.channels.find((c: any) => c.serverId === server.id && c.kind === 'voice'), invite = await api(page, `/servers/${server.id}/invites`, {});
    await page.getByRole('button', { name: 'Open Expansion browser lab', exact: true }).click();
    await other.goto(`/?invite=${encodeURIComponent(invite.code)}`); await other.getByText('Join as a guest', { exact: true }).click();
    await other.locator('.access-entry').getByLabel('Guest display name', { exact: true }).fill('مهمان آزمایشی'); await other.getByRole('button', { name: 'Continue as guest', exact: true }).click();
    await other.getByRole('button', { name: 'Open Expansion browser lab', exact: true }).click();
    const guestId = (await api(other, '/auth/me')).user.id;
    await other.getByRole('textbox', { name: 'Message', exact: true }).fill('سلام mixed Persian and English'); await other.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByTestId('message')).toContainText('سلام mixed Persian and English'); await expect(other.locator('.file-composer')).toHaveCount(0);
    await other.reload(); await expect(other.getByRole('button', { name: 'Open Expansion browser lab', exact: true })).toBeVisible(); expect((await api(other, '/auth/me')).user.id).toBe(guestId);
    await other.getByRole('button', { name: 'Account settings', exact: true }).click();
    const guestName = `GuestUp${Date.now().toString().slice(-7)}`; await other.locator('.account-controls').getByLabel('Username', { exact: true }).fill(guestName); await other.locator('.account-controls').getByLabel('Password', { exact: true }).fill('eight888');
    await other.getByRole('button', { name: 'Register this account', exact: true }).click(); await expect.poll(async () => (await api(other, '/auth/me')).user.guest).toBe(false); expect((await api(other, '/auth/me')).user.id).toBe(guestId);
    await other.getByRole('button', { name: 'Close dialog', exact: true }).click(); await other.getByRole('button', { name: 'Open Expansion browser lab', exact: true }).click();
    const link = `${baseURL}/?server=${server.id}&channel=${channel.id}`;
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(`Safe https://example.com/test). ${link} javascript:alert(1) <img src=x onerror=alert(1)>`); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const message = other.getByTestId('message').filter({ hasText: 'Safe https://' });
    await expect(message.locator('a[href="https://example.com/test"]')).toHaveAttribute('rel', 'noopener noreferrer'); await expect(message.locator('img')).toHaveCount(0);
    await message.locator(`a[href*="channel=${channel.id}"]`).click(); await expect(other.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    const fileBytes = Buffer.from('Private attachment with Persian: سلام'); await page.locator('.file-composer input[type=file]').setInputFiles({ name: 'pilot-notes.txt', mimeType: 'text/plain', buffer: fileBytes });
    await expect(page.locator('.attachment-draft')).toContainText('pilot-notes.txt'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const received = other.locator('.attachment').filter({ hasText: 'pilot-notes.txt' }); await expect(received).toBeVisible();
    const [download] = await Promise.all([other.waitForEvent('download'), received.click()]); expect(download.suggestedFilename()).toBe('pilot-notes.txt');
    const stream = await download.createReadStream(), parts: Buffer[] = []; for await (const part of stream!) parts.push(Buffer.from(part)); expect(Buffer.concat(parts)).toEqual(fileBytes);
    await other.getByRole('button', { name: 'Account settings', exact: true }).click(); await other.getByLabel('Language', { exact: true }).selectOption('fa-IR');
    await expect(other.locator('html')).toHaveAttribute('dir', 'rtl'); await expect(other.getByRole('button', { name: 'ذخیرهٔ نمایه', exact: true })).toBeVisible();
    await mkdir('artifacts/evidence', { recursive: true }); await other.screenshot({ path: 'artifacts/evidence/expansion-persian-settings.png' });
    await other.getByRole('button', { name: 'بستن پنجره', exact: true }).click(); await expect(other.getByRole('button', { name: 'ارسال پیام', exact: true })).toBeVisible();
    await other.screenshot({ path: 'artifacts/evidence/expansion-persian-chat.png' });
    await other.reload(); await expect(other.locator('html')).toHaveAttribute('dir', 'rtl'); expect((await api(other, '/auth/me')).user.language).toBe('fa-IR');
    expect(voice.kind).toBe('voice'); expect(blocked).toEqual([]);
    await writeFile('artifacts/evidence/expansion-restricted-network.json', JSON.stringify({ allowedOrigin, blockedForeignRequests: blocked, applicationRequests: requests, coverage: ['guest creation/refresh/conversion', 'messaging', 'channel navigation', 'authorized file upload/download', 'Persian preference and RTL'], limitations: ['Local loopback backend; not domestic DNS or nationwide outage certification', 'Media covered separately'] }, null, 2));
  } finally { await a.close(); await b.close(); }
});
test('detects Persian before login and switches language without restarting', async ({ browser }) => {
  const fa = await browser.newContext({ locale: 'fa-IR' }), page = await fa.newPage();
  try { await page.goto('/'); await expect(page.locator('html')).toHaveAttribute('dir', 'rtl'); await expect(page.getByRole('heading', { name: 'خوش آمدید.' })).toBeVisible(); await page.getByLabel('زبان', { exact: true }).selectOption('en-US'); await expect(page.locator('html')).toHaveAttribute('dir', 'ltr'); await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible(); }
  finally { await fa.close(); }
});
test('offers four capture modes and changes quality during a share without changing its lease', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['microphone'], locale: 'en-US' }), page = await context.newPage();
  await page.addInitScript(() => {
    (window as any).__captureCalls = [];
    navigator.mediaDevices.getDisplayMedia = async constraints => {
      (window as any).__captureCalls.push(constraints); const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360; const draw = canvas.getContext('2d')!; draw.fillStyle = '#826cf1'; draw.fillRect(0, 0, 640, 360);
      const stream = canvas.captureStream(30); (window as any).__screenTrack = stream.getVideoTracks()[0]; return stream;
    };
  });
  try {
    await register(page, `Quality${Date.now().toString().slice(-7)}`); const server = await api(page, '/servers', { name: 'Quality controls' }); await page.getByRole('button', { name: 'Open Quality controls', exact: true }).click();
    await page.getByRole('button', { name: 'Lounge', exact: true }).click(); await page.getByRole('button', { name: 'Connection diagnostics', exact: true }).click();
    const quality = page.getByLabel('Screen quality', { exact: true }); await expect(quality).toBeVisible(); expect(await quality.locator('option').evaluateAll(options => options.map(o => (o as HTMLOptionElement).value))).toEqual(['720p15', '720p30', '480p15', '480p30']);
    await quality.selectOption('480p15'); await page.getByRole('button', { name: 'Close dialog', exact: true }).click(); await page.getByRole('button', { name: 'Share screen', exact: true }).click();
    await expect.poll(async () => (await api(page, '/bootstrap')).voicePresence[0]?.shares).toBe(1);
    const channel = (await api(page, '/bootstrap')).channels.find((c: any) => c.serverId === server.id && c.kind === 'voice'), before = (await api(page, `/voice/${channel.id}`)).shares[0].id;
    expect(await page.evaluate(() => (window as any).__captureCalls[0].video.height.ideal)).toBe(480);
    await page.getByRole('button', { name: 'Connection diagnostics', exact: true }).click(); await quality.selectOption('720p30');
    await expect.poll(async () => page.evaluate(() => (window as any).__screenTrack.getConstraints().height?.max)).toBe(720);
    expect((await api(page, `/voice/${channel.id}`)).shares[0].id).toBe(before);
    expect(await page.evaluate(() => (window as any).__captureCalls.length)).toBe(1);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click(); await page.getByRole('button', { name: 'Stop sharing', exact: true }).click();
  } finally { await context.close(); }
});
test('compresses a large picture locally and offers an explicit preview before uploading', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US' }), page = await context.newPage();
  try {
    await register(page, `Picture${Date.now().toString().slice(-7)}`); await api(page, '/servers', { name: 'Picture lab' }); await page.getByRole('button', { name: 'Open Picture lab', exact: true }).click();
    const png = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 2048; canvas.height = 1152; const ctx = canvas.getContext('2d')!, pixels = ctx.createImageData(canvas.width, canvas.height); let n = 917;
      for (let i = 0; i < pixels.data.length; i += 4) { n ^= n << 13; n ^= n >>> 17; n ^= n << 5; pixels.data[i] = n & 255; pixels.data[i + 1] = (n >>> 8) & 255; pixels.data[i + 2] = (n >>> 16) & 255; pixels.data[i + 3] = 255; }
      ctx.putImageData(pixels, 0, 0); ctx.fillStyle = '#171522'; ctx.fillRect(0, 0, 1200, 160); ctx.fillStyle = '#fff'; ctx.font = '48px sans-serif'; ctx.fillText('Compression preview — readable sample', 25, 95);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const bytes = Buffer.from(png, 'base64'); expect(bytes.length).toBeGreaterThan(2 * 1048576);
    await page.locator('.file-composer input[type=file]').setInputFiles({ name: 'large-screenshot.png', mimeType: 'image/png', buffer: bytes });
    await expect(page.getByRole('img', { name: 'Compressed picture preview' })).toBeVisible(); await expect(page.locator('.attachment-draft')).toHaveCount(0);
    await page.screenshot({ path: 'artifacts/evidence/expansion-image-compression.png' });
    await page.getByRole('button', { name: 'Upload compressed picture', exact: true }).click(); await expect(page.locator('.attachment-draft')).toContainText('large-screenshot.webp');
    const usage = await api(page, '/uploads/usage'); expect(usage.usedBytes).toBeLessThanOrEqual(2 * 1048576); expect(usage.usedBytes).toBeGreaterThan(0);
  } finally { await context.close(); }
});
test('supports one-time recovery codes and audited temporary-password administration in the UI', async ({ browser }) => {
  const a = await browser.newContext({ locale: 'en-US' }), b = await browser.newContext({ locale: 'en-US' }), page = await a.newPage(), other = await b.newPage();
  const suffix = Date.now().toString().slice(-7), owner = `Admin${suffix}`, target = `Target${suffix}`;
  try {
    await register(page, owner); await register(other, target);
    await page.getByRole('button', { name: 'Account settings', exact: true }).click(); await page.getByText('Account recovery', { exact: true }).click(); await page.getByLabel('Password to confirm recovery setup', { exact: true }).fill('eight888');
    await page.getByRole('button', { name: 'Generate recovery codes', exact: true }).click(); const codes = (await page.locator('.recovery-codes pre').innerText()).trim().split('\n'); expect(codes).toHaveLength(8);
    await page.getByRole('button', { name: 'Hide codes', exact: true }).click(); await expect(page.locator('.recovery-codes')).toHaveCount(0);
    await page.getByText('Instance administration', { exact: true }).click(); await page.getByLabel('Single-use bootstrap secret', { exact: true }).fill('browser-fixture-bootstrap-not-for-deployment'); await page.getByRole('button', { name: 'Claim administration', exact: true }).click();
    await page.getByText('Global administration', { exact: true }).click(); await page.getByLabel('Confirm target username', { exact: true }).fill(target); await page.locator('.admin-user').filter({ hasText: target }).getByRole('button', { name: 'Temporary password', exact: true }).click();
    const temporary = await page.locator('.global-admin [role=status] code').innerText(); expect(temporary.length).toBe(20);
    await expect(other.getByRole('heading', { name: 'Welcome back.' })).toBeVisible(); await other.locator('.auth-form').getByLabel('Username', { exact: true }).fill(target); await other.locator('.auth-form').getByLabel('Password', { exact: true }).fill(temporary); await other.getByRole('button', { name: 'Let’s get you in', exact: true }).click();
    await expect(other.getByRole('heading', { name: 'Choose a new password', exact: true })).toBeVisible(); await other.getByLabel('Temporary password', { exact: true }).fill(temporary); await other.getByLabel('New password', { exact: true }).fill('changed88'); await other.getByRole('button', { name: 'Update password', exact: true }).click();
    await expect(other.getByRole('heading', { name: `Hey, ${target}.` })).toBeVisible();
    const audit = await api(page, '/admin/audit'); expect(audit.events.some((e: any) => e.action === 'admin.resetPassword')).toBe(true); expect(JSON.stringify(audit)).not.toContain(temporary);
  } finally { await a.close(); await b.close(); }
});
