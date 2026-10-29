import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import project from '../../package.json' with { type: 'json' };
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
    const received = other.locator('.attachment-card').filter({ hasText: 'pilot-notes.txt' }); await expect(received).toBeVisible();
    const [download] = await Promise.all([other.waitForEvent('download'), received.getByRole('button', { name: 'Download pilot-notes.txt', exact: true }).click()]); expect(download.suggestedFilename()).toBe('pilot-notes.txt');
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
    await page.getByText('Instance administration', { exact: true }).click(); await page.getByLabel('One-time administrator setup code', { exact: true }).fill('browser-fixture-bootstrap-not-for-deployment'); await page.getByRole('button', { name: 'Activate global administration', exact: true }).click();
    await page.getByText('Global administration', { exact: true }).click(); await page.getByLabel('Confirm target username', { exact: true }).fill(target); await page.locator('.admin-user').filter({ hasText: target }).getByRole('button', { name: 'Temporary password', exact: true }).click();
    const temporary = await page.locator('.global-admin [role=status] code').innerText(); expect(temporary.length).toBe(20);
    await expect(other.getByRole('heading', { name: 'Welcome back.' })).toBeVisible(); await other.locator('.auth-form').getByLabel('Username', { exact: true }).fill(target); await other.locator('.auth-form').getByLabel('Password', { exact: true }).fill(temporary); await other.getByRole('button', { name: 'Let’s get you in', exact: true }).click();
    await expect(other.getByRole('heading', { name: 'Choose a new password', exact: true })).toBeVisible(); await other.getByLabel('Temporary password', { exact: true }).fill(temporary); await other.getByLabel('New password', { exact: true }).fill('changed88'); await other.getByRole('button', { name: 'Update password', exact: true }).click();
    await expect(other.getByRole('heading', { name: `Hey, ${target}.` })).toBeVisible();
    const audit = await api(page, '/admin/audit'); expect(audit.events.some((e: any) => e.action === 'admin.resetPassword')).toBe(true); expect(JSON.stringify(audit)).not.toContain(temporary);
  } finally { await a.close(); await b.close(); }
});

