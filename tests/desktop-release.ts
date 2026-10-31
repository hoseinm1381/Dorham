import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../apps/api/src/app';
import { config } from '../apps/api/src/config';
const executablePath = path.resolve(process.argv[2] || '');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'dorham-browser-release-'));
if (path.dirname(temporary) !== path.resolve(os.tmpdir())) throw Error('Invalid fixture path');
if (process.env.DORHAM_FIXTURE_MANIFEST) await writeFile(process.env.DORHAM_FIXTURE_MANIFEST, JSON.stringify({ nonce: process.env.DORHAM_FIXTURE_NONCE, dataDir: temporary, pid: process.pid }));
const backend = await createApp(config({ dataDir: path.join(temporary, 'server'), databaseUrl: '', mediaTransport: 'mesh', origins: ['dorham://app'] }), { logger: false, rateLimit: false });
await backend.app.listen({ host: '127.0.0.1', port: 0 });
const address = `http://127.0.0.1:${(backend.app.server.address() as any).port}`;
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')); delete env.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({ executablePath, args: [`--user-data-dir=${path.join(temporary, 'profile')}`], env });
try {
  const page = await desktop.firstWindow(); page.setDefaultTimeout(20000);
  await desktop.evaluate(({ net, ipcMain }) => {
    const original = net.fetch.bind(net); (globalThis as any).__releaseFixtureVersion = '1.0.1';
    (net as any).fetch = (input: any, options: any) => {
      if (String(input) !== 'https://dorhamapp.ir/downloads/latest.json') return original(input, options);
      const version = (globalThis as any).__releaseFixtureVersion;
      return Promise.resolve(new Response(JSON.stringify({ schema: 1, version, windows: { version, appId: 'com.dorham.chat', size: 4096, sha256: 'a'.repeat(64), url: `https://dorhamapp.ir/downloads/${version}/Dorham-${version}-Windows-x64.exe` } })));
    };
    (globalThis as any).__releaseInstallCalls = 0;
    // This test checks native dispatch without executing an installer.
    ipcMain.removeHandler('update:install'); ipcMain.handle('update:install', () => { (globalThis as any).__releaseInstallCalls++; return { started: true }; });
  });
  await page.evaluate(address => (window as any).desktop.setServer(address), address); await page.reload();
  const appInfo = await page.evaluate(() => (window as any).desktop.getAppInfo()); expect(appInfo.version).toBe('1.0.0');
  await expect(page.getByRole('button', { name: 'Update 1.0.1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Update 1.0.1', exact: true }).click();
  expect(await desktop.evaluate(() => (globalThis as any).__releaseInstallCalls)).toBe(1);
  await desktop.evaluate(() => { (globalThis as any).__releaseFixtureVersion = '1.0.0'; }); await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any).desktop.checkUpdate())).toMatchObject({ current: '1.0.0', available: false });
  await expect(page.locator('.release-update')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/evidence/v100-windows-release.png' });
  await writeFile('artifacts/evidence/v100-windows-release.json', JSON.stringify({ executablePath, installed: !executablePath.includes('win-unpacked'), appInfo, nativeCheckUsesInstalledVersion: true, futureVersionNotice: true, equalVersionNoNotice: true, nativeInstallDispatch: true, installerExecuted: false, isolatedProfile: true }, null, 2));
  console.log('Packaged Windows update-check/notice/dispatch checks passed.');
} finally { await desktop.close(); await backend.app.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); }
