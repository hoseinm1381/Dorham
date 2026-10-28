import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
async function register(page: Page, username: string) { await page.goto('/'); await page.getByRole('button', { name: 'Create an account', exact: true }).click(); await page.getByLabel('Display name', { exact: true }).fill(username); await page.getByLabel('Username', { exact: true }).fill(username); await page.getByLabel('Password', { exact: true }).fill('correct-horse-123'); await page.getByRole('button', { name: 'Create account', exact: true }).click(); await expect(page.getByRole('heading', { name: `Hey, ${username}.` })).toBeVisible(); }
async function api(page: Page, route: string, body?: any, method = body ? 'POST' : 'GET') { return page.evaluate(async ({ route, body, method }) => { const auth = await (await fetch('/api/v1/auth/me')).json(); const r = await fetch(`/api/v1${route}`, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrf }, body: body ? JSON.stringify({ requestId: crypto.randomUUID(), ...body }) : undefined }); if (!r.ok) throw new Error(await r.text()); return r.json(); }, { route, body, method }); }
async function instrument(page: Page, relayOnly = false) {
  await page.addInitScript((relayOnly: boolean) => {
    const original = RTCPeerConnection; (window as any).__pcs = [];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); (window as any).__microphones = [];
    navigator.mediaDevices.getUserMedia = async constraints => { const stream = await capture(constraints); (window as any).__microphones.push(stream); return stream; };
    (window as any).__gains = []; const gain = AudioContext.prototype.createGain; AudioContext.prototype.createGain = function() { const node = gain.call(this); (window as any).__gains.push(node); return node; };
    (window as any).RTCPeerConnection = new Proxy(original, { construct(target, args) { const pc = new target({ ...args[0], ...(relayOnly ? { iceTransportPolicy: 'relay' } : {}) }); (window as any).__pcs.push(pc); return pc; } });
    // Deterministic test capture feeds the actual product WebRTC implementation.
    navigator.mediaDevices.getDisplayMedia = async () => { const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360; const context = canvas.getContext('2d')!; let frame = 0; const timer = setInterval(() => { context.fillStyle = frame++ % 2 ? '#7564e6' : '#83daba'; context.fillRect(0, 0, 640, 360); context.fillStyle = '#fff'; context.font = '40px sans-serif'; context.fillText(`Synthetic capture ${frame}`, 40, 180); }, 50); const stream = canvas.captureStream(15); stream.getTracks()[0].addEventListener('ended', () => clearInterval(timer)); return stream; };
  }, relayOnly);
}
async function stats(page: Page) { return page.evaluate(async () => { const results: any[] = []; for (const pc of (window as any).__pcs || []) { if (pc.connectionState !== 'closed') (await pc.getStats()).forEach((r: any) => results.push({ ...r })); } return results; }); }

