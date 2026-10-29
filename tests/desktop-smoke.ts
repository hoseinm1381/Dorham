import sharp from 'sharp';
import { RoomServiceClient } from 'livekit-server-sdk';
import { makeVideo } from './media-fixtures';
import { _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { isIP } from 'node:net';
import { createApp } from '../apps/api/src/app';
import { config } from '../apps/api/src/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';

// Run after installing into an isolated local directory. Never uses the normal user profile.
const executablePath = process.argv[2]; if (!executablePath) throw new Error('Pass the installed Dorham.exe path.');
const liveServer = process.env.DORHAM_SMOKE_SERVER_URL;
const displayName = liveServer ? 'Windows deployment check' : 'Desktop check';
const username = `desktop_${Date.now().toString(36)}`;
const testResolveIp = process.env.DORHAM_TEST_RESOLVE_IP;
if (testResolveIp && (!liveServer || !isIP(testResolveIp))) throw new Error('A test DNS override requires a live server and a valid IP.');
const instance = JSON.parse(await readFile('apps/web/src/instance.json', 'utf8'));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'dorham-desktop-test-'));
const backend = liveServer ? null : await createApp(config({ dataDir: path.join(temporary, 'server'), origins: ['dorham://app'], databaseUrl: '' }), { logger: false, rateLimit: false });
if (backend) await backend.app.listen({ host: '127.0.0.1', port: 0 });
const address = liveServer || `http://127.0.0.1:${(backend!.app.server.address() as any).port}`;
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')); delete env.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({ executablePath, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${path.join(temporary, 'profile')}`, ...(testResolveIp ? [`--host-resolver-rules=MAP ${new URL(address).hostname} ${testResolveIp}`] : [])], env, timeout: 30000 });
try {
  const page = await desktop.firstWindow(); await page.getByRole('heading', { name: 'Welcome back.' }).waitFor();
  page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/api/')) console.log('API', url.pathname, response.status()); });
  page.on('requestfailed', request => console.log('Request failed', new URL(request.url()).pathname, request.failure()?.errorText));
  const preferences = await desktop.evaluate(({ BrowserWindow }) => (BrowserWindow.getAllWindows()[0].webContents as any).getLastWebPreferences());
  assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
  assert.equal(await page.evaluate(() => typeof (window as any).require), 'undefined');
  assert.equal(await page.getByLabel('Server address', { exact: true }).inputValue(), instance.defaultServerUrl);
  let wssUpgrade: string | undefined;
  if (liveServer) wssUpgrade = await page.evaluate(async address => new Promise<string>((resolve, reject) => {
    const url = new URL(address); url.protocol = 'wss:'; url.pathname = '/socket.io/'; url.search = '?EIO=4&transport=websocket';
    const socket = new WebSocket(url), timeout = setTimeout(() => { socket.close(); reject(new Error('WSS upgrade timed out')); }, 15000);
    socket.onmessage = event => { if (String(event.data).startsWith('0{')) { clearTimeout(timeout); socket.close(); resolve('engine.io opening packet received over WSS'); } };
    socket.onerror = () => { clearTimeout(timeout); reject(new Error('WSS upgrade failed')); };
  }), address).catch(error => `failed: ${error.message}`);
  const polling = liveServer ? await page.evaluate(async address => {
    const response = await fetch(`${address}/socket.io/?EIO=4&transport=polling`);
    return response.ok && (await response.text()).startsWith('0{');
  }, address).catch(() => false) : undefined;
  if (liveServer) console.log('Hosted transports:', JSON.stringify({ wssUpgrade, polling }));
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Server address', { exact: true }).fill(address); await page.getByLabel('Display name', { exact: true }).fill(displayName);
  await page.getByLabel('Username', { exact: true }).fill(username); await page.getByLabel('Password', { exact: true }).fill(crypto.randomUUID());
  await page.getByRole('button', { name: 'Create account', exact: true }).click(); await page.getByRole('heading', { name: `Hey, ${displayName.split(' ')[0]}.` }).waitFor();
  await page.locator('.connection-light.connected').waitFor();
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  await page.getByRole('button', { name: 'Account settings', exact: true }).click(); await page.locator('.app-version').filter({ hasText: version }).waitFor();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const remoteAvatars = page.locator('img[src*="/avatars/"]');
  if (liveServer) {
    assert.ok(await remoteAvatars.count(), 'The hosted fixture has an uploaded avatar.');
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('img[src*="/avatars/"]')].every(image => image.complete && image.naturalWidth > 0));
  }
  let dmMessage: string | undefined;
  if (liveServer) {
    await page.getByRole('button', { name: 'Message Web deployment check', exact: true }).click();
    dmMessage = `Windows to web verification ${new Date().toISOString()}`;
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(dmMessage);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByTestId('message').filter({ hasText: dmMessage }).waitFor();
  }
  if (!liveServer) {
    await page.addInitScript(() => { navigator.mediaDevices.getDisplayMedia = async () => { const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360; const draw = canvas.getContext('2d')!; let frame = 0; const timer = setInterval(() => { draw.fillStyle = frame++ % 2 ? '#713ce0' : '#34bca5'; draw.fillRect(0, 0, 640, 360); }, 100); const stream = canvas.captureStream(12); (window as any).__desktopCapture = stream.getVideoTracks()[0]; stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer)); return stream; }; });
    await page.reload(); await page.getByRole('button', { name: 'Create a server', exact: true }).click(); await page.getByLabel('Server name', { exact: true }).fill('Desktop media fixture'); await page.getByRole('button', { name: 'Create space', exact: true }).click(); await page.getByRole('button', { name: 'Open Desktop media fixture', exact: true }).click();
    const image = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#34bca5' } }).png().toBuffer();
    await page.locator('.file-composer input[type=file]').setInputFiles({ name: 'desktop-picture.png', mimeType: 'image/png', buffer: image }); await page.locator('.attachment-draft').waitFor(); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.attachment-preview img')].some(img => img.naturalWidth === 320));
    await page.getByRole('button', { name: 'Open image: desktop-picture.png', exact: true }).click(); await page.getByRole('dialog', { name: 'Image viewer' }).waitFor(); await page.keyboard.press('Escape');
    const video = await makeVideo(page); await page.locator('.file-composer input[type=file]').setInputFiles({ name: 'desktop-clip.webm', mimeType: 'video/webm', buffer: video }); await page.locator('.attachment-draft').waitFor(); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const player = page.getByLabel('Play video: desktop-clip.webm', { exact: true }); await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>('.attachment-preview video')].some(v => v.videoWidth === 320)); await player.evaluate((v: HTMLVideoElement) => v.play());
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>('.attachment-preview video')].some(v => v.getVideoPlaybackQuality().totalVideoFrames > 1)); await player.evaluate((v: HTMLVideoElement) => v.pause());
    const mp4 = await readFile('tests/fixtures/inline-video.mp4'); await page.locator('.file-composer input[type=file]').setInputFiles({ name: 'desktop-movie.mp4', mimeType: 'video/mp4', buffer: mp4 }); await page.locator('.attachment-draft').waitFor(); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => { const v = document.querySelector<HTMLVideoElement>('video[aria-label="Play video: desktop-movie.mp4"]'); return v && v.videoWidth === 320; });
    await page.getByLabel('Play video: desktop-movie.mp4', { exact: true }).evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
    await page.waitForFunction(() => { const v = document.querySelector<HTMLVideoElement>('video[aria-label="Play video: desktop-movie.mp4"]'); return v && v.getVideoPlaybackQuality().totalVideoFrames > 1; }); await page.getByLabel('Play video: desktop-movie.mp4', { exact: true }).evaluate((v: HTMLVideoElement) => v.pause());
    await mkdir('artifacts/evidence', { recursive: true }); await page.screenshot({ path: 'artifacts/evidence/v04-windows-inline.png' });
    await page.getByRole('button', { name: 'Lounge', exact: true }).click(); await page.getByRole('button', { name: 'Share screen', exact: true }).click(); await page.getByRole('checkbox', { name: 'Preview my screen', exact: true }).check();
    await page.waitForFunction(() => { const v = document.querySelector<HTMLVideoElement>('.own-screen-preview video'); return v && v.videoWidth === 640 && v.getVideoPlaybackQuality().totalVideoFrames > 1; });
    await page.getByRole('button', { name: 'Hide my screen preview', exact: true }).click(); assert.equal(await page.evaluate(() => (window as any).__desktopCapture.readyState), 'live'); await page.getByRole('button', { name: 'Stop sharing', exact: true }).waitFor(); await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click();
    console.log('Installed Windows decoded inline image/video and optional own screen preview; hiding preview preserved capture.');
    if (process.env.DORHAM_TEST_HOTKEY_SENDER) {
      const sender = path.resolve(process.env.DORHAM_TEST_HOTKEY_SENDER), exec = promisify(execFile);
      const key = (value: 'down' | 'up') => exec(sender, [value], { windowsHide: true });
      await page.getByRole('button', { name: 'Account settings', exact: true }).click(); await page.getByLabel('Voice input mode', { exact: true }).selectOption('push'); await page.getByRole('button', { name: 'Record talk hotkey', exact: true }).click(); await page.keyboard.press('F9'); await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await page.getByRole('button', { name: 'Lounge', exact: true }).click();
      const microphone = async () => backend!.db.one('SELECT muted FROM voice_members WHERE user_id=(SELECT id FROM users WHERE username=?)', [username]);
      await expect.poll(async () => (await microphone())?.muted).toBe(1);
      const fixtureId = await desktop.evaluate(({ BrowserWindow }) => { const fixture = new BrowserWindow({ width: 420, height: 220, title: 'Dorham background hotkey test', webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } }); void fixture.loadURL('data:text/html,<title>Hotkey test</title><p>Isolated background input target</p>'); fixture.focus(); return fixture.id; });
      try {
        await key('up'); await new Promise(resolve => setTimeout(resolve, 1200)); await key('down'); await expect.poll(async () => (await microphone())?.muted).toBe(0); await key('up'); await expect.poll(async () => (await microphone())?.muted).toBe(1);
        await key('down'); await expect.poll(async () => (await microphone())?.muted).toBe(0);
        const parent = await desktop.evaluate(() => process.pid);
        await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'VoiceHotkey.exe' -and $_.ParentProcessId -eq ${parent} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { windowsHide: true });
        await expect.poll(async () => (await microphone())?.muted).toBe(1); await key('up');
        await desktop.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)?.destroy(); BrowserWindow.getAllWindows()[0].show(); }, fixtureId);
        await page.getByRole('button', { name: 'Account settings', exact: true }).click(); await page.getByLabel('Voice input mode', { exact: true }).selectOption('toggle'); await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide()); await new Promise(resolve => setTimeout(resolve, 1200));
        await key('down'); await expect.poll(async () => (await microphone())?.muted).toBe(0); await key('up'); await expect.poll(async () => (await microphone())?.muted).toBe(0); await key('down'); await expect.poll(async () => (await microphone())?.muted).toBe(1); await key('up');
        await key('down'); await expect.poll(async () => (await microphone())?.muted).toBe(0); await key('up');
        await desktop.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen')); await expect.poll(async () => (await microphone())?.muted).toBe(1); await desktop.evaluate(({ powerMonitor }) => powerMonitor.emit('unlock-screen'));
        await writeFile('artifacts/evidence/windows-background-hotkeys.json', JSON.stringify({ testedAt: new Date().toISOString(), actualWindowsKeyState: true, pushToTalkWhileAnotherWindowFocused: true, releaseMuted: true, helperCrashMuted: true, toggleWhileHidden: true, lockEventMuted: true, syntheticKeyInjection: true, elevatedGamesAndPhysicalKeyboard: 'untested' }, null, 2));
      } finally { await key('up'); await desktop.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)?.destroy(); BrowserWindow.getAllWindows()[0].show(); }, fixtureId); }
      await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click();
      console.log('Windows background PTT, release and toggle passed with actual OS key-state transitions.');
    }
  }
  const encrypted = await readFile(path.join(temporary, 'profile', 'settings.json'), 'utf8');
  const secret = await page.evaluate(() => window.desktop!.getSecret()); assert.ok(secret); assert.ok(!encrypted.includes(secret));
  await mkdir('artifacts/evidence', { recursive: true }); await page.screenshot({ path: 'artifacts/evidence/windows-installed.png' });
  await page.evaluate(() => window.desktop!.setInCall(true));
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const lifecycle = await desktop.evaluate(({ BrowserWindow }) => ({ windows: BrowserWindow.getAllWindows().length, visible: BrowserWindow.getAllWindows()[0].isVisible() }));
  assert.deepEqual(lifecycle, { windows: 1, visible: false });
  await writeFile(`artifacts/evidence/windows-${liveServer ? 'live-' : ''}smoke.json`, JSON.stringify({ testedAt: new Date().toISOString(), executablePath, server: address, defaultServer: instance.defaultServerUrl, username, displayName, dmMessage, remoteAvatarsLoaded: liveServer ? true : undefined, testResolveIp, installed: true, nativeRegistration: true, inlineImageDecoded: !liveServer, inlineVideoDecoded: !liveServer, optionalOwnScreenPreviewDecoded: !liveServer, mediaTransport: backend?.config.mediaTransport, socketConnected: true, wssUpgrade, polling, isolatedProfile: temporary, sandbox: true, contextIsolation: true, nodeIntegration: false, encryptedCredentials: true, trayCloseWhileInCall: 'window hidden, process retained', physicalMedia: 'untested' }, null, 2));
  console.log('Installed Windows app passed rendering, native registration, protected credentials, sandbox and background-close checks.');
} catch (error) {
  console.error('Desktop failure:', error);
  const page = await desktop.firstWindow(); await mkdir('artifacts/evidence', { recursive: true }); await page.screenshot({ path: 'artifacts/evidence/windows-failure.png', timeout: 5000 }).catch(() => {});
  console.error('Desktop failure state:', (await page.locator('body').innerText()).slice(-1800)); throw error;
} finally {
  await desktop.close();
  if (backend && process.env.DORHAM_SFU_ISOLATED_TEST === '1' && backend.config.mediaTransport === 'livekit') { const client = new RoomServiceClient(backend.config.livekitApiUrl, backend.config.livekitKey, backend.config.livekitSecret); for (const channel of await backend.db.all("SELECT id FROM channels WHERE kind='voice'")) await client.deleteRoom(channel.id).catch(() => {}); }
  await backend?.app.close();
}
