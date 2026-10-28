import { _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app';
import { config } from '../apps/api/src/config';

// Run after installing into an isolated local directory. Never uses the normal user profile.
const executablePath = process.argv[2]; if (!executablePath) throw new Error('Pass the installed Dorham.exe path.');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'dorham-desktop-test-'));
const backend = await createApp(config({ dataDir: path.join(temporary, 'server'), origins: ['dorham://app'], databaseUrl: '' }), { logger: false, rateLimit: false });
await backend.app.listen({ host: '127.0.0.1', port: 0 });
const address = `http://127.0.0.1:${(backend.app.server.address() as any).port}`;
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')); delete env.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({ executablePath, args: [`--user-data-dir=${path.join(temporary, 'profile')}`], env, timeout: 30000 });
try {
  const page = await desktop.firstWindow(); await page.getByRole('heading', { name: 'Welcome back.' }).waitFor();
  const preferences = await desktop.evaluate(({ BrowserWindow }) => (BrowserWindow.getAllWindows()[0].webContents as any).getLastWebPreferences());
  assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
  assert.equal(await page.evaluate(() => typeof (window as any).require), 'undefined');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Server address', { exact: true }).fill(address); await page.getByLabel('Display name', { exact: true }).fill('Desktop check');
  await page.getByLabel('Username', { exact: true }).fill('desktop_check'); await page.getByLabel('Password', { exact: true }).fill('test-desktop-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click(); await page.getByRole('heading', { name: 'Hey, Desktop.' }).waitFor();
  const encrypted = await readFile(path.join(temporary, 'profile', 'settings.json'), 'utf8');
  const secret = await page.evaluate(() => window.desktop!.getSecret()); assert.ok(secret); assert.ok(!encrypted.includes(secret));
  await mkdir('artifacts/evidence', { recursive: true }); await page.screenshot({ path: 'artifacts/evidence/windows-installed.png' });
  await page.evaluate(() => window.desktop!.setInCall(true));
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const lifecycle = await desktop.evaluate(({ BrowserWindow }) => ({ windows: BrowserWindow.getAllWindows().length, visible: BrowserWindow.getAllWindows()[0].isVisible() }));
  assert.deepEqual(lifecycle, { windows: 1, visible: false });
  await writeFile('artifacts/evidence/windows-smoke.json', JSON.stringify({ testedAt: new Date().toISOString(), executablePath, installed: true, nativeRegistration: true, isolatedProfile: temporary, sandbox: true, contextIsolation: true, nodeIntegration: false, encryptedCredentials: true, trayCloseWhileInCall: 'window hidden, process retained', physicalMedia: 'untested' }, null, 2));
  console.log('Installed Windows app passed rendering, native registration, protected credentials, sandbox and background-close checks.');
} catch (error) {
  const page = await desktop.firstWindow(); await mkdir('artifacts/evidence', { recursive: true }); await page.screenshot({ path: 'artifacts/evidence/windows-failure.png' });
  console.error('Desktop failure state:', (await page.locator('body').innerText()).slice(-1800)); throw error;
} finally { await desktop.close(); await backend.app.close(); }