test('real accounts, channel chat, reactions, editing, unread state and private messages', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext(), page = await a.newPage(), other = await b.newPage(); const suffix = Date.now().toString().slice(-7);
  await register(page, `Alice${suffix}`); await register(other, `Robin${suffix}`);
  await page.getByRole('button', { name: 'Create a server', exact: true }).click(); await page.getByLabel('Server name', { exact: true }).fill('The usual crowd'); await page.getByRole('button', { name: 'Create space', exact: true }).click();
  const snapshot = await api(page, '/bootstrap'); const server = snapshot.servers[0]; const invite = await api(page, `/servers/${server.id}/invites`, {}); await api(other, '/invites/join', { code: invite.code });
  await other.getByRole('button', { name: 'Open The usual crowd', exact: true }).click(); await page.getByRole('button', { name: 'general', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello <script>window.pwned=true</script>'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(other.getByTestId('message')).toContainText('Hello <script>'); expect(await other.evaluate(() => (window as any).pwned)).toBeUndefined();
  await other.getByTestId('message').hover(); await other.getByRole('button', { name: 'React with thumbs up' }).click(); await expect(page.locator('.reactions')).toContainText('1');
  await page.getByTestId('message').hover(); await page.getByRole('button', { name: 'Edit message', exact: true }).click(); await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Edited together.'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(other.getByTestId('message')).toContainText('Edited together.');
  const robin = snapshot.users.find((u: any) => u.username.startsWith('robin')); const dm = await api(page, '/dms', { userId: robin.id }); await page.getByRole('button', { name: 'Home', exact: true }).click(); await page.getByRole('button', { name: new RegExp(robin.displayName), exact: false }).first().click();
  await api(page, '/messages', { conversationId: dm.id, content: 'Just between us.' });
  await other.reload(); await other.getByRole('button', { name: 'Home', exact: true }).click(); await expect(other.locator('.dm-item .unread-dot')).toBeVisible(); await other.locator('.dm-item').first().click(); await expect(other.getByTestId('message')).toContainText('Just between us.');
  await page.getByRole('button', { name: 'Home', exact: true }).click(); await mkdir('artifacts/evidence', { recursive: true }); await page.screenshot({ path: 'artifacts/evidence/web-home.png', fullPage: true }); await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: 'artifacts/evidence/web-mobile.png', fullPage: true });
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(r => r.url)))).flat());
  expect(cached.some(url => /\/assets\/.*\.js$/.test(url))).toBe(true); expect(cached.some(url => /\/(api|avatars|socket.io)\//.test(url))).toBe(false);
  await a.setOffline(true); await page.reload(); await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await a.setOffline(false); await page.reload(); await expect(page.getByRole('heading', { name: `Hey, Alice${suffix}.` })).toBeVisible();
  await a.close(); await b.close();
});

test('actual WebRTC decodes audio/video, applies volume and mute, unsubscribes and migrates coordinator', async ({ browser }) => {
  const a = await browser.newContext({ permissions: ['microphone'] }), b = await browser.newContext({ permissions: ['microphone'] }), page = await a.newPage(), other = await b.newPage(); await instrument(page); await instrument(other); const suffix = Date.now().toString().slice(-7);
  await register(page, `VoiceA${suffix}`); await register(other, `VoiceB${suffix}`);
  const server = await api(page, '/servers', { name: 'Voice lab' }); const invite = await api(page, `/servers/${server.id}/invites`, {}); await api(other, '/invites/join', { code: invite.code });
  await page.getByRole('button', { name: 'Open Voice lab', exact: true }).click(); await other.getByRole('button', { name: 'Open Voice lab', exact: true }).click();
  await page.getByRole('button', { name: 'Lounge', exact: true }).click();
  await expect(other.getByLabel('Participants in Lounge')).toContainText(`VoiceA${suffix}`);
  await expect(other.locator('.voice-panel')).toHaveCount(0);
  await mkdir('artifacts/evidence', { recursive: true }); await other.screenshot({ path: 'artifacts/evidence/voice-observer-before-join.png' });
  await other.reload(); await other.getByRole('button', { name: 'Open Voice lab', exact: true }).click();
  await expect(other.getByLabel('Participants in Lounge')).toContainText(`VoiceA${suffix}`);
  await other.getByRole('button', { name: 'Lounge', exact: true }).click();
  await expect(page.locator('.voice-card')).toHaveCount(2); await expect(other.locator('.voice-card')).toHaveCount(2);
  await expect.poll(async () => (await stats(other)).some(r => r.type === 'inbound-rtp' && r.kind === 'audio' && r.totalSamplesReceived > 0), { timeout: 30000 }).toBe(true).catch(async e => {
    const pcs = await other.evaluate(() => (window as any).__pcs.map((p: RTCPeerConnection) => ({ state: p.connectionState, signaling: p.signalingState, local: p.localDescription?.type, remote: p.remoteDescription?.type })));
    await other.getByRole('button', { name: 'Connection diagnostics', exact: true }).click(); console.log('RTC diagnosis', await other.locator('.diagnostics pre').innerText(), JSON.stringify(pcs)); throw e;
  });
  await other.getByRole('slider').fill('50'); await expect(other.locator('.volume-slider small')).toContainText('50%');
  expect(await other.evaluate(() => (window as any).__gains.some((g: GainNode) => g.gain.value === 0.5))).toBe(true);
  await other.getByRole('button', { name: 'Deafen', exact: true }).click(); expect(await other.evaluate(() => (window as any).__gains.every((g: GainNode) => g.gain.value === 0))).toBe(true); await other.getByRole('button', { name: 'Undeafen', exact: true }).click();
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click(); await expect(other.locator('.voice-card').first()).toContainText('Microphone muted'); await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await expect.poll(async () => (await stats(other)).some(r => r.type === 'inbound-rtp' && r.kind === 'video' && r.framesDecoded > 0), { timeout: 30000 }).toBe(true); await expect(other.locator('.screen video')).toBeVisible();
  await other.getByRole('button', { name: 'Stop watching stream', exact: true }).click(); await expect(other.locator('.screen')).toHaveCount(0);
  await other.getByRole('button', { name: /Watch stream/ }).click(); await expect(other.locator('.screen video')).toBeVisible();
  await other.getByRole('button', { name: 'Share screen', exact: true }).click(); await expect(page.locator('.share-list>div')).toHaveCount(2); await expect(page.locator('.screen video')).toBeVisible();
  const decodedMedia = { sender: await stats(page), receiver: await stats(other) };
  await page.getByRole('button', { name: 'Connection diagnostics', exact: true }).click(); const before = await page.locator('.diagnostics').innerText(); await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click(); await expect(other.locator('.voice-card')).toHaveCount(1); await other.getByRole('button', { name: 'Connection diagnostics', exact: true }).click(); await expect(other.locator('.diagnostics')).toContainText(`VoiceB${suffix}`);
  await mkdir('artifacts/evidence', { recursive: true }); await other.screenshot({ path: 'artifacts/evidence/voice-migration.png', fullPage: true });
  const { writeFile } = await import('node:fs/promises'); await writeFile('artifacts/evidence/webrtc.json', JSON.stringify({ scenario: 'two Chrome contexts, actual WebRTC, fake microphone and deterministic canvas capture', beforeCoordinatorLeave: before, decodedMedia }, null, 2));
  await a.close(); await b.close();
});


