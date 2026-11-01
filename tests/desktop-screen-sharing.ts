import { _electron as electron, chromium, expect as baseExpect, type Page } from '@playwright/test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../apps/api/src/app';
import { config } from '../apps/api/src/config';
import { completeRecovery } from './browser/recovery-helper';
const expect = baseExpect.configure({ timeout: 15000 });

// Real Windows capture, restricted to an owned animated fixture window. Only
// picker choices are automated; getDisplayMedia and the media path are real.
const executablePath = process.argv[2];
if (!executablePath) throw Error('Pass the local Windows Dorham.exe path.');
const temp = await mkdtemp(path.join(os.tmpdir(), 'dorham-browser-native-share-'));
if (path.dirname(temp) !== os.tmpdir() || !path.basename(temp).startsWith('dorham-browser-native-share-')) throw Error('Unexpected owned fixture path');
if (process.env.DORHAM_FIXTURE_MANIFEST) await writeFile(process.env.DORHAM_FIXTURE_MANIFEST, JSON.stringify({ nonce: process.env.DORHAM_FIXTURE_NONCE, dataDir: temp, pid: process.pid }));
const backend = await createApp(config({ dataDir: path.join(temp, 'server'), databaseUrl: '', mediaTransport: 'mesh', origins: ['dorham://app', 'http://127.0.0.1:3101'], stunUrls: [], turnUrls: [], turnUsername: '', turnPassword: '', turnSecret: '', cloudflareTurnKeyId: '', cloudflareTurnApiToken: '' }), { logger: false, rateLimit: false });
await backend.app.listen({ host: '127.0.0.1', port: 3101 });
const address = 'http://127.0.0.1:3101';
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')); delete env.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({ executablePath: path.resolve(executablePath), args: [`--user-data-dir=${path.join(temp, 'profile')}`, '--autoplay-policy=no-user-gesture-required'], env });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const suffix = Date.now().toString(36), password = 'Native-share-isolated-fixture';
  async function api(route: string, token?: string, body?: any) {
    const response = await fetch(address + '/api/v1' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Dorham-Native': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify({ requestId: randomUUID(), ...body }) : undefined });
    if (!response.ok) throw Error(`Fixture API ${route}: ${response.status} ${await response.text()}`);
    return response.json();
  }
  const owner = await api('/auth/register', undefined, { username: `share_owner_${suffix}`, displayName: 'Windows sharer', password });
  const viewer = await api('/auth/register', undefined, { username: `share_viewer_${suffix}`, displayName: 'Stream viewer', password });
  const server = await api('/servers', owner.accessToken, { name: 'Native screen fixture' });
  const invite = await api(`/servers/${server.id}/invites`, owner.accessToken, {});
  await api('/invites/join', viewer.accessToken, { code: invite.code });
  const channel = (await api('/bootstrap', owner.accessToken)).channels.find((c: any) => c.serverId === server.id && c.kind === 'voice');
  const page = await desktop.firstWindow(), receiver = await browser.newPage();
  page.setDefaultTimeout(15000); receiver.setDefaultTimeout(15000);
  // No physical microphone access is needed for this video-only regression.
  const noMicrophone = "navigator.mediaDevices.getUserMedia = async function(){throw new DOMException('Fixture has no microphone','NotAllowedError')};";
  await page.addInitScript(noMicrophone); await receiver.addInitScript(noMicrophone);
  const peers = "window.__sharePeers=[];window.RTCPeerConnection=class extends RTCPeerConnection{constructor(...args){super(...args);window.__sharePeers.push(this)}}";
  await page.addInitScript(peers); await receiver.addInitScript(peers);
  await page.evaluate(address => (window as any).desktop.setServer(address), address); await page.reload(); await receiver.goto(address);
  async function login(p: Page, username: string) {
    await p.getByLabel('Username', { exact: true }).fill(username); await p.getByLabel('Password', { exact: true }).fill(password);
    await p.getByRole('button', { name: 'Let’s get you in', exact: true }).click(); await completeRecovery(p);
    await p.getByRole('button', { name: 'Open Native screen fixture', exact: true }).click(); await p.getByRole('button', { name: 'Lounge', exact: true }).click();
    await expect(p.locator('.gaming-voice')).toBeVisible();
  }
  await login(page, `share_owner_${suffix}`); await login(receiver, `share_viewer_${suffix}`);
  await desktop.evaluate(async ({ BrowserWindow, desktopCapturer, dialog }) => {
    const fixture = new BrowserWindow({ title: 'Dorham owned capture fixture', width: 500, height: 350, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
    await fixture.loadURL('data:text/html,<title>Dorham owned capture fixture</title><body style="background:%234682aa;color:white">Native screen capture test</body>');
    await fixture.webContents.executeJavaScript("setInterval(()=>document.body.style.background=Date.now()%400<200?'#4682aa':'#20ba50',100)");
    const original = desktopCapturer.getSources.bind(desktopCapturer);
    desktopCapturer.getSources = async options => (await original(options)).filter(source => source.name === 'Dorham owned capture fixture');
    (globalThis as any).__nativeShare = { cancel: true, pickerCalls: 0, selectedOwnedWindow: 0 };
    dialog.showMessageBox = async (...args: any[]) => {
      const options = args.at(-1), state = (globalThis as any).__nativeShare;
      state.pickerCalls++; const index = options.buttons.indexOf('Dorham owned capture fixture');
      if (!state.cancel && index >= 0) state.selectedOwnedWindow++;
      return { response: state.cancel || index < 0 ? options.cancelId : index, checkboxChecked: false };
    };
  });
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  const popup = page.getByRole('dialog', { name: 'Screen sharing', exact: true });
  await popup.getByRole('button', { name: 'Choose screen', exact: true }).click();
  await expect(popup.getByRole('button', { name: 'Choose screen', exact: true })).toBeEnabled();
  await expect.poll(async () => (await api(`/voice/${channel.id}`, owner.accessToken)).shares.length).toBe(0);
  await desktop.evaluate(() => { (globalThis as any).__nativeShare.cancel = false; });
  await popup.getByRole('button', { name: 'Choose screen', exact: true }).click(); await expect(popup).toBeHidden();
  await receiver.getByRole('button', { name: 'Watch stream', exact: true }).click();
  const video = receiver.locator('.screen video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(5);
  const decoded = await video.evaluate((v: HTMLVideoElement) => ({ width: v.videoWidth, height: v.videoHeight, frames: v.getVideoPlaybackQuality().totalVideoFrames }));
  expect(decoded.width).toBeGreaterThan(100); expect(decoded.height).toBeGreaterThan(100);
  await receiver.screenshot({ path: 'artifacts/evidence/v107-native-screen-receiver.png' });
  await page.getByRole('button', { name: 'Stop sharing', exact: true }).click(); await expect(video).toHaveCount(0);
  await expect.poll(async () => (await api(`/voice/${channel.id}`, owner.accessToken)).shares.length).toBe(0);
  // A stopped share must be able to request the native picker again.
  await page.getByRole('button', { name: 'Share screen', exact: true }).click(); await popup.getByRole('button', { name: 'Choose screen', exact: true }).click(); await expect(popup).toBeHidden();
  await receiver.getByRole('button', { name: 'Watch stream', exact: true }).click();
  try { await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(3); }
  catch (error) {
    const diagnostics = [];
    for (const p of [page, receiver]) diagnostics.push(await p.evaluate(async () => {
      const video = document.querySelector<HTMLVideoElement>('.screen video');
      return { video: video && { width: video.videoWidth, height: video.videoHeight, paused: video.paused, tracks: (video.srcObject as MediaStream)?.getTracks().map(t => ({ id: t.id, state: t.readyState, enabled: t.enabled, muted: t.muted })) }, peers: await Promise.all(((window as any).__sharePeers as RTCPeerConnection[]).map(async pc => ({ state: pc.connectionState, senders: pc.getSenders().map(s => ({ track: s.track && { id: s.track.id, state: s.track.readyState, enabled: s.track.enabled } })), stats: [...(await pc.getStats()).values()].filter(r => ['inbound-rtp','outbound-rtp'].includes(r.type) && r.kind === 'video') }))) };
    }));
    await writeFile('artifacts/evidence/v107-native-screen-restart-diagnostics.json', JSON.stringify(diagnostics, null, 2)); throw error;
  }
  await page.getByRole('button', { name: 'Stop sharing', exact: true }).click(); await expect(video).toHaveCount(0);
  const picker = await desktop.evaluate(() => (globalThis as any).__nativeShare);
  expect(picker.pickerCalls).toBe(3); expect(picker.selectedOwnedWindow).toBe(2);
  await writeFile('artifacts/evidence/v107-native-screen-sharing.json', JSON.stringify({ version: '1.0.7', executablePath, transport: 'local mesh', realGetDisplayMedia: true, realNativeWindowCapture: true, physicalMicrophoneAccess: false, pickerChoiceAutomated: true, capturedOnlyOwnedFixture: true, cancellationReleasedLease: true, retryAfterCancellation: true, stopRemovedReceiverVideoAndLease: true, restartDecodedVideo: true, decoded, picker, productionOrSfuTest: false }, null, 2));
  console.log('Packaged Windows native window sharing decoded in a second client; cancel, retry, stop and restart passed.');
} finally {
  await browser.close(); await desktop.close(); await backend.app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
