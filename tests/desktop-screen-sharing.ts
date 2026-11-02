import { _electron as electron, chromium, expect as baseExpect, type Page, type ElectronApplication, type Browser } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../apps/api/src/app';
import { config } from '../apps/api/src/config';
import { createGoApp } from './go-harness';
import { completeRecovery } from './browser/recovery-helper';
const expect = baseExpect.configure({ timeout: 15000 });

// Real Windows capture, restricted to an owned animated fixture window. Only
// picker choices are automated; getDisplayMedia and the media path are real.
const executablePath = process.argv[2];
if (!executablePath) throw Error('Pass the local Windows Dorham.exe path.');
const temp = await mkdtemp(path.join(os.tmpdir(), 'dorham-browser-native-share-'));
if (path.dirname(temp) !== os.tmpdir() || !path.basename(temp).startsWith('dorham-browser-native-share-')) throw Error('Unexpected owned fixture path');
if (process.env.DORHAM_FIXTURE_MANIFEST) await writeFile(process.env.DORHAM_FIXTURE_MANIFEST, JSON.stringify({ nonce: process.env.DORHAM_FIXTURE_NONCE, dataDir: temp, pid: process.pid }));
const goBackend = process.env.DORHAM_GO_BACKEND === '1';
const evidencePrefix = goBackend ? 'v110-legacy-windows107' : 'v107-native-screen';
async function nativeHash(file: string) { const digest = createHash('sha256'); for await (const bytes of createReadStream(file)) digest.update(bytes); return digest.digest('hex'); }
const nativeExecutableSha256 = goBackend ? await nativeHash(path.resolve(executablePath)) : undefined;
const nativeApplicationSha256 = goBackend ? await nativeHash(path.join(path.dirname(path.resolve(executablePath)), 'resources', 'app.asar')) : undefined;
if (goBackend) {
  const publicRuntime = path.resolve('artifacts/v1.0.7/windows-avatars/win-unpacked');
  expect(nativeExecutableSha256).toBe(await nativeHash(path.join(publicRuntime, 'Dorham.exe')));
  expect(nativeApplicationSha256).toBe(await nativeHash(path.join(publicRuntime, 'resources', 'app.asar')));
}
const fixtureConfig = config({ dataDir: path.join(temp, goBackend ? 'dorham-server' : 'server'), databaseUrl: '', mediaTransport: 'mesh', origins: ['dorham://app', 'http://127.0.0.1:3101'], stunUrls: [], turnUrls: [], turnUsername: '', turnPassword: '', turnSecret: '', cloudflareTurnKeyId: '', cloudflareTurnApiToken: '' });
const backend = goBackend ? await createGoApp(fixtureConfig) : await createApp(fixtureConfig, { logger: false, rateLimit: false });
await backend.app.listen({ host: '127.0.0.1', port: 3101 });
const address = goBackend ? (backend as Awaited<ReturnType<typeof createGoApp>>).url : 'http://127.0.0.1:3101';
if (goBackend) {
  fixtureConfig.origins.push(address); fixtureConfig.publicUrl = address;
  await backend.db.one('SELECT 1 AS ready'); // Apply the owned fixture's actual loopback origin before clients start.
}
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')); delete env.ELECTRON_RUN_AS_NODE;
await mkdir(path.join(temp, 'profile'), { recursive: true });
await writeFile(path.join(temp, 'profile', 'settings.json'), JSON.stringify({ server: address }));
let cleanupDesktop: ElectronApplication | undefined, cleanupBrowser: Browser | undefined;
try {
  const desktop = await electron.launch({ executablePath: path.resolve(executablePath), args: [`--user-data-dir=${path.join(temp, 'profile')}`, '--autoplay-policy=no-user-gesture-required'], env, timeout: 45000 });
  cleanupDesktop = desktop;
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'], timeout: 30000 });
  cleanupBrowser = browser;
  const nativeIdentity = await desktop.evaluate(({ app }) => ({ version: app.getVersion(), userData: app.getPath('userData') }));
  const nativeVersion = nativeIdentity.version;
  expect(path.resolve(nativeIdentity.userData).toLowerCase()).toBe(path.resolve(temp, 'profile').toLowerCase());
  if (goBackend) expect(nativeVersion).toBe('1.0.7');
  console.log(`Packaged Windows ${nativeVersion}; isolated profile confirmed; backend ${goBackend ? 'Go 1.1.0' : 'Node reference'}.`);
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
  // The old Windows binary has no microphone. The second client supplies a
  // generated tone through the actual product WebRTC path, never a physical mic.
  const noMicrophone = "navigator.mediaDevices.getUserMedia = async function(){throw new DOMException('Fixture has no microphone','NotAllowedError')};";
  await page.addInitScript(noMicrophone);
  if (goBackend) {
    await page.addInitScript(() => {
      localStorage.setItem('dorham-sounds', JSON.stringify({ voice: false, messages: false }));
      const meters = new Map<AudioContext, AnalyserNode>(); (window as any).__legacyListenMeters = meters;
      const connect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function(destination: any, ...args: any[]): any {
        if (destination === this.context.destination) {
          let meter = meters.get(this.context as AudioContext);
          if (!meter) { meter = this.context.createAnalyser(); meter.fftSize = 2048; meters.set(this.context as AudioContext, meter); }
          (connect as any).call(this, meter);
        }
        return (connect as any).call(this, destination, ...args);
      };
    });
    await receiver.addInitScript(() => {
      localStorage.setItem('dorham-sounds', JSON.stringify({ voice: false, messages: false }));
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain(), output = context.createMediaStreamDestination();
        oscillator.frequency.value = 440; gain.gain.value = 0.04; oscillator.connect(gain).connect(output); oscillator.start(); await context.resume();
        output.stream.getAudioTracks()[0].addEventListener('ended', () => { oscillator.stop(); void context.close(); }); return output.stream;
      };
    });
  } else await receiver.addInitScript(noMicrophone);
  const peers = "window.__sharePeers=[];window.RTCPeerConnection=class extends RTCPeerConnection{constructor(...args){super(...args);window.__sharePeers.push(this)}}";
  await page.addInitScript(peers); await receiver.addInitScript(peers);
  await page.evaluate(address => (window as any).desktop.setServer(address), address); await page.reload(); await receiver.goto(address);
  async function login(p: Page, username: string) {
    await p.getByLabel('Username', { exact: true }).fill(username); await p.getByLabel('Password', { exact: true }).fill(password);
    await p.getByRole('button', { name: 'Let’s get you in', exact: true }).click(); await completeRecovery(p);
    await p.getByRole('button', { name: 'Open Native screen fixture', exact: true }).click();
    await expect(p.locator('.connection-light.connected')).toBeVisible();
  }
  await login(page, `share_owner_${suffix}`); await login(receiver, `share_viewer_${suffix}`);
  console.log('Legacy native and browser clients signed in to the isolated backend.');
  let decodedVoiceRms: number | undefined;
  if (goBackend) {
    const outgoing = `Legacy Windows 1.0.7 → Go 1.1.0 ${suffix}`;
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(outgoing);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(receiver.getByTestId('message').filter({ hasText: outgoing })).toBeVisible();
    const incoming = `Go web → legacy Windows سلام ${suffix}`;
    await receiver.getByRole('textbox', { name: 'Message', exact: true }).fill(incoming);
    await receiver.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByTestId('message').filter({ hasText: incoming })).toBeVisible();
    await page.reload(); await expect(page.locator('.app')).toBeVisible();
    await page.getByRole('button', { name: 'Open Native screen fixture', exact: true }).click();
    console.log('Bidirectional English/Persian chat and native credential persistence passed.');
  }
  for (const p of [page, receiver]) {
    await p.getByRole('button', { name: 'Lounge', exact: true }).click();
    await expect(p.locator('.gaming-voice')).toBeVisible();
  }
  if (goBackend) {
    await expect(page.locator('.voice-panel')).toContainText('Listening only');
    await expect(page.getByRole('button', { name: 'Microphone unavailable. Rejoin to try again.', exact: true })).toBeDisabled();
    async function voiceLevel() {
      return page.evaluate(async () => {
        let sum = 0;
        for (let i = 0; i < 6; i++) {
          for (const [context, meter] of (window as any).__legacyListenMeters as Map<AudioContext, AnalyserNode>) if (context.state === 'running') {
            const samples = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(samples);
            sum += samples.reduce((a, b) => a + b * b, 0) / samples.length;
          }
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        return Math.sqrt(sum / 6);
      });
    }
    await expect.poll(voiceLevel, { timeout: 45000 }).toBeGreaterThan(0.005);
    await page.waitForTimeout(5500); decodedVoiceRms = await voiceLevel(); expect(decodedVoiceRms).toBeGreaterThan(0.005);
    await page.getByRole('button', { name: 'Deafen', exact: true }).click(); await expect.poll(voiceLevel).toBeLessThan(0.000001);
    await page.getByRole('button', { name: 'Undeafen', exact: true }).click(); await expect.poll(voiceLevel).toBeGreaterThan(0.005);
    console.log('Legacy Windows receives decoded voice without a microphone; deafen/undeafen passed.');
  }
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
  await receiver.screenshot({ path: `artifacts/evidence/${evidencePrefix}-receiver.png` });
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
    await writeFile(`artifacts/evidence/${evidencePrefix}-restart-diagnostics.json`, JSON.stringify(diagnostics, null, 2)); throw error;
  }
  await page.getByRole('button', { name: 'Stop sharing', exact: true }).click(); await expect(video).toHaveCount(0);
  const picker = await desktop.evaluate(() => (globalThis as any).__nativeShare);
  expect(picker.pickerCalls).toBe(3); expect(picker.selectedOwnedWindow).toBe(2);
  await writeFile(`artifacts/evidence/${evidencePrefix}-sharing.json`, JSON.stringify({ version: nativeVersion, backendVersion: goBackend ? '1.1.0' : 'Node reference', backendRuntime: goBackend ? 'Go' : 'Node', executablePath, transport: 'local mesh', realGetDisplayMedia: true, realNativeWindowCapture: true, physicalMicrophoneAccess: false, pickerChoiceAutomated: true, capturedOnlyOwnedFixture: true, cancellationReleasedLease: true, retryAfterCancellation: true, stopRemovedReceiverVideoAndLease: true, restartDecodedVideo: true, ...(goBackend ? { legacyExecutableUnmodified: true, nativeExecutableSha256, nativeApplicationSha256, publishedVersionPayload: 'artifacts/v1.0.7/windows-avatars/win-unpacked', isolatedUserProfile: true, nativeLogin: true, nativeLoginSurvivedReload: true, bidirectionalEnglishPersianChat: true, nativeListenOnlyDecodedVoice: true, nativeDeafenSilencedVoice: true, decodedVoiceRms } : {}), decoded, picker, productionOrSfuTest: false }, null, 2));
  console.log('Packaged Windows native window sharing decoded in a second client; cancel, retry, stop and restart passed.');
} catch (error) {
  const failedPage = cleanupDesktop?.windows()[0];
  if (failedPage) {
    await failedPage.screenshot({ path: `artifacts/evidence/${evidencePrefix}-failure.png` }).catch(() => {});
    await writeFile(`artifacts/evidence/${evidencePrefix}-failure.txt`, await failedPage.locator('body').innerText().catch(() => 'Window unavailable')).catch(() => {});
  }
  throw error;
} finally {
  await cleanupBrowser?.close();
  await cleanupDesktop?.evaluate(({ app }) => app.quit()).catch(() => {});
  await cleanupDesktop?.close(); await backend.app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