test('blocked ICE reports missing media and waiting video instead of a successful call', async ({ browser }) => {
  const a = await browser.newContext({ permissions: ['microphone'] }), b = await browser.newContext({ permissions: ['microphone'] }), page = await a.newPage(), other = await b.newPage();
  await instrument(page, true); await instrument(other, true); const suffix = Date.now().toString().slice(-7);
  await register(page, `BlockedA${suffix}`); await register(other, `BlockedB${suffix}`);
  const server = await api(page, '/servers', { name: 'Blocked media lab' }); const invite = await api(page, `/servers/${server.id}/invites`, {}); await api(other, '/invites/join', { code: invite.code });
  await page.getByRole('button', { name: 'Open Blocked media lab', exact: true }).click(); await other.getByRole('button', { name: 'Open Blocked media lab', exact: true }).click();
  await page.getByRole('button', { name: 'Lounge', exact: true }).click(); await other.getByRole('button', { name: 'Lounge', exact: true }).click();
  await expect(other.locator('.voice-card')).toHaveCount(2);
  await expect(other.locator('.voice-signal')).not.toContainText('Voice connected');
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await expect(other.locator('.screen-status')).toContainText('Connecting to screen');
  await expect(other.locator('.screen-status')).toContainText('No video received yet', { timeout: 22000 });
  await expect(other.getByRole('alert')).toContainText('enable a media relay', { timeout: 16000 });
  await expect(other.locator('.voice-signal')).toContainText('taking too long');
  expect((await stats(other)).some(r => r.type === 'inbound-rtp' && (r.framesDecoded > 0 || r.totalSamplesReceived > 0))).toBe(false);
  await other.getByRole('button', { name: 'Connection diagnostics', exact: true }).click();
  await expect(other.locator('.diagnostics pre')).toContainText('"relayConfigured": false');
  await other.screenshot({ path: 'artifacts/evidence/blocked-media-diagnostics.png' });
  await a.close(); await b.close();
});


