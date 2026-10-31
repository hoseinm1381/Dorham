import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../apps/api/src/app';
import { config } from '../apps/api/src/config';
import { completeRecovery } from './browser/recovery-helper';
const executablePath = path.resolve(process.argv[2] || '');
if (!executablePath.endsWith('Dorham.exe')) throw Error('Pass the local test build Dorham.exe.');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'dorham-browser-desktop-audio-'));
if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('dorham-browser-desktop-audio-')) throw Error('Unexpected fixture path');
if (process.env.DORHAM_FIXTURE_MANIFEST) await writeFile(process.env.DORHAM_FIXTURE_MANIFEST, JSON.stringify({ nonce: process.env.DORHAM_FIXTURE_NONCE, dataDir: temporary, pid: process.pid }));
const backend = await createApp(config({ dataDir: path.join(temporary, 'server'), databaseUrl: '', mediaTransport: 'mesh', origins: ['dorham://app'] }), { logger: false, rateLimit: false });
await backend.app.listen({ host: '127.0.0.1', port: 0 });
const address = `http://127.0.0.1:${(backend.app.server.address() as any).port}`;
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')); delete env.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({ executablePath, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${path.join(temporary, 'profile')}`], env, timeout: 30000 });
try {
  const page = await desktop.firstWindow(); page.setDefaultTimeout(15000);
  await page.addInitScript(() => {
    (window as any).__noiseReady = 0;
    const Worklet = AudioWorkletNode;
    (window as any).AudioWorkletNode = new Proxy(Worklet, { construct(Target, args) {
      const node = new Target(args[0], args[1], args[2]);
      if (String(args[1]).includes('rnnoise')) { node.port.addEventListener('message', e => { if (e.data === 'ready') (window as any).__noiseReady++; }); node.port.start(); }
      return node;
    } });
  });
  await page.reload(); await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Server address', { exact: true }).fill(address); await page.getByLabel('Display name', { exact: true }).fill('Windows audio check');
  await page.getByLabel('Username', { exact: true }).fill(`win_audio_${Date.now().toString(36)}`); await page.getByLabel('Password', { exact: true }).fill('synthetic-local-fixture-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click(); await completeRecovery(page);
  await page.getByRole('button', { name: 'Account settings', exact: true }).click(); await page.locator('.avatar-options > summary').click();
  await expect(page.locator('.avatar-grid button')).toHaveCount(16); await page.getByRole('button', { name: 'Astronaut', exact: true }).click(); await expect(page.getByText('Profile picture saved.', { exact: true })).toBeVisible();
  await expect.poll(() => page.locator('.avatar-upload > .avatar img').evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(128);
  await page.getByRole('tab', { name: 'Audio', exact: true }).click(); await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Noise removal', exact: true }).selectOption('strong');
  await page.locator('.audio-voice-test > summary').click(); await page.getByRole('button', { name: 'Record voice test', exact: true }).click();
  await page.getByRole('button', { name: 'Stop recording', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Play voice test', exact: true }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Play voice test', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__noiseReady)).toBeGreaterThan(0);
  await expect(page.getByText('Strong noise removal is unavailable; Standard is active.', { exact: true })).toHaveCount(0);
  await page.locator('.audio-voice-test > summary').click(); await expect(page.getByRole('button', { name: 'Stop playback', exact: true })).toHaveCount(0);
  const preferences = await desktop.evaluate(({ BrowserWindow }) => (BrowserWindow.getAllWindows()[0].webContents as any).getLastWebPreferences());
  expect(preferences.sandbox).toBe(true); expect(preferences.contextIsolation).toBe(true); expect(preferences.nodeIntegration).toBe(false);
  await mkdir('artifacts/evidence', { recursive: true }); await page.screenshot({ path: 'artifacts/evidence/v077-windows-audio.png' });
  await writeFile('artifacts/evidence/v077-windows-audio.json', JSON.stringify({ executablePath, installed: !executablePath.includes('win-unpacked'), isolatedLocalBackend: true, nativeRegistration: true, presets: 16, presetUploadedAndDecoded: true, simpleAudio: true, strongWorkletReadyOnNativeProtocol: true, privatePlaybackPanelClose: true, sandbox: true, contextIsolation: true, nodeIntegration: false, physicalMicrophoneAcceptance: false, sfu: false }, null, 2));
  console.log('Local Windows audio/avatar checks passed, including RNNoise from the native protocol.');
} finally { await desktop.close(); await backend.app.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); }