test('social update keeps invitations and custom roles visible, and refreshes changed profiles everywhere', async ({ browser }) => {
  const a = await browser.newContext({ locale: 'en-US' }), b = await browser.newContext({ locale: 'en-US' }), page = await a.newPage(), other = await b.newPage(), suffix = Date.now().toString().slice(-7), ownerName = `SocialA${suffix}`, memberName = `SocialB${suffix}`;
  try {
    await register(page, ownerName); await register(other, memberName);
    const server = await api(page, '/servers', { name: 'Social settings lab' }), invite = await api(page, `/servers/${server.id}/invites`, {});
    await api(other, '/invites/join', { code: invite.code });
    for (const p of [page, other]) await p.getByRole('button', { name: 'Open Social settings lab', exact: true }).click();
    await other.getByLabel('Message', { exact: true }).fill('My profile will change'); await other.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByText('My profile will change', { exact: true })).toBeVisible();
    await page.locator('.members-sidebar .member-row').filter({ hasText: memberName }).click();
    await other.getByRole('button', { name: 'Account settings', exact: true }).click();
    await expect(other.locator('.app-version')).toHaveText(`Dorham · Version ${project.version}`);
    await other.getByLabel('Display name', { exact: true }).fill('Updated member'); await other.getByLabel('About you', { exact: true }).fill('Updated biography');
    await other.getByRole('button', { name: 'Save your profile', exact: true }).click();
    await expect(page.getByRole('dialog').getByText('Updated member', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('Updated biography', { exact: true })).toBeVisible();
    await expect(page.locator('.message-byline button')).toHaveText('Updated member');
    const image = await other.evaluate(async () => { const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512; const ctx = canvas.getContext('2d')!, pixels = ctx.createImageData(512, 512); crypto.getRandomValues(new Uint8Array(65536)); for (let offset = 0; offset < pixels.data.length; offset += 65536) crypto.getRandomValues(pixels.data.subarray(offset, Math.min(offset + 65536, pixels.data.length))); for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = 255; ctx.putImageData(pixels, 0, 0); return canvas.toDataURL('image/png').split(',')[1]; });
    expect(Buffer.from(image, 'base64').length).toBeGreaterThan(256 * 1024);
    await other.locator('.avatar-upload input[type=file]').setInputFiles({ name: 'large-profile.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
    await expect(page.getByRole('dialog').locator('.avatar img')).toBeVisible();
    await expect.poll(async () => page.getByRole('dialog').locator('.avatar img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 128)).toBe(true);
    const avatar = (await api(other, '/auth/me')).user.avatar; expect(avatar).toMatch(/^\/avatars\/.+\.webp$/);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click(); await other.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await other.reload(); await expect(other.locator('.account-info strong')).toHaveText('Updated member');
    await page.locator('.space-heading').click(); await page.getByRole('button', { name: 'Create invite link', exact: true }).click();
    await expect(page.locator('.saved-invite')).toHaveCount(2); const links = await page.getByRole('textbox', { name: 'Invite link', exact: true }).evaluateAll(inputs => inputs.map(i => (i as HTMLInputElement).value));
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click(); await page.locator('.space-heading').click();
    await expect(page.locator('.saved-invite')).toHaveCount(2); expect(await page.getByRole('textbox', { name: 'Invite link', exact: true }).evaluateAll(inputs => inputs.map(i => (i as HTMLInputElement).value))).toEqual(links);
    await page.getByRole('button', { name: 'Custom roles', exact: true }).click(); await page.getByLabel('Role name', { exact: true }).fill('Trusted speaker'); await page.getByLabel('Role color', { exact: true }).fill('#68b6ec'); await page.getByLabel('Create and revoke invitations', { exact: true }).selectOption('true'); await page.getByLabel('Send messages', { exact: true }).selectOption('false'); await page.getByRole('button', { name: 'Create role', exact: true }).click();
    const assignments = page.locator('.role-assignments').filter({ hasText: 'Updated member' }); await assignments.getByRole('checkbox', { name: 'Trusted speaker' }).check();
    await expect.poll(async () => (await api(other, '/bootstrap')).servers[0].permissions.createInvites).toBe(true);
    await other.getByRole('button', { name: 'Open Social settings lab', exact: true }).click(); await expect(other.getByLabel('Message', { exact: true })).toBeDisabled();
    await expect(other.locator('.members-sidebar .role-chip').filter({ hasText: 'Trusted speaker' })).toBeVisible();
    await page.screenshot({ path: 'artifacts/evidence/social-custom-roles.png' });
  } finally { await a.close(); await b.close(); }
});

test('social update notifies direct messages with sound, persistent markers and do-not-disturb control', async ({ browser }) => {
  const a = await browser.newContext({ locale: 'en-US' }), b = await browser.newContext({ locale: 'en-US' }), page = await a.newPage(), other = await b.newPage(), suffix = Date.now().toString().slice(-7);
  for (const p of [page, other]) await p.addInitScript(() => { (window as any).__cues = []; window.addEventListener('dorham-sound-played', e => (window as any).__cues.push((e as CustomEvent).detail)); });
  try {
    await register(page, `NotifyA${suffix}`); await register(other, `NotifyB${suffix}`);
    const me = (await api(other, '/auth/me')).user, dm = await api(page, '/dms', { userId: me.id });
    await expect(other.locator('.dm-item')).toHaveCount(1);
    await page.locator('.dm-item').click(); await page.getByLabel('Message', { exact: true }).fill('Notification hello'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(other.locator('.message-notice')).toContainText('New message from'); await expect(other.locator('.dm-item .unread-dot')).toHaveCount(1); await expect(other.locator('.home-unread')).toHaveCount(1);
    await expect.poll(() => other.evaluate(() => (window as any).__cues.includes('message'))).toBe(true); await expect.poll(() => page.evaluate(() => (window as any).__cues.includes('sent'))).toBe(true);
    const before = await other.evaluate(() => (window as any).__cues.length), sent = (await api(page, `/conversations/${dm.id}/messages`)).messages[0];
    await api(page, `/messages/${sent.id}`, { content: 'Edited without notification' }, 'PATCH'); await other.waitForTimeout(250); expect(await other.evaluate(() => (window as any).__cues.length)).toBe(before);
    await other.locator('.message-notice > button').first().click(); await expect(other.getByText('Edited without notification', { exact: true })).toBeVisible(); await expect(other.locator('.message-notice')).toHaveCount(0); await expect(other.locator('.dm-item .unread-dot')).toHaveCount(0);
    await other.getByRole('button', { name: 'Home', exact: true }).click();
    await api(other, '/profile', { displayName: me.displayName, bio: '', status: 'busy' }, 'PATCH'); await expect(other.locator('.account-info small')).toHaveText('busy');
    await page.getByLabel('Message', { exact: true }).fill('Quiet notification'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(other.locator('.message-notice')).toBeVisible(); expect(await other.evaluate(() => (window as any).__cues.length)).toBe(before);
    await other.getByRole('button', { name: 'Account settings', exact: true }).click(); await other.getByRole('checkbox', { name: 'Direct message sounds', exact: true }).uncheck(); await other.reload(); await other.getByRole('button', { name: 'Account settings', exact: true }).click(); await expect(other.getByRole('checkbox', { name: 'Direct message sounds', exact: true })).not.toBeChecked();
  } finally { await a.close(); await b.close(); }
});

test('social update minimizes voice, preserves same-channel calls and chimes on membership changes', async ({ browser }) => {
  const a = await browser.newContext({ permissions: ['microphone'], locale: 'en-US' }), b = await browser.newContext({ permissions: ['microphone'], locale: 'en-US' }), page = await a.newPage(), other = await b.newPage(), suffix = Date.now().toString().slice(-7);
  for (const p of [page, other]) await p.addInitScript(() => { (window as any).__cues = []; window.addEventListener('dorham-sound-played', e => (window as any).__cues.push((e as CustomEvent).detail)); });
  try {
    await register(page, `ChimeA${suffix}`); await register(other, `ChimeB${suffix}`);
    const server = await api(page, '/servers', { name: 'Compact voice lab' }), invite = await api(page, `/servers/${server.id}/invites`, {}); await api(other, '/invites/join', { code: invite.code });
    for (const p of [page, other]) await p.getByRole('button', { name: 'Open Compact voice lab', exact: true }).click();
    await page.getByRole('button', { name: 'Lounge', exact: true }).click(); await expect(page.locator('.voice-stage')).toHaveClass(/voice-collapsed/); expect((await page.locator('.voice-stage').boundingBox())!.height).toBeLessThanOrEqual(45);
    const voice = (await api(page, '/bootstrap')).channels.find((c: any) => c.serverId === server.id && c.kind === 'voice'), memberId = (await api(page, '/auth/me')).user.id;
    const initial = (await api(page, `/voice/${voice.id}`)).members.find((m: any) => m.user.id === memberId);
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Lounge', exact: true }).click();
    expect((await api(page, `/voice/${voice.id}`)).members.find((m: any) => m.user.id === memberId).epoch).toBe(initial.epoch);
    const joined = await page.evaluate(() => (window as any).__cues.filter((s: string) => s === 'join').length); expect(joined).toBe(1);
    await other.getByRole('button', { name: 'Lounge', exact: true }).click(); await expect.poll(() => page.evaluate(() => (window as any).__cues.filter((s: string) => s === 'join').length)).toBe(2);
    await page.getByRole('button', { name: 'Voice controls', exact: true }).click(); await expect(page.locator('.voice-stage')).not.toHaveClass(/voice-collapsed/); await expect(page.getByRole('slider')).toBeVisible();
    await other.getByRole('button', { name: 'Disconnect voice', exact: true }).click(); await expect.poll(() => page.evaluate(() => (window as any).__cues.filter((s: string) => s === 'leave').length)).toBe(1);
    await page.getByRole('button', { name: 'Minimize voice', exact: true }).click(); await expect(page.locator('.voice-stage')).toHaveClass(/voice-collapsed/);
    await page.screenshot({ path: 'artifacts/evidence/social-compact-voice.png' });
  } finally { await a.close(); await b.close(); }
});

test('social update closes and blocks DMs and lets members leave a server without deleting history', async ({ browser }) => {
  const a = await browser.newContext({ locale: 'en-US' }), b = await browser.newContext({ locale: 'en-US' }), page = await a.newPage(), other = await b.newPage(), suffix = Date.now().toString().slice(-7);
  try {
    await register(page, `LeaveA${suffix}`); await register(other, `LeaveB${suffix}`);
    const me = (await api(other, '/auth/me')).user, dm = await api(page, '/dms', { userId: me.id }); await page.locator('.dm-item').click();
    await page.getByLabel('Message', { exact: true }).fill('Preserved private history'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await other.locator('.dm-item').click(); await expect(other.getByText('Preserved private history', { exact: true })).toBeVisible();
    await other.getByRole('button', { name: 'Block person', exact: true }).click(); await expect(other.getByRole('button', { name: 'Unblock person', exact: true })).toBeVisible(); await expect(page.locator('.blocked-chat-note')).toBeVisible(); await expect(page.getByLabel('Message', { exact: true })).toBeDisabled();
    await other.getByRole('button', { name: 'Close chat', exact: true }).click(); await expect(other.locator('.dm-item')).toHaveCount(0); await expect(page.locator('.dm-item')).toHaveCount(1);
    await other.getByRole('button', { name: 'Account settings', exact: true }).click(); await other.getByText('Blocked people', { exact: false }).click(); await other.getByRole('button', { name: 'Unblock person', exact: true }).click(); await other.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(page.getByLabel('Message', { exact: true })).toBeEnabled(); await page.getByLabel('Message', { exact: true }).fill('A new DM reopens chat'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(other.locator('.dm-item')).toHaveCount(1); await other.locator('.dm-item').click(); await expect(other.getByText('Preserved private history', { exact: true })).toBeVisible(); await expect(other.getByText('A new DM reopens chat', { exact: true })).toBeVisible();
    expect((await api(other, `/conversations/${dm.id}/messages`)).messages).toHaveLength(2);
    const server = await api(page, '/servers', { name: 'Server leaving lab' }), invite = await api(page, `/servers/${server.id}/invites`, {}); await api(other, '/invites/join', { code: invite.code });
    await other.getByRole('button', { name: 'Open Server leaving lab', exact: true }).click(); await other.getByLabel('Message', { exact: true }).fill('Public history remains'); await other.getByRole('button', { name: 'Send message', exact: true }).click(); await other.locator('.space-heading').click(); await other.getByText('Leave server', { exact: true }).click(); await other.getByRole('button', { name: 'Confirm leave server', exact: true }).click(); await expect(other.getByRole('button', { name: 'Open Server leaving lab', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Open Server leaving lab', exact: true }).click(); await expect(page.getByText('Public history remains', { exact: true })).toBeVisible();
  } finally { await a.close(); await b.close(); }
});
