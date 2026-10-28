import { test, expect, _electron as electron, type Page, type BrowserContext, type ElectronApplication } from '@playwright/test';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const hosted = Boolean(process.env.DORHAM_RELAY_BASE_URL);
const windows = Boolean(process.env.DORHAM_RELAY_ELECTRON_EXE);
const evidenceName = windows ? 'windows-hosted-relay' : hosted ? 'hosted-relay' : 'external-relay';

// Explicit opt-in: this exercises an operator's real relay allowance. Network traces
// are disabled because voice acknowledgements contain TURN credentials.
test.use({ trace: 'off', video: 'off', actionTimeout: 15000, navigationTimeout: 25000 });
test.skip(process.env.DORHAM_RELAY_TEST !== '1', 'Use the memory-guarded --relay launcher and a private TURN environment.');

async function register(page: Page, name: string) {
  if (page.url().startsWith('dorham:')) await page.reload(); else await page.goto('/');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  if (await page.getByLabel('Server address', { exact: true }).count()) await page.getByLabel('Server address', { exact: true }).fill(process.env.DORHAM_RELAY_BASE_URL!);
  await page.getByLabel('Display name', { exact: true }).fill(name); await page.getByLabel('Username', { exact: true }).fill(name);
  await page.getByLabel('Password', { exact: true }).fill(crypto.randomUUID());
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Hey, ${name}.` })).toBeVisible();
  await expect(page.locator('.connection-light.connected')).toBeVisible();
}
async function api(page: Page, route: string, body: object = {}) {
  return page.evaluate(async ({ route, body }) => {
    const auth = await (await fetch('/api/v1/auth/me')).json();
    const response = await fetch(`/api/v1${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrf }, body: JSON.stringify({ requestId: crypto.randomUUID(), ...body }) });
    if (!response.ok) throw new Error(`Fixture API failed: ${response.status}`); return response.json();
  }, { route, body });
}
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const original = RTCPeerConnection; (window as any).__relayPeers = []; (window as any).__relayErrors = [];
    (window as any).RTCPeerConnection = new Proxy(original, { construct(target, args) {
      const peer = new target({ ...args[0], iceTransportPolicy: 'relay' });
      peer.addEventListener('icecandidateerror', (error: RTCPeerConnectionIceErrorEvent) => (window as any).__relayErrors.push({ code: error.errorCode, url: error.url, text: error.errorText }));
      (window as any).__relayPeers.push(peer); return peer;
    } });
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360; const context = canvas.getContext('2d')!;
      let frame = 0; const timer = setInterval(() => { context.fillStyle = frame++ % 2 ? '#7564e6' : '#83daba'; context.fillRect(0, 0, 640, 360); context.fillStyle = '#fff'; context.font = '40px sans-serif'; context.fillText(`Relay ${frame}`, 40, 180); }, 65);
      const stream = canvas.captureStream(15); stream.getTracks()[0].addEventListener('ended', () => clearInterval(timer)); return stream;
    };
  });
}
async function measurements(page: Page) {
  return page.evaluate(async () => {
    const results = [];
    for (const peer of ((window as any).__relayPeers || []) as RTCPeerConnection[]) {
      if (peer.connectionState === 'closed') continue;
      const reports = await peer.getStats(), media: any[] = [], candidates: any[] = []; let pair: any;
      reports.forEach((report: any) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) pair = reports.get(report.selectedCandidatePairId);
        if (report.type === 'inbound-rtp') media.push({ kind: report.kind, bytesReceived: report.bytesReceived, packetsLost: report.packetsLost, framesDecoded: report.framesDecoded, totalSamplesReceived: report.totalSamplesReceived, totalAudioEnergy: report.totalAudioEnergy });
        if (report.type === 'local-candidate') candidates.push({ type: report.candidateType, protocol: report.protocol, relayProtocol: report.relayProtocol });
      });
      const local = pair && reports.get(pair.localCandidateId), remote = pair && reports.get(pair.remoteCandidateId);
      results.push({ state: peer.connectionState, iceState: peer.iceConnectionState, gathering: peer.iceGatheringState, signaling: peer.signalingState, localCandidateType: local?.candidateType, remoteCandidateType: remote?.candidateType, relayProtocol: local?.relayProtocol, protocol: local?.protocol, roundTripTime: pair?.currentRoundTripTime, media, candidates });
    }
    return results;
  });
}

