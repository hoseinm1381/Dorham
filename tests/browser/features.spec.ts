import { _electron, test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { completeRecovery } from './recovery-helper';

test.use({ trace: 'off', launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio', '--autoplay-policy=no-user-gesture-required'] } });

const fixturePassword = 'Dorham-test-feature-72';
async function register(page: Page, username: string, navigate = true) {
  if (navigate) await page.goto('/');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill(username);
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(fixturePassword);
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

test('Emoji Plus previews stay locked until granted and single custom emoji render large', async ({ browser, baseURL }, testInfo) => {
  const admin = await browser.newPage();
  const windows = process.env.DORHAM_EMOJI_WINDOWS_EXE;
  const android = process.env.DORHAM_EMOJI_ANDROID_WEB;
  const desktop = windows ? await _electron.launch({ executablePath: resolve(windows), args: [`--user-data-dir=${testInfo.outputPath('electron-profile')}`] }) : undefined;
  const user = desktop ? await desktop.firstWindow() : await browser.newPage(android ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' } : undefined);
  user.setDefaultTimeout(10000);
  if (desktop) {
    await user.evaluate(async origin => { await window.desktop!.setServer(origin!); }, baseURL);
    await user.reload();
    expect(await user.evaluate(async () => (await window.desktop?.getAppInfo?.())?.version)).toBe('1.2.2');
  } else if (android) {
    const root = resolve(android);
    await user.route(`${baseURL}/**`, route => {
      const { pathname } = new URL(route.request().url());
      const file = join(root, pathname === '/' ? 'index.html' : pathname.slice(1));
      return resolve(file).startsWith(root + sep) && existsSync(file) ? route.fulfill({ path: file }) : route.continue();
    });
    await user.addInitScript(origin => {
      localStorage.setItem('dorham.server', origin!);
      let secret: string | null = null;
      const plugins = {
        DorhamSecrets: ['get', 'set'], DorhamNotifications: ['info', 'consumeLink'],
        DorhamUpdates: ['info', 'check', 'getStatus', 'addListener', 'removeListener'],
        DorhamMedia: ['addListener', 'removeListener'], DorhamFiles: ['addListener', 'removeListener'],
      };
      Object.assign(window, {
        androidBridge: {},
        Capacitor: {
          PluginHeaders: Object.entries(plugins).map(([name, methods]) => ({ name, methods: methods.map(name => ({ name, rtype: name === 'addListener' ? 'callback' : 'promise' })) })),
          nativePromise: async (plugin: string, method: string, options: { value: string | null }) => {
            if (plugin === 'DorhamSecrets') { if (method === 'set') secret = options.value; return { value: secret }; }
            if (plugin === 'DorhamUpdates') return { current: '1.2.2', latest: '1.2.2', available: false };
            return {};
          },
          nativeCallback: async () => 'fixture-listener',
        },
      });
    }, baseURL);
  }
  try {
    const suffix = Date.now().toString().slice(-8);
    await register(admin, 'EmojiAdmin' + suffix);
    await api(admin, '/admin/claim', { secret: 'browser-fixture-bootstrap-not-for-deployment' });
    const username = 'EmojiUser' + suffix;
    await register(user, username, !desktop);
    if (android) await expect(user.locator('.app')).toHaveClass(/android-mobile/);
    let receivedCatalog: { label: string; kind: string; usable: boolean }[] = [];
    user.on('response', async response => {
      if (new URL(response.url()).pathname !== '/api/v1/features' || !response.ok()) return;
      const data = await response.json().catch(() => null);
      if (data?.catalog) receivedCatalog = data.catalog;
    });
    let accessToken = '';
    if (windows || android) {
      const response = await fetch(baseURL + '/api/v1/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dorham-Native': '1' },
        body: JSON.stringify({ username, password: fixturePassword, requestId: randomUUID() }),
      });
      expect(response.ok).toBe(true);
      accessToken = (await response.json()).accessToken;
    }
    async function userApi(path: string, body?: Record<string, unknown>) {
      if (!accessToken) return api(user, path, body);
      const response = await fetch(baseURL + '/api/v1' + path, {
        method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Dorham-Native': '1', Authorization: 'Bearer ' + accessToken },
        body: body ? JSON.stringify({ ...body, requestId: randomUUID() }) : undefined,
      });
      if (!response.ok) throw Error(await response.text());
      return response.json();
    }
    const identity = await userApi('/auth/me');
    const space = await userApi('/servers', { name: 'Emoji Plus lab' });
    if (android) await user.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
    await user.getByRole('button', { name: 'Open Emoji Plus lab', exact: true }).click();
    if (android) await user.getByRole('button', { name: 'Close navigation', exact: true }).click({ position: { x: 365, y: 420 } });
    const emoji = await admin.evaluate(async () => {
      const me = await (await fetch('/api/v1/auth/me')).json();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#b49afa';
      ctx.fillRect(8, 8, 48, 48);
      const png = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
      const data = new FormData();
      data.set('kind', 'emoji'); data.set('access', 'emojiPlus'); data.set('label', 'Sheep Scout');
      data.set('pack', 'Age of Empires IV'); data.set('file', png, 'sheep.png');
      const result = await fetch('/api/v1/admin/features/catalog', { method: 'POST', headers: { 'X-CSRF-Token': me.csrf }, body: data });
      if (!result.ok) throw Error(await result.text());
      return result.json();
    });
    await api(admin, '/admin/features/catalog/' + emoji.id, { active: true }, 'PUT');
    const input = user.getByRole('textbox', { name: 'Message', exact: true });
    await user.getByRole('button', { name: 'Add emoji', exact: true }).click();
    const picker = user.getByRole('dialog', { name: 'Emojis', exact: true });
    await picker.getByRole('button', { name: 'Custom packs', exact: true }).click();
    await picker.getByRole('searchbox').fill('Age of Empires IV');
    const locked = picker.getByRole('button', { name: 'Sheep Scout · Locked', exact: true });
    await expect(locked).toBeDisabled();
    await expect(locked.locator('.emoji-lock')).toBeVisible();
    await locked.dispatchEvent('click');
    await expect(input).toHaveValue('');

    await api(admin, '/admin/features/users/' + identity.user.id, { feature: 'emojiPlus', enabled: true }, 'PUT');
    const sheep = picker.getByRole('button', { name: 'Insert Sheep Scout', exact: true });
    await expect(sheep).toBeEnabled();
    await sheep.click();
    await expect(input).toHaveValue(':sheep-scout:');
    await input.press('Enter');
    const large = user.locator('.single-emoji img').and(user.getByRole('img', { name: 'Sheep Scout', exact: true }));
    await expect(large).toHaveCSS('width', '64px');
    await input.fill('Nice :sheep-scout:');
    await input.press('Enter');
    const inline = user.getByTestId('message').filter({ hasText: 'Nice' }).getByRole('img', { name: 'Sheep Scout', exact: true });
    await expect(inline).toBeVisible();
    await expect(inline).not.toHaveCSS('width', '64px');

    await api(admin, '/admin/features/users/' + identity.user.id, { feature: 'emojiPlus', enabled: false }, 'PUT');
    if (!await picker.isVisible()) await user.getByRole('button', { name: 'Add emoji', exact: true }).click();
    await expect(locked).toBeDisabled();
    await expect(large).toHaveCSS('width', '64px');
    const bootstrap = await userApi('/bootstrap');
    const channel = bootstrap.channels.find((item: { serverId: string; kind: string }) => item.serverId === space.id && item.kind === 'text');
    await expect(userApi('/messages', { conversationId: channel.conversationId, content: ':dx-' + emoji.id + ':' })).rejects.toThrow('FEATURE_REQUIRED');

    const catalog = await api(admin, '/features');
    const pngUrl = catalog.catalog.find((item: { id: string }) => item.id === emoji.id).url;
    const wavUrl = catalog.catalog.find((item: { kind: string }) => item.kind === 'sound').url;
    for (const asset of [
      { kind: 'avatar', label: 'Live profile fixture', url: pngUrl, name: 'profile.png' },
      { kind: 'sound', label: 'Live sound fixture', url: wavUrl, name: 'sound.wav' },
    ]) {
      const added = await admin.evaluate(async ({ kind, label, url, name }) => {
        const me = await (await fetch('/api/v1/auth/me')).json();
        const data = new FormData();
        data.set('kind', kind); data.set('access', 'free'); data.set('label', label); data.set('pack', 'Catalog test');
        data.set('file', await (await fetch(url)).blob(), name);
        const result = await fetch('/api/v1/admin/features/catalog', { method: 'POST', headers: { 'X-CSRF-Token': me.csrf }, body: data });
        if (!result.ok) throw Error(await result.text());
        return result.json();
      }, asset);
      await api(admin, '/admin/features/catalog/' + added.id, { active: true }, 'PUT');
      await expect.poll(() => receivedCatalog.some(item => item.label === asset.label && item.kind === asset.kind && item.usable)).toBe(true);
    }
  } finally {
    await Promise.all([admin.context().close(), desktop ? desktop.close() : user.context().close()]);
  }
});

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
