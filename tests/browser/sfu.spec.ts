import { completeRecovery, chooseScreen } from './recovery-helper';
import { test, expect, _electron as electron, type Page, type ElectronApplication } from '@playwright/test';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test.use({ trace: 'off', video: 'off' });
test.skip(!process.env.DORHAM_SFU_BASE_URL, 'Requires the authorized hosted SFU pilot.');
async function instrument(page: Page) {
  await page.addInitScript(({ tlsOnly }) => {
    const Original = RTCPeerConnection; (window as any).__sfuPeers = [];
    (window as any).RTCPeerConnection = new Proxy(Original, { construct(Target, args) {
      const constrain = (config: RTCConfiguration) => tlsOnly ? { ...config, iceTransportPolicy: 'relay' as const, iceServers: config.iceServers?.map(server => ({ ...server, urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(url => url.startsWith('turns:')) })).filter(server => server.urls.length) } : config;
      const pc = new Target(constrain(args[0] || {})), configure = pc.setConfiguration.bind(pc);
      pc.setConfiguration = config => configure(constrain(config || {}));
      (window as any).__sfuPeers.push(pc); return pc;
    } });
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360; const ctx = canvas.getContext('2d')!; let frame = 0;
      const timer = setInterval(() => { ctx.fillStyle = frame++ % 2 ? '#7564e6' : '#83daba'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = 'white'; ctx.font = '32px sans-serif'; ctx.fillText(`SFU ${frame}`, 30, 160); }, 100);
      const stream = canvas.captureStream(12); stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer)); return stream;
    };
  }, { tlsOnly: process.env.DORHAM_SFU_TLS_ONLY === '1' });
}
async function media(page: Page) {
  return page.evaluate(async () => {
    const result: any[] = [];
    for (const pc of (window as any).__sfuPeers as RTCPeerConnection[]) {
      if (pc.connectionState === 'closed') continue;
      const stats = await pc.getStats(); let pair: any; const inbound: any[] = [];
      stats.forEach((r: any) => { if (r.type === 'transport') pair = stats.get(r.selectedCandidatePairId); if (r.type === 'inbound-rtp') inbound.push({ kind: r.kind, framesDecoded: r.framesDecoded, totalAudioEnergy: r.totalAudioEnergy, totalSamplesReceived: r.totalSamplesReceived, packetsLost: r.packetsLost, bytesReceived: r.bytesReceived }); });
      const local = pair && stats.get(pair.localCandidateId), remote = pair && stats.get(pair.remoteCandidateId);
      const config = pc.getConfiguration();
      result.push({ state: pc.connectionState, icePolicy: config.iceTransportPolicy, iceUrls: config.iceServers?.flatMap(s => s.urls), localType: local?.candidateType, localCandidateUrl: local?.url, remoteAddress: remote?.address, relayProtocol: local?.relayProtocol, inbound, encodings: pc.getSenders().filter(s => s.track?.kind === 'video').flatMap(s => s.getParameters().encodings) });
    }
    return result;
  });
}
async function api(page: Page, route: string, body: object) {
  return page.evaluate(async ({ route, body }) => { const auth = await (await fetch('/api/v1/auth/me')).json(); const r = await fetch('/api/v1' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrf }, body: JSON.stringify({ requestId: crypto.randomUUID(), ...body }) }); if (!r.ok) throw new Error(`API ${r.status}`); return r.json(); }, { route, body });
}
test('hosted SFU decodes audio and two screens, applies the traffic policy and speaking outline', async ({ browser }) => {
  test.setTimeout(150000);
  const a = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 900 } }), b = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 900 } });
  const first = await a.newPage(); let second = await b.newPage(), desktop: ElectronApplication | undefined;
  const suffix = Date.now().toString().slice(-7), names = [`SfuA${suffix}`, `SfuB${suffix}`];
  try {
    if (process.env.DORHAM_RELAY_ELECTRON_EXE) {
      const profile = await mkdtemp(path.join(os.tmpdir(), 'dorham-sfu-windows-'));
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')); delete env.ELECTRON_RUN_AS_NODE;
      desktop = await electron.launch({ executablePath: process.env.DORHAM_RELAY_ELECTRON_EXE, args: [`--user-data-dir=${profile}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'], env });
      await second.close(); second = await desktop.firstWindow();
      const preferences = await desktop.evaluate(({ BrowserWindow }) => (BrowserWindow.getAllWindows()[0].webContents as any).getLastWebPreferences()); expect(preferences.sandbox).toBe(true); expect(preferences.contextIsolation).toBe(true); expect(preferences.nodeIntegration).toBe(false);
    }
    for (const [i, page] of [first, second].entries()) {
      await instrument(page); if (i === 1 && desktop) await page.reload(); else await page.goto('/'); await page.getByRole('button', { name: 'Create an account', exact: true }).click();
      if (i === 1 && desktop) await expect(page.getByLabel('Server address', { exact: true })).toHaveValue(process.env.DORHAM_SFU_BASE_URL!);
      await page.getByLabel('Display name', { exact: true }).fill(names[i]); await page.getByLabel('Username', { exact: true }).fill(names[i]); await page.getByLabel('Password', { exact: true }).fill(crypto.randomUUID()); await page.getByRole('button', { name: 'Create account', exact: true }).click(); await completeRecovery(page);
      await expect(page.getByRole('heading', { name: `Hey, ${names[i]}.` })).toBeVisible();
    }
    const server = await api(first, '/servers', { name: 'Iran SFU pilot' }), invite = await api(first, `/servers/${server.id}/invites`, {});
    if (desktop) { await second.getByRole('button', { name: 'Join a server', exact: true }).click(); await second.getByLabel('Invite link or code', { exact: true }).fill(invite.code); await second.getByRole('button', { name: 'Join the conversation', exact: true }).click(); }
    else await api(second, '/invites/join', { code: invite.code });
    for (const page of [first, second]) { await page.reload(); await page.getByRole('button', { name: 'Open Iran SFU pilot', exact: true }).click(); await page.getByRole('button', { name: 'Lounge', exact: true }).click(); }
    await expect.poll(async () => (await media(second)).some(p => p.inbound.some((r: any) => r.kind === 'audio' && r.totalAudioEnergy > 0)), { timeout: 45000 }).toBe(true);
    await expect.poll(async () => (await media(first)).some(p => p.inbound.some((r: any) => r.kind === 'audio' && r.totalAudioEnergy > 0))).toBe(true);
    const speaker = second.locator('.voice-card').filter({ hasText: names[0] }); await expect(speaker).toHaveClass(/speaking/); await expect(speaker.locator('.avatar')).toHaveCSS('outline-color', 'rgb(131, 218, 186)');
    await first.getByRole('button', { name: 'Mute microphone', exact: true }).click(); await expect(speaker).not.toHaveClass(/speaking/); await first.getByRole('button', { name: 'Unmute microphone', exact: true }).click(); await expect(speaker).toHaveClass(/speaking/);
    for (const page of [first, second]) { await page.getByRole('button', { name: 'Share screen', exact: true }).click(); await chooseScreen(page); }
    for (const page of [first, second]) {
      await expect.poll(async () => (await media(page)).some(p => p.inbound.some((r: any) => r.kind === 'video' && r.framesDecoded > 5)), { timeout: 30000 }).toBe(true);
      await expect(page.locator('main')).toHaveClass(/screen-focused/); await expect(page.locator('.screen-status')).toHaveCount(0);
      const encodings = (await media(page)).flatMap(p => p.encodings); expect(encodings.length).toBeGreaterThan(0); for (const e of encodings) { expect(e.maxBitrate).toBeLessThanOrEqual(450000); expect(e.maxFramerate).toBeLessThanOrEqual(12); }
    }
    const results = await Promise.all([media(first), media(second)]);
    await mkdir('artifacts/evidence', { recursive: true }); const mode = desktop ? 'windows' : process.env.DORHAM_SFU_TLS_ONLY === '1' ? 'tls' : 'direct';
    await writeFile(`artifacts/evidence/ninecraft-sfu-${mode}.json`, JSON.stringify({ measuredAt: new Date().toISOString(), clients: desktop ? 'Chrome and installed Windows application' : 'Two Chrome contexts', results, limitations: 'Synthetic sources on one workstation; no physical microphone, 16-person capacity or domestic-outage certification.' }, null, 2)); await second.screenshot({ path: `artifacts/evidence/ninecraft-sfu-${mode}.png` });
    if (process.env.DORHAM_SFU_TLS_ONLY === '1') for (const peers of results) expect(peers.some(p => p.icePolicy === 'relay' && p.localType === 'relay' && p.localCandidateUrl?.startsWith('turns:') && p.iceUrls?.every((url: string) => url.startsWith('turns:')))).toBe(true);
    if (process.env.DORHAM_SFU_MODERATION === '1') {
      const target = first.locator('.voice-card').filter({ hasText: names[1] });
      await target.getByRole('button', { name: 'Mute', exact: true }).click(); await expect(second.locator('.voice-card').filter({ hasText: names[1] })).toContainText('Muted by moderator');
      await target.getByRole('button', { name: 'Unmute', exact: true }).click(); await expect(second.locator('.voice-card').filter({ hasText: names[1] })).not.toContainText('Muted by moderator');
      await second.getByRole('button', { name: 'Stop watching stream', exact: true }).click(); await expect(second.locator('.screen video')).toHaveCount(0);
      await second.getByRole('button', { name: 'Watch stream', exact: true }).click(); await expect(second.locator('.screen video')).toBeVisible(); await expect(second.locator('.screen-status')).toHaveCount(0);
      await first.getByRole('button', { name: 'Stop share', exact: true }).click(); await expect(second.getByRole('button', { name: 'Share screen', exact: true })).toBeVisible(); await expect(first.locator('.screen video')).toHaveCount(0);
      await target.getByRole('button', { name: 'Disconnect', exact: true }).click(); await expect(second.locator('.voice-stage')).toHaveCount(0); await expect(first.locator('.voice-card')).toHaveCount(1);
      await writeFile('artifacts/evidence/ninecraft-sfu-controls.json', JSON.stringify({ measuredAt: new Date().toISOString(), moderatorMuteUnmute: true, unsubscribeResubscribe: true, moderatorStopsShare: true, voiceKick: true, limitations: 'Cooperative product clients; not an adversarial-client audit.' }, null, 2));
    }
  } finally { await desktop?.close(); await a.close(); await b.close(); }
});
