import { chromium, expect, type Browser } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { config } from '../apps/api/src/config';
import { completeRecovery } from './browser/recovery-helper';
import { createGoApp } from './go-harness';
import { proveCaptureBridge } from './tauri-capture-bridge';
import { proveAudioScopes } from './tauri-audio-scope';
import { proveProductSharing } from './tauri-product-sharing';
import { exportOwnedElectronProfile } from './tauri-legacy-profile';

const executable = path.resolve('apps/desktop-tauri/target/debug/Dorham.exe');
const owned = await mkdtemp(path.join(os.tmpdir(), 'dorham-tauri-smoke-'));
const profile = path.join(owned, 'profile');
const origin = 'https://localhost';
const legacy = process.env.DORHAM_LEGACY_EXECUTABLE;
const product = process.env.DORHAM_PRODUCT_CAPTURE_FIXTURE;
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
let ownerToken = '';
async function register() {
  const registration = await fetch(backend.url + '/api/v1/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dorham-Native': '1', Origin: origin },
    body: JSON.stringify({ requestId: randomUUID(), username, password, displayName: 'Tauri smoke fixture' }),
  });
  expect(registration.status).toBe(201);
  expect(registration.headers.get('access-control-allow-origin')).toBe(origin);
  ownerToken = (await registration.json()).accessToken;
}
const port = await new Promise<number>((resolve, reject) => {
  const socket = net.createServer().once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const address = socket.address();
    if (!address || typeof address === 'string') { socket.close(); reject(new Error('No loopback port')); return; }
    socket.close(() => resolve(address.port));
  });
});
await mkdir(profile);
let migration: Awaited<ReturnType<typeof exportOwnedElectronProfile>> | undefined;
if (legacy) {
  try {
    await register();
    migration = await exportOwnedElectronProfile(legacy, executable, owned, profile, backend.url, username, password, ownerToken);
  } catch (error) {
    await backend.app.close();
    await rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    throw error;
  }
} else {
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ server: backend.url }));
}
const child = spawn(executable, [], {
  cwd: path.dirname(executable), windowsHide: true, stdio: 'inherit',
  env: {
    ...process.env, DORHAM_TEST_PROFILE_ROOT: profile,
    ...(product ? { DORHAM_TEST_DENY_MICROPHONE: '1' } : {}),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1${localIce}`,
  },
});
let browser: Browser | undefined;
try {
  const endpoint = `http://127.0.0.1:${port}`;
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`Dorham exited with code ${child.exitCode}`);
    return await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(1000) }).then(r => r.status, () => 0);
  }, { timeout: 30000 }).toBe(200);
  browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 45000 });
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 15000 });
  await expect(page).toHaveURL(origin + '/index.html');
  if (legacy) await expect(page.locator('.connection-light.connected')).toBeVisible({ timeout: 20000 });
  else await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible({ timeout: 20000 });
  const identity = await page.evaluate(async () => ({
    origin: location.origin, secure: isSecureContext, app: await window.desktop?.getAppInfo?.(), server: await window.desktop?.getServer(),
  }));
  expect(identity).toEqual({ origin, secure: true, app: { version: '1.3.0', platform: 'windows' }, server: backend.url });

  if (migration) {
    const preferences = await page.evaluate(async keys => ({
      values: Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])),
      overlay: await window.desktop?.getOverlay?.(),
      direction: document.documentElement.dir,
    }), Object.keys(migration.expected));
    expect(preferences).toEqual({ values: migration.expected, overlay: migration.overlay, direction: 'rtl' });
    console.log(JSON.stringify({ electronExport: '1.2.8', importedBeforeReact: true, protectedCredential: true, persian: true, draft: true, voiceHotkey: true, overlay: true }));
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
  console.log(JSON.stringify({ version: identity.app?.version, origin, secureContext: true, httpLogin: true, socketConnected: true, loginRetainedOnReload: true }));
  if (process.env.DORHAM_CAPTURE_WINDOW_FIXTURE) await proveCaptureBridge(page, process.env.DORHAM_CAPTURE_WINDOW_FIXTURE);
  if (process.env.DORHAM_CAPTURE_AUDIO_FIXTURE) await proveAudioScopes(page, process.env.DORHAM_CAPTURE_AUDIO_FIXTURE);
  if (product) await proveProductSharing(page, backend.url, ownerToken, product, fixtureConfig.mediaTransport);
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) {
    const stopped = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await stopped;
  }
  await backend.app.close();
  await rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
