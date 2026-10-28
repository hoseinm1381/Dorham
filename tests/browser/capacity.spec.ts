import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
test('20 browsers, 16 real mesh participants, five actual screen publishers and capacity rejection', async ({ browser }) => {
  test.skip(process.env.DORHAM_LARGE_MEDIA_TEST !== '1', 'Explicit opt-in required; the default workflow stays within the user browser RAM budget.');
  test.setTimeout(240000);
  const base = 'http://127.0.0.1:3101', contexts: BrowserContext[] = [], pages: Page[] = [], credentials: { csrf: string; id: string }[] = [], suffix = Date.now().toString().slice(-6);
  const call = async (i: number, route: string, body?: any) => { const r = await contexts[i].request.fetch(`${base}/api/v1${route}`, { method: body ? 'POST' : 'GET', headers: { Origin: base, 'X-CSRF-Token': credentials[i]?.csrf || '' }, data: body ? { requestId: crypto.randomUUID(), ...body } : undefined }); if (!r.ok()) throw new Error(await r.text()); return r.json(); };
  const report = async (page: Page) => page.evaluate(async () => { const inbound: any[] = []; for (const pc of (window as any).__pcs || []) if (pc.connectionState === 'connected') (await pc.getStats()).forEach((r: any) => { if (r.type === 'inbound-rtp') inbound.push({ kind: r.kind, packetsReceived: r.packetsReceived, totalSamplesReceived: r.totalSamplesReceived, totalAudioEnergy: r.totalAudioEnergy, framesDecoded: r.framesDecoded, bytesReceived: r.bytesReceived, packetsLost: r.packetsLost, jitter: r.jitter }); }); return inbound; });
  try {
    for (let i = 0; i < 20; i++) {
      const context = await browser.newContext({ permissions: ['microphone'] }); contexts.push(context);
      const r = await context.request.post(`${base}/api/v1/auth/register`, { data: { username: `cap${suffix}_${i}`, displayName: `Participant ${i + 1}`, password: 'capacity-test-pass', requestId: crypto.randomUUID() } }); expect(r.status()).toBe(201); const auth = await r.json(); credentials.push({ csrf: auth.csrf, id: auth.user.id });
      await context.addInitScript(() => { const original = RTCPeerConnection; (window as any).__pcs = []; (window as any).RTCPeerConnection = new Proxy(original, { construct(target, args) { const pc = new target(...args); (window as any).__pcs.push(pc); return pc; } }); navigator.mediaDevices.getDisplayMedia = async () => { const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360; const ctx = canvas.getContext('2d')!; let frame = 0; const timer = setInterval(() => { ctx.fillStyle = frame++ % 2 ? '#9a83ef' : '#83daba'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = '#fff'; ctx.font = '24px sans-serif'; ctx.fillText(`Capacity capture ${frame}`, 20, 180); }, 65); const stream = canvas.captureStream(15); stream.getTracks()[0].addEventListener('ended', () => clearInterval(timer)); return stream; }; });
    }
    const server = await call(0, '/servers', { name: 'Capacity room' }); const invite = await call(0, `/servers/${server.id}/invites`, { uses: 100 });
    for (let i = 1; i < 20; i++) await call(i, '/invites/join', { code: invite.code });
    await call(0, `/servers/${server.id}/channels`, { name: 'Studio', kind: 'voice' }); await call(0, `/servers/${server.id}/channels`, { name: 'Workshop', kind: 'voice' });
    for (const context of contexts) { const p = await context.newPage(); pages.push(p); await p.goto(base); await p.getByRole('button', { name: 'Open Capacity room', exact: true }).click(); }
    for (let i = 0; i < 20; i++) await pages[i].getByRole('button', { name: i < 16 ? 'Lounge' : i < 18 ? 'Studio' : 'Workshop', exact: true }).click();
    await expect(pages[0].locator('.voice-card')).toHaveCount(16);
    await expect.poll(async () => { const results = await Promise.all(pages.slice(0, 16).map(report)); return results.every(rows => rows.filter(r => r.kind === 'audio' && r.totalSamplesReceived > 0 && r.totalAudioEnergy > 0).length === 15); }, { timeout: 90000, intervals: [1000, 3000] }).toBe(true);
    for (const i of [0, 1, 16, 17, 18]) await pages[i].getByRole('button', { name: 'Share screen', exact: true }).click();
    await expect.poll(async () => { const results = await Promise.all([report(pages[2]), report(pages[16]), report(pages[19])]); return results[0].filter(r => r.kind === 'video' && r.framesDecoded > 0).length === 2 && results[1].some(r => r.kind === 'video' && r.framesDecoded > 0) && results[2].some(r => r.kind === 'video' && r.framesDecoded > 0); }, { timeout: 60000, intervals: [1000, 3000] }).toBe(true);
    await pages[19].getByRole('button', { name: 'Share screen', exact: true }).click(); await expect(pages[19].getByRole('alert')).toContainText('capacity is full');
    const results = await Promise.all(pages.map(report)); await mkdir('artifacts/evidence', { recursive: true });
    await writeFile('artifacts/evidence/media-capacity.json', JSON.stringify({ measuredAt: new Date().toISOString(), scenario: '20 Chrome browser contexts, 16-person full audio mesh, five synthetic screen publishers over actual WebRTC in three rooms, sixth share rejected', platform: process.platform, results, limitations: 'Same-machine synthetic devices and LAN ICE, not cross-network or physical mobile validation.' }, null, 2)); await pages[2].screenshot({ path: 'artifacts/evidence/16-person-voice.png', fullPage: true });
  } finally { for (const c of contexts) await c.close(); }
});
