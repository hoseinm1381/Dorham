import { test, expect, type Page } from '@playwright/test';
import { completeRecovery } from './recovery-helper';

test.use({ trace: 'off', launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio', '--autoplay-policy=no-user-gesture-required'] } });

async function register(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill(username);
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill('Dorham-test-feature-72');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await completeRecovery(page);
  await expect(page.locator('.app')).toBeVisible();
}

async function api(page: Page, path: string, data?: Record<string, unknown>, method = data ? 'POST' : 'GET') {
  return page.evaluate(async ({ path, data, method }) => {
    const session = await (await fetch('/api/v1/auth/me')).json();
    const response = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf }, body: data ? JSON.stringify({ ...data, requestId: crypto.randomUUID() }) : undefined });
    if (!response.ok) throw Error(await response.text());
    return response.json();
  }, { path, data, method });
}

test('signed-in clients pick up rank, 1080p permissions, and server soundboard without reinstalling', async ({ browser }) => {
  const adminContext = await browser.newContext({ permissions: ['microphone'] }), userContext = await browser.newContext({ permissions: ['microphone'] });
  const admin = await adminContext.newPage(), user = await userContext.newPage();
  try {
    const suffix = Date.now().toString().slice(-8);
    const sender = 'FeatureAdmin' + suffix;
    await register(admin, sender);
    await api(admin, '/admin/claim', { secret: 'browser-fixture-bootstrap-not-for-deployment' });
    await register(user, 'FeatureUser' + suffix);
    const identity = await api(user, '/auth/me');
    const space = await api(user, '/servers', { name: 'Features lab' });
    await user.getByRole('button', { name: 'Open Features lab', exact: true }).click();
    await user.getByRole('button', { name: 'Lounge', exact: true }).click();
    await user.getByRole('button', { name: 'Share screen', exact: true }).click();
    const dialog = user.getByRole('dialog', { name: 'Screen sharing' });
    const hd = dialog.getByRole('button', { name: /1080p/ });
    await expect(dialog).toBeVisible();
    await expect(hd).toHaveCount(0);
    await api(admin, '/admin/features/settings/screen', { visibility: 'locked', bitrate: 1400000 }, 'PUT');
    await expect(hd).toBeDisabled();
    await api(admin, '/admin/features/users/' + identity.user.id, { rank: 'max', feature: 'screen1080', enabled: true }, 'PUT');
    await api(admin, '/admin/features/settings/screen', { visibility: 'selected', bitrate: 1400000 }, 'PUT');
    await expect(hd).toBeEnabled();
    await hd.click();
    await expect(dialog.getByRole('status')).toContainText('1080p');
    await api(admin, '/admin/features/users/' + identity.user.id, { feature: 'screen1080', enabled: false }, 'PUT');
    await expect(hd).toHaveCount(0);
    await expect(dialog.getByRole('status')).toContainText('720p');
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await expect(user.getByRole('button', { name: 'Share screen', exact: true })).toBeVisible();

    const full = await api(user, '/features');
    const cached = await api(user, '/features?catalogVersion=' + full.catalogVersion);
    expect(cached.catalog).toBeUndefined();
    const available = full.catalog.filter((item: { kind: string; usable: boolean }) => item.kind === 'sound' && item.usable);
    expect(available).toHaveLength(7);
    const controls = user.locator('.voice-panel-actions');
    const launcher = controls.getByRole('button', { name: 'Soundboard', exact: true });
    const launchers = await Promise.all(['Share screen', 'Games', 'Soundboard'].map(name => controls.getByRole('button', { name, exact: true }).boundingBox()));
    expect(launchers.every(box => box && box.width <= 36 && box.height <= 36 && box.y === launchers[0]?.y)).toBe(true);
    await launcher.click();
    await expect(user.getByRole('dialog', { name: 'Soundboard' })).toBeVisible();
    const quack = user.getByRole('button', { name: 'Quack', exact: true });
    await expect(quack).toBeEnabled();
    const premium = await admin.evaluate(async url => {
      const me = await (await fetch('/api/v1/auth/me')).json();
      const clip = await (await fetch(url)).blob();
      const data = new FormData();
      data.set('kind', 'sound'); data.set('access', 'soundboardPlus');
      data.set('label', 'Private fixture clip'); data.set('file', clip, 'clip.wav');
      const response = await fetch('/api/v1/admin/features/catalog', { method: 'POST', headers: { 'X-CSRF-Token': me.csrf }, body: data });
      if (!response.ok) throw Error(await response.text());
      return response.json();
    }, available.find((item: { label: string }) => item.label === 'Quack').url);
    await api(admin, '/admin/features/catalog/' + premium.id, { active: true }, 'PUT');
    await expect(user.getByRole('button', { name: 'Private fixture clip', exact: true })).toHaveCount(0);
    const sound = user.waitForResponse(response => response.url().endsWith(available.find((item: { label: string }) => item.label === 'Quack').url));
    await quack.click();
    expect((await sound).headers()['content-type']).toContain('audio/wav');
    await api(admin, '/admin/features/users/' + identity.user.id, { feature: 'soundboardPlus', enabled: true }, 'PUT');
    await expect(user.getByRole('button', { name: 'Private fixture clip', exact: true })).toBeVisible();
    await user.getByRole('dialog', { name: 'Soundboard' }).getByRole('button', { name: 'Close dialog' }).click();
    await expect(launcher).toBeFocused();

    const invite = await api(user, `/servers/${space.id}/invites`, {});
    await api(admin, '/invites/join', { code: invite.code });
    async function join(page: Page) {
      await page.getByRole('button', { name: 'Open Features lab', exact: true }).click();
      await page.getByRole('button', { name: 'Lounge', exact: true }).click();
    }
    await join(admin);
    const participant = user.locator('.voice-mini-members button').filter({ hasText: sender });
    const menu = user.getByRole('menu', { name: 'Member actions' });
    const soundMute = menu.getByRole('menuitemcheckbox', { name: 'Mute their soundboard', exact: true });
    const soundUnmute = menu.getByRole('menuitemcheckbox', { name: 'Unmute their soundboard', exact: true });
    await participant.click({ button: 'right' });
    await soundMute.click();
    await expect(soundUnmute).toBeChecked();
    await expect(menu.getByRole('slider', { name: `Voice volume for ${sender}` })).toHaveValue('100');
    await user.reload();
    await join(user);
    await participant.click({ button: 'right' });
    await expect(soundUnmute).toBeChecked();
    await soundUnmute.press('Escape');

    const asset = (label: string) => available.find((item: { label: string }) => item.label === label).url;
    let mutedRequests = 0;
    await user.route(`**${asset('Airhorn')}`, route => { mutedRequests++; return route.continue(); });
    await admin.getByRole('button', { name: 'Soundboard', exact: true }).click();
    await admin.waitForTimeout(3100); // The earlier Quack may still hold the room cooldown.
    const sent = admin.waitForResponse(response => response.url().endsWith(asset('Airhorn')), { timeout: 10000 });
    await admin.getByRole('button', { name: 'Airhorn', exact: true }).click();
    await sent;
    await launcher.click();
    await user.waitForTimeout(3100); // The room allows one clip every three seconds.
    const otherSound = user.waitForResponse(response => response.url().endsWith(asset('Cricket')));
    await user.getByRole('button', { name: 'Cricket', exact: true }).click();
    expect((await otherSound).ok()).toBe(true);
    expect(mutedRequests).toBe(0);
    await user.getByRole('dialog', { name: 'Soundboard' }).getByRole('button', { name: 'Close dialog' }).click();
    await participant.click({ button: 'right' });
    await soundUnmute.click();
    await expect(soundMute).not.toBeChecked();
    await user.waitForTimeout(3100);
    const restored = user.waitForResponse(response => response.url().endsWith(asset('Doorbell')));
    await admin.getByRole('button', { name: 'Doorbell', exact: true }).click();
    expect((await restored).ok()).toBe(true);
  } finally {
    await Promise.all([adminContext.close(), userContext.close()]);
  }
});