test('microphone processing defaults on, persists and applies on rejoin without unmuting', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['microphone'] }), page = await context.newPage();
  page.setDefaultTimeout(15000);
  const settings = () => page.evaluate(() => [...new Set(((window as any).__microphones as MediaStream[]).flatMap(stream => stream.getAudioTracks()))].filter(track => track.readyState === 'live').map(track => ({ ...track.getSettings(), enabled: track.enabled, trackId: track.id })));
  const open = () => page.getByRole('button', { name: 'Connection diagnostics', exact: true }).click();
  const close = () => page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const join = () => page.getByRole('button', { name: 'Lounge', exact: true }).click();
  try {
    await instrument(page); await register(page, 'Processing' + Date.now().toString().slice(-7));
    await page.getByRole('button', { name: 'Create a server', exact: true }).click(); await page.getByLabel('Server name', { exact: true }).fill('Microphone lab'); await page.getByRole('button', { name: 'Create space', exact: true }).click();
    await page.getByRole('button', { name: 'Open Microphone lab', exact: true }).click(); await join();
    await expect(page.locator('.voice-card')).toHaveCount(1); await open();
    const initial = await settings(); expect(initial[0]).toMatchObject({ noiseSuppression: true, echoCancellation: true });
    for (const label of ['Noise suppression', 'Echo cancellation']) { await expect(page.getByRole('checkbox', { name: label, exact: true })).toBeChecked(); await page.getByRole('checkbox', { name: label, exact: true }).uncheck(); }
    await expect(page.getByText('Saved. Leave and rejoin voice to apply these changes.', { exact: true })).toBeVisible();
    expect((await settings())[0]).toMatchObject({ noiseSuppression: true, echoCancellation: true, trackId: initial[0].trackId });
    await page.getByRole('combobox', { name: /^Microphone/ }).selectOption('');
    await expect.poll(async () => (await settings())[0]).toMatchObject({ noiseSuppression: true, echoCancellation: true });
    await page.reload(); await page.getByRole('button', { name: 'Open Microphone lab', exact: true }).click(); await join();
    await expect.poll(async () => (await settings())[0]).toMatchObject({ noiseSuppression: false, echoCancellation: false });
    await page.getByRole('button', { name: 'Mute microphone', exact: true }).click(); await open();
    for (const label of ['Noise suppression', 'Echo cancellation']) { await expect(page.getByRole('checkbox', { name: label, exact: true })).not.toBeChecked(); await page.getByRole('checkbox', { name: label, exact: true }).check(); }
    const pendingWhileMuted = await settings(); expect(pendingWhileMuted[0]).toMatchObject({ noiseSuppression: false, echoCancellation: false, enabled: false });
    await close(); await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click(); await expect(page.locator('.voice-panel')).toHaveCount(0); await join();
    await expect.poll(async () => (await settings())[0]).toMatchObject({ noiseSuppression: true, echoCancellation: true, enabled: false });
    await open(); await expect(page.getByText('Saved. Leave and rejoin voice to apply these changes.', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0, { timeout: 10000 }); await expect(page.locator('.voice-card')).toHaveCount(1);
    await mkdir('artifacts/evidence', { recursive: true }); await page.screenshot({ path: 'artifacts/evidence/audio-processing-controls.png' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile('artifacts/evidence/audio-processing.json', JSON.stringify({ measuredAt: new Date().toISOString(), initial, persistedAfterReload: 'both false verified on the new microphone track', pendingWhileMuted, enabledAfterRejoin: await settings(), limitations: 'Actual browser capture/settings; acoustic noise/echo attenuation on physical devices is not measured.' }, null, 2));
  } finally { await context.close(); }
});