test('external TURN carries decoded audio and two screen streams with direct ICE disabled', async ({ browser }) => {
  test.setTimeout(150000);
  const a = await browser.newContext({ permissions: ['microphone'] });
  let b: BrowserContext | undefined, desktop: ElectronApplication | undefined;
  const page = await a.newPage(); let other = page;
  try {
    if (windows) {
      const profile = await mkdtemp(path.join(os.tmpdir(), 'dorham-relay-desktop-'));
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')); delete env.ELECTRON_RUN_AS_NODE;
      desktop = await electron.launch({ executablePath: process.env.DORHAM_RELAY_ELECTRON_EXE!, args: [`--user-data-dir=${profile}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'], env, timeout: 30000 });
      other = await desktop.firstWindow();
      const preferences = await desktop.evaluate(({ BrowserWindow }) => (BrowserWindow.getAllWindows()[0].webContents as any).getLastWebPreferences());
      expect(preferences.sandbox).toBe(true); expect(preferences.contextIsolation).toBe(true); expect(preferences.nodeIntegration).toBe(false);
    } else { b = await browser.newContext({ permissions: ['microphone'] }); other = await b.newPage(); }
    await instrument(page); await instrument(other);
    const suffix = Date.now().toString().slice(-7); await register(page, `RelayA${suffix}`); await register(other, `RelayB${suffix}`);
    console.log('Relay test: authenticated clients connected.');
    const server = await api(page, '/servers', { name: 'External relay lab' }), invite = await api(page, `/servers/${server.id}/invites`);
    if (windows) {
      await other.getByRole('button', { name: 'Join a server', exact: true }).click();
      await other.getByLabel('Invite link or code', { exact: true }).fill(invite.code);
      await other.getByRole('button', { name: 'Join the conversation', exact: true }).click();
    } else {
      await api(other, '/invites/join', { code: invite.code });
      // API fixture setup does not run the UI join dialog's bootstrap refresh.
      await other.reload();
    }
    for (const p of [page, other]) { await p.getByRole('button', { name: 'Open External relay lab', exact: true }).click(); await p.getByRole('button', { name: 'Lounge', exact: true }).click(); }
    console.log('Relay test: both clients joined the voice room.');
    for (const p of [page, other]) await expect.poll(async () => (await measurements(p)).some(peer => peer.localCandidateType === 'relay' && peer.remoteCandidateType === 'relay' && peer.media.some(r => r.kind === 'audio' && r.totalSamplesReceived > 1000)), { timeout: 45000 }).toBe(true);
    console.log('Relay test: both clients decode audio over selected TURN pairs.');
    for (const p of [page, other]) await p.getByRole('button', { name: 'Share screen', exact: true }).click();
    for (const p of [page, other]) {
      await expect.poll(async () => (await measurements(p)).some(peer => peer.media.some(r => r.kind === 'video' && r.framesDecoded > 5)), { timeout: 45000 }).toBe(true);
      await expect(p.locator('.screen video')).toBeVisible();
      expect(await p.locator('.screen video').evaluate((video: HTMLVideoElement) => { const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1; const context = canvas.getContext('2d')!; context.drawImage(video, 0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).some(v => v > 20); })).toBe(true);
    }
    await other.getByRole('button', { name: 'Stop watching stream', exact: true }).click(); await expect(other.locator('.screen')).toHaveCount(0);
    await other.getByRole('button', { name: /Watch stream/ }).click(); await expect(other.locator('.screen video')).toBeVisible();
    const before = await measurements(other);
    await expect.poll(async () => (await measurements(other)).flatMap(peer => peer.media).filter(r => r.kind === 'video').reduce((n, r) => n + (r.framesDecoded || 0), 0), { timeout: 15000 }).toBeGreaterThan(before.flatMap(peer => peer.media).filter(r => r.kind === 'video').reduce((n, r) => n + (r.framesDecoded || 0), 0));
    await mkdir('artifacts/evidence', { recursive: true });
    await writeFile(`artifacts/evidence/${evidenceName}.json`, JSON.stringify({ measuredAt: new Date().toISOString(), backend: hosted ? process.env.DORHAM_RELAY_BASE_URL : 'isolated local database', scenario: `${windows ? 'Installed sandboxed Windows application and one Chrome context' : 'Two local Chrome contexts'}, production mesh implementation, forced external TURN on both ends, synthetic microphone and two canvas shares`, peers: [await measurements(page), await measurements(other)], limitations: 'Proves decoded media through this relay from this PC. Physical microphones/source picker, remote Sweden client and different ISP/VPN paths still require acceptance.' }, null, 2));
    await other.screenshot({ path: `artifacts/evidence/${evidenceName}.png` });
  } catch (error) {
    try {
      await mkdir('artifacts/evidence', { recursive: true });
      await writeFile(`artifacts/evidence/${evidenceName}-failure.json`, JSON.stringify({ measuredAt: new Date().toISOString(), peers: [await measurements(page), await measurements(other)], iceErrors: [await page.evaluate(() => (window as any).__relayErrors), await other.evaluate(() => (window as any).__relayErrors)] }, null, 2));
    } catch { /* Preserve the original failure if the test deadline closed a page. */ }
    throw error;
  } finally { await a.close(); await b?.close(); await desktop?.close(); }
});
