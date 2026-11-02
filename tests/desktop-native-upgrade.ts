import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { createGoApp } from './go-harness';
import { config } from '../apps/api/src/config';
import { completeRecovery } from './browser/recovery-helper';

// Run only through the guarded Windows wrapper, which backs up and restores the
// stable NSIS registry records, shortcuts and updater cache around this fixture.
const executablePath = path.resolve(process.argv[2] || '');
const installer = path.resolve(process.env.DORHAM_NATIVE_UPGRADE_INSTALLER || '');
if (process.env.DORHAM_NATIVE_UPGRADE_OWNED !== '1' || !executablePath.startsWith(path.resolve('artifacts/v1.1.0/installed-test') + path.sep) || installer !== path.resolve('artifacts/v1.1.0/windows/Dorham-1.1.0-Windows-x64.exe')) throw Error('Use the isolated native upgrade wrapper');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'dorham-browser-native-upgrade-'));
if (path.dirname(temporary) !== path.resolve(os.tmpdir())) throw Error('Invalid native fixture path');
if (process.env.DORHAM_FIXTURE_MANIFEST) await writeFile(process.env.DORHAM_FIXTURE_MANIFEST, JSON.stringify({ nonce: process.env.DORHAM_FIXTURE_NONCE, dataDir: temporary, pid: process.pid }));
const fixtureConfig = config({ dataDir: path.join(temporary, 'dorham-server'), databaseUrl: '', mediaTransport: 'mesh', origins: ['dorham://app'], stunUrls: [], turnUrls: [], cloudflareTurnKeyId: '', cloudflareTurnApiToken: '' });
const backend = await createGoApp(fixtureConfig);
fixtureConfig.origins.push(backend.url); fixtureConfig.publicUrl = backend.url; await backend.db.one('SELECT 1 AS ready');
const profile = path.join(temporary, 'profile'); await mkdir(profile);
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ server: backend.url, voiceOverlay: { enabled: false, position: 'bottom-right' }, upgradeFixtureSentinel: randomUUID() }));
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')); delete env.ELECTRON_RUN_AS_NODE;
let desktop: ElectronApplication | undefined;
async function stopDesktop() { await desktop?.evaluate(({ app }) => app.quit()).catch(() => {}); await desktop?.close(); desktop = undefined; }
async function startDesktop(expected: string) {
  desktop = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env, timeout: 45000 });
  const identity = await desktop.evaluate(({ app }) => ({ version: app.getVersion(), profile: app.getPath('userData') }));
  expect(identity.version).toBe(expected); expect(path.resolve(identity.profile).toLowerCase()).toBe(profile.toLowerCase());
  const page = await desktop.firstWindow(); page.setDefaultTimeout(20000); return page;
}
try {
  const username = `native_upgrade_${Date.now().toString(36)}`, password = 'Owned upgrade fixture password';
  const response = await fetch(`${backend.url}/api/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dorham-Native': '1' }, body: JSON.stringify({ requestId: randomUUID(), username, displayName: 'Native upgrade fixture', password }) });
  expect(response.status).toBe(201);
  let page = await startDesktop('1.0.7');
  await page.getByLabel('Username', { exact: true }).fill(username); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Let’s get you in', exact: true }).click(); await completeRecovery(page);
  await expect(page.locator('.app')).toBeVisible(); await expect(page.locator('.connection-light.connected')).toBeVisible();
  const oldSettings = JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8'));
  expect(oldSettings.secret).toBeTruthy(); expect(oldSettings.server).toBe(backend.url);
  expect(await page.evaluate(() => (window as any).desktop.getOverlay())).toEqual({ enabled: false, position: 'bottom-right' });
  await stopDesktop();
  console.log('Published Windows1.0.7 logged in against Go; closed before real in-place installer.');
  await promisify(execFile)(installer, ['/S', '/currentuser'], { windowsHide: true, timeout: 240000 });
  const afterInstall = JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8'));
  expect(afterInstall).toEqual(oldSettings);
  page = await startDesktop('1.1.0');
  await expect(page.locator('.app')).toBeVisible(); await expect(page.locator('.connection-light.connected')).toBeVisible();
  await expect(page.getByLabel('Username', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).desktop.getServer())).toBe(backend.url);
  expect(await page.evaluate(() => (window as any).desktop.getOverlay())).toEqual({ enabled: false, position: 'bottom-right' });
  expect(await page.evaluate(() => (window as any).desktop.getSecret())).toBeTruthy();
  // Exercise the installed native updater contract with an owned manifest only.
  // It must use the installed1.1.0 version, suppress equal/older notices, and
  // offer a future release; no external download or second installer is run.
  await desktop!.evaluate(({ net }) => {
    const original = net.fetch.bind(net); (globalThis as any).__upgradeLatest = '1.1.0';
    (net as any).fetch = (input: any, options: any) => {
      if (String(input) !== 'https://dorhamapp.ir/downloads/windows.json') return original(input, options);
      const version = (globalThis as any).__upgradeLatest;
      return Promise.resolve(new Response(JSON.stringify({ schema: 1, version, windows: { version, appId: 'com.dorham.chat', size: 4096, sha256: 'a'.repeat(64), url: `https://dorhamapp.ir/downloads/${version}/Dorham-${version}-Windows-x64.exe` } })));
    };
  });
  const checks = [];
  for (const [version, available] of [['1.1.0', false], ['1.0.7', false], ['1.1.1', true]] as const) {
    await desktop!.evaluate((_electron, value) => { (globalThis as any).__upgradeLatest = value; }, version);
    const result = await page.evaluate(() => (window as any).desktop.checkUpdate()); expect(result).toEqual({ current: '1.1.0', latest: version, available }); checks.push(result);
  }
  await page.screenshot({ path: 'artifacts/evidence/v110-native-windows-upgrade-login.png' });
  await writeFile('artifacts/evidence/v110-native-windows-upgrade-login.json', JSON.stringify({ from: '1.0.7', to: '1.1.0', actualInstallerExecuted: true, loginRetainedAcrossInstaller: true, windowsEncryptedCredentialReadableAfterUpgrade: true, sameProfile: true, nativeSettingsUnchangedDuringInstaller: true, serverPreserved: true, overlayPreferencesPreserved: true, isolatedProfile: true, goBackend: true, nativeUpdateChecks: checks }, null, 2));
  console.log('Real1.0.7→1.1.0 upgrade retained login, encrypted credentials, server and overlay preferences; installed updater checks passed.');
} finally {
  await stopDesktop(); await backend.app.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
