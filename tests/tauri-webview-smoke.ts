import { chromium, expect, type Browser } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { config } from '../apps/api/src/config';
import { completeRecovery } from './browser/recovery-helper';
import { createGoApp } from './go-harness';
import { proveCaptureBridge } from './tauri-capture-bridge';
import { proveAudioScopes } from './tauri-audio-scope';
import { proveProductSharing } from './tauri-product-sharing';
import { proveOverlay } from './tauri-overlay';
import { exportOwnedElectronProfile } from './tauri-legacy-profile';

const executable = path.resolve(process.env.DORHAM_TAURI_SMOKE_EXECUTABLE || 'apps/desktop-tauri/target/debug/Dorham.exe');
const owned = await mkdtemp(path.join(os.tmpdir(), 'dorham-tauri-smoke-'));
const profile = path.join(owned, 'profile');
const origin = 'https://localhost';
const legacy = process.env.DORHAM_LEGACY_EXECUTABLE;
const validator = path.resolve(process.env.DORHAM_TEST_MIGRATION_VALIDATOR || executable);
const product = process.env.DORHAM_PRODUCT_CAPTURE_FIXTURE;
const overlay = process.env.DORHAM_TEST_OVERLAY === '1';
const silent = process.env.DORHAM_TEST_SILENT === '1';
const packaged = process.env.DORHAM_TEST_PACKAGED_PROFILE === '1';
const upgradeFromTauri = process.env.DORHAM_TEST_TAURI_UPGRADE_EXECUTABLE;
const localIce = product && process.env.MEDIA_TRANSPORT === 'livekit' ? ' --disable-features=WebRtcHideLocalIpsWithMdns' : '';
const fixtureConfig = config({
  dataDir: path.join(owned, 'dorham-server'), databaseUrl: '',
  origins: [origin, 'dorham://app'], stunUrls: [], turnUrls: [],
});
const backend = await createGoApp(fixtureConfig);
if (product) {
  fixtureConfig.origins.push(backend.url);
  fixtureConfig.publicUrl = backend.url;
  await backend.db.one('SELECT 1 AS ready');
}
const username = `tauri_${Date.now().toString(36)}`;
const password = 'Owned Tauri smoke fixture password';
const displayName = 'Tauri smoke fixture';
let ownerToken = '';
async function register() {
  const registration = await fetch(backend.url + '/api/v1/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dorham-Native': '1', Origin: origin },
    body: JSON.stringify({ requestId: randomUUID(), username, password, displayName }),
  });
  expect(registration.status).toBe(201);
  expect(registration.headers.get('access-control-allow-origin')).toBe(origin);
  ownerToken = (await registration.json()).accessToken;
}
async function startDorham(runtime = executable, benchmark = packaged) {
  const port = await new Promise<number>((resolve, reject) => {
    const socket = net.createServer().once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string') { socket.close(); reject(new Error('No loopback port')); return; }
      socket.close(() => resolve(address.port));
    });
  });
  const child = spawn(runtime, benchmark ? ['--benchmark-profile', profile] : [], {
    cwd: path.dirname(runtime), windowsHide: true, stdio: 'inherit',
    env: {
      ...process.env, DORHAM_TEST_PROFILE_ROOT: profile,
      ...(product || overlay ? { DORHAM_TEST_DENY_MICROPHONE: '1' } : {}),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1${localIce}${silent ? ' --mute-audio' : ''}`,
    },
  });
  return { child, endpoint: `http://127.0.0.1:${port}` };
}
async function connectDorham({ child, endpoint }: Awaited<ReturnType<typeof startDorham>>) {
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`Dorham exited with code ${child.exitCode}`);
    return await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(1000) }).then(r => r.status, () => 0);
  }, { timeout: 30000 }).toBe(200);
  return chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 45000 });
}
async function stopDorham({ child }: Awaited<ReturnType<typeof startDorham>>, browser?: Browser) {
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await stopped;
  }
  await browser?.close().catch(() => {});
}
await mkdir(profile);
let migration: Awaited<ReturnType<typeof exportOwnedElectronProfile>> | undefined;
if (legacy) {
  try {
    await register();
    migration = await exportOwnedElectronProfile(legacy, validator, owned, profile, backend.url, username, password, ownerToken);
  } catch (error) {
    await backend.app.close();
    await rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    throw error;
  }
} else {
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ server: backend.url }));
}
let app = upgradeFromTauri ? await startDorham(path.resolve(upgradeFromTauri), false) : await startDorham();
let browser: Browser | undefined;
try {
  browser = await connectDorham(app);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 15000 });
  await expect(page).toHaveURL(origin + '/index.html', { timeout: 25000 });
  if (legacy) await expect(page.locator('.connection-light.connected')).toBeVisible({ timeout: 20000 });
  else await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible({ timeout: 20000 });
  const identity = await page.evaluate(async () => ({
    origin: location.origin, secure: isSecureContext, app: await window.desktop?.getAppInfo?.(), server: await window.desktop?.getServer(),
  }));
  const { version } = JSON.parse(await readFile(path.resolve('apps/desktop-tauri/tauri.conf.json'), 'utf8'));
  expect(identity).toEqual({ origin, secure: true, app: { version: upgradeFromTauri ? '1.3.0' : version, platform: 'windows' }, server: backend.url });
  const featureVersions = new Set<string>();
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === backend.url && url.pathname === '/api/v1/features' && url.searchParams.get('platform') === 'windows') {
      const reported = url.searchParams.get('version');
      if (reported) featureVersions.add(reported);
    }
  });

  if (migration) {
    await expect(page.locator('.account-info strong')).toHaveText(displayName);
    await expect(page.getByLabel('Username', { exact: true })).toHaveCount(0);
    const preferences = await page.evaluate(async keys => ({
      values: Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])),
      overlay: await window.desktop?.getOverlay?.(),
      direction: document.documentElement.dir,
    }), Object.keys(migration.expected));
    expect(preferences).toEqual({ values: migration.expected, overlay: migration.overlay, direction: 'rtl' });
    console.log(JSON.stringify({ electronExport: '1.2.8', nsisMigrationHook: true, sameAccount: true, protectedCredential: true, persian: true, draft: true, voiceHotkey: true, overlay: true }));
  } else {
    await register();
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Let’s get you in', exact: true }).click();
    await completeRecovery(page);
  }
  await expect(page.locator('.connection-light.connected')).toBeVisible({ timeout: 20000 });
  expect(await page.evaluate(async () => Boolean(await window.desktop?.getSecret()))).toBe(true);
  await page.reload();
  await expect(page.locator('.connection-light.connected')).toBeVisible({ timeout: 20000 });
  await expect(page.getByLabel('Username', { exact: true })).toHaveCount(0);
  if (packaged && !upgradeFromTauri) {
    await expect.poll(() => [...featureVersions], { timeout: 12000 }).toEqual([version]);
    console.log(JSON.stringify({ packagedWindowsFeatureVersion: version }));
  }
  console.log(JSON.stringify({ version: identity.app?.version, origin, secureContext: true, httpLogin: true, socketConnected: true, loginRetainedOnReload: true }));
  if (process.env.DORHAM_TEST_CUES === '1') {
    const response = await fetch(backend.url + '/api/v1/servers', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ requestId: randomUUID(), name: 'Owned cue fixture' }),
    });
    expect(response.ok).toBe(true);
    await response.body?.cancel();
    await page.reload();
    await page.evaluate(`{
      const contexts = window.__fixtureCueContexts = [];
      const cues = window.__fixtureCues = [];
      const origins = window.__fixtureCueOrigins = [];
      window.addEventListener('dorham-sound-played', event => cues.push(event.detail));
      window.AudioContext = new Proxy(window.AudioContext, {
        construct(target, args) {
          const context = Reflect.construct(target, args);
          contexts.push(context);
          origins.push(new Error().stack);
          return context;
        }
      });
    }`);
    const contexts = () => page.evaluate<string[]>('window.__fixtureCueContexts.map(context => context.state)');
    const cues = () => page.evaluate<string[]>('window.__fixtureCues.slice()');
    await page.getByRole('button', { name: 'Open Owned cue fixture', exact: true }).click();
    expect(await contexts(), JSON.stringify(await page.evaluate('window.__fixtureCueOrigins'))).toEqual([]);
    const send = async (text: string) => {
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
    };
    await send('First owned cue');
    await expect.poll(cues).toEqual(['sent']);
    await expect.poll(contexts, { timeout: 12000 }).toEqual(['closed']);
    await send('Second owned cue');
    await expect.poll(cues).toEqual(['sent', 'sent']);
    console.log(JSON.stringify({ idleCueAudioDeferred: true, sentCuePlayed: true, idleCueAudioReleased: true, subsequentCuePlayed: true }));
  }
  if (upgradeFromTauri) {
    const response = await fetch(backend.url + '/api/v1/servers', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ requestId: randomUUID(), name: 'Owned Tauri upgrade fixture' }),
    });
    expect(response.ok).toBe(true);
    await response.body?.cancel();
    await page.reload();
    await page.getByRole('button', { name: 'Open Owned Tauri upgrade fixture', exact: true }).click();
    const draft = 'Owned draft before the Tauri upgrade';
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(draft);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('dorham-drafts-v1') || '')).toContain(draft);
    const preferences = { enabled: true, position: 'top-right' } as const;
    await page.evaluate(value => window.desktop!.configureOverlay!(value), preferences);
    await stopDorham(app, browser);
    browser = undefined;
    app = await startDorham();
    browser = await connectDorham(app);
    const reopened = browser.contexts()[0];
    const upgraded = reopened.pages()[0] ?? await reopened.waitForEvent('page', { timeout: 15000 });
    await expect(upgraded.locator('.connection-light.connected')).toBeVisible({ timeout: 20000 });
    await expect(upgraded.locator('.account-info strong')).toHaveText(displayName);
    await expect(upgraded.getByLabel('Username', { exact: true })).toHaveCount(0);
    const retained = await upgraded.evaluate(async () => ({
      version: (await window.desktop!.getAppInfo!()).version,
      overlay: await window.desktop!.getOverlay!(),
      draft: localStorage.getItem('dorham-drafts-v1'),
    }));
    expect(retained).toMatchObject({ version, overlay: preferences });
    expect(retained.draft).toContain(draft);
    console.log(JSON.stringify({ tauriProfileFrom: '1.3.0', reopenedBy: version, sameAccount: true, draft: true, overlay: true }));
  }
  if (overlay) await proveOverlay(page, backend.url, ownerToken, displayName, app.child.pid!);
  if (process.env.DORHAM_CAPTURE_WINDOW_FIXTURE) {
    const compatibility = process.env.DORHAM_TEST_VIDEO_COMPATIBILITY === '1';
    if (compatibility) {
      await page.addInitScript(() => {
        const fetchFrame = window.fetch;
        window.fetch = (input, init) => fetchFrame(typeof input === 'string' && input.startsWith('/__dorham_media/video/') ? input.replace(/\?shared=1$/, '') : input, init);
      });
      await page.reload();
      await expect(page.locator('.connection-light.connected')).toBeVisible({ timeout: 20000 });
    }
    await proveCaptureBridge(page, process.env.DORHAM_CAPTURE_WINDOW_FIXTURE);
    if (compatibility) console.log(JSON.stringify({ videoBinaryResponseFallback: true }));
  }
  if (process.env.DORHAM_CAPTURE_AUDIO_FIXTURE) await proveAudioScopes(page, process.env.DORHAM_CAPTURE_AUDIO_FIXTURE);
  if (product) await proveProductSharing(page, backend.url, ownerToken, product, fixtureConfig.mediaTransport, app.child.pid!, silent);
  if (migration) {
    await stopDorham(app, browser);
    browser = undefined;
    app = await startDorham();
    browser = await connectDorham(app);
    const restarted = browser.contexts()[0];
    const restartedPage = restarted.pages()[0] ?? await restarted.waitForEvent('page', { timeout: 15000 });
    await expect(restartedPage.locator('.connection-light.connected')).toBeVisible({ timeout: 20000 });
    await expect(restartedPage.locator('.account-info strong')).toHaveText(displayName);
    await expect(restartedPage.getByLabel('Username', { exact: true })).toHaveCount(0);
    console.log(JSON.stringify({ loginRetainedOnRestart: true, sameAccount: true }));
  }
} finally {
  await stopDorham(app, browser);
  await backend.app.close();
  await rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
