import { test, expect, type Page } from '@playwright/test';
import { RoomServiceClient } from 'livekit-server-sdk';
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

test('cookie renewal retries an overlapping member request without logging the user out', async ({ page }) => {
  await register(page, `Renew${Date.now().toString().slice(-7)}`);
  const server = await api(page, '/servers', { name: 'Renewal race lab' });
  const cookie = (await page.context().cookies()).find(c => c.name === 'dorham_session')!;
  let release!: () => void, intercepted!: () => void, requests = 0, staleStatus = 0, freshStatus = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), pending = new Promise<void>(resolve => { intercepted = resolve; });
  await page.route(`**/api/v1/servers/${server.id}/members`, async route => {
    requests++;
    if (requests !== 1) { const response = await route.fetch(); freshStatus = response.status(); await route.fulfill({ response }); return; }
    intercepted(); await gate;
    const response = await route.fetch({ headers: { ...await route.request().allHeaders(), cookie: `dorham_session=${cookie.value}` } });
    staleStatus = response.status(); await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Open Renewal race lab', exact: true }).click(); await pending;
  const renewal = page.waitForResponse(r => r.url().endsWith('/api/v1/auth/renew') && r.ok());
  await page.evaluate(() => window.dispatchEvent(new Event('dorham-native-pulse'))); await renewal;
  release(); await expect.poll(() => requests).toBeGreaterThanOrEqual(2); await expect.poll(() => freshStatus).toBe(200); expect(staleStatus).toBe(401);
  await expect(page.locator('.app')).toBeVisible(); await expect(page.locator('.member-row')).toContainText('Renew');
  await page.unroute(`**/api/v1/servers/${server.id}/members`);
  await page.route('**/api/v1/servers/*/members', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Session revoked.' } }) }));
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Open Renewal race lab', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.', exact: true })).toBeVisible();
});

test('push-to-talk and toggle bindings gate the actual microphone, persist, and release on focus loss', async ({ browser }) => {
  const context = await browser.newContext({permissions:['microphone']}), page = await context.newPage();
  try {
    await instrument(page); await register(page, `Hotkey${Date.now().toString().slice(-7)}`); await api(page,'/servers',{name:'Hotkey lab'});
    await page.getByRole('button',{name:'Open Hotkey lab',exact:true}).click(); await page.getByRole('button',{name:'Account settings',exact:true}).click();
    await page.getByLabel('Voice input mode',{exact:true}).selectOption('push'); await page.getByRole('button',{name:'Record talk hotkey',exact:true}).click(); await page.keyboard.press('F9'); await page.getByRole('button',{name:'Close dialog',exact:true}).click();
    await page.getByRole('button',{name:'Lounge',exact:true}).click(); await expect(page.locator('.voice-stage')).toBeVisible();
    const mic = () => page.evaluate(() => (window as any).__microphones.flatMap((s:MediaStream)=>s.getAudioTracks()).filter((t:MediaStreamTrack)=>t.readyState==='live').map((t:MediaStreamTrack)=>t.enabled));
    await expect.poll(mic).toEqual([false]); await page.keyboard.down('F9'); await expect.poll(mic).toEqual([true]); await page.keyboard.up('F9'); await expect.poll(mic).toEqual([false]);
    await page.getByRole('button',{name:'Lock microphone',exact:true}).click(); await page.keyboard.down('F9'); await expect.poll(mic).toEqual([false]); await page.keyboard.up('F9'); await page.getByRole('button',{name:'Unlock push to talk',exact:true}).click();
    await page.keyboard.down('F9'); await expect.poll(mic).toEqual([true]); await page.evaluate(()=>window.dispatchEvent(new Event('blur'))); await expect.poll(mic).toEqual([false]); await page.keyboard.up('F9');
    await page.getByRole('button',{name:'Account settings',exact:true}).click(); await page.getByLabel('Voice input mode',{exact:true}).selectOption('toggle'); await page.getByRole('button',{name:'Close dialog',exact:true}).click();
    await page.keyboard.press('F9'); await expect.poll(mic).toEqual([true]); await page.keyboard.press('F9'); await expect.poll(mic).toEqual([false]);
    await page.getByRole('textbox',{name:'Message',exact:true}).focus(); await page.keyboard.press('F9'); await expect.poll(mic).toEqual([false]);
    await page.reload(); await page.getByRole('button',{name:'Account settings',exact:true}).click(); await expect(page.getByLabel('Voice input mode',{exact:true})).toHaveValue('toggle'); await expect(page.getByRole('button',{name:'Record talk hotkey',exact:true})).toHaveText('F9');
  } finally { await context.close(); }
});

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
  await other.getByRole('button', { name: 'Voice controls', exact: true }).click();
  await other.getByRole('slider').fill('50'); await expect(other.locator('.volume-slider small')).toContainText('50%');
  expect(await other.evaluate(() => { (window as any).__voiceGains = (window as any).__gains.filter((g: GainNode) => g.gain.value === 0.5); return (window as any).__voiceGains.length > 0; })).toBe(true);
  await other.getByRole('button', { name: 'Deafen', exact: true }).click(); expect(await other.evaluate(() => (window as any).__voiceGains.every((g: GainNode) => g.gain.value === 0))).toBe(true); await other.getByRole('button', { name: 'Undeafen', exact: true }).click();
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


test('quiet decoded audio lights the avatar independently of volume and shared screens take priority', async ({ browser }) => {
  const a = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 900 } }), b = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 900 } });
  const page = await a.newPage(), other = await b.newPage(), suffix = Date.now().toString().slice(-7);
  try {
    await instrument(page); await instrument(other);
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext(); await context.resume();
        const oscillator = context.createOscillator(), gain = context.createGain(), output = context.createMediaStreamDestination();
        oscillator.frequency.value = 440; gain.gain.value = 0.02;
        oscillator.connect(gain).connect(output); oscillator.start();
        (window as any).__quietTone = gain;
        output.stream.getAudioTracks()[0].addEventListener('ended', () => { oscillator.stop(); void context.close(); });
        return output.stream;
      };
    });
    await register(page, `QuietA${suffix}`); await register(other, `QuietB${suffix}`);
    const server = await api(page, '/servers', { name: 'Speaking and screens' }), invite = await api(page, `/servers/${server.id}/invites`, {});
    await api(other, '/invites/join', { code: invite.code });
    for (const p of [page, other]) { await p.getByRole('button', { name: 'Open Speaking and screens', exact: true }).click(); await p.getByRole('button', { name: 'Lounge', exact: true }).click(); }
    await other.getByRole('button', { name: 'Voice controls', exact: true }).click();
    const speaker = other.locator('.voice-card').filter({ hasText: `QuietA${suffix}` });
    await expect.poll(async () => (await stats(other)).some(r => r.type === 'inbound-rtp' && r.kind === 'audio' && r.totalAudioEnergy > 0), { timeout: 30000 }).toBe(true);
    await expect(speaker).toHaveClass(/speaking/);
    await expect(speaker.locator('.avatar')).toHaveCSS('outline-color', 'rgb(131, 218, 186)');
    await other.getByRole('slider').fill('10'); await expect(speaker).toHaveClass(/speaking/);
    await page.evaluate(() => { (window as any).__quietTone.gain.value = 0; });
    await expect(speaker).not.toHaveClass(/speaking/);
    await page.evaluate(() => { (window as any).__quietTone.gain.value = 0.02; }); await expect(speaker).toHaveClass(/speaking/);
    await page.getByRole('button', { name: 'Mute microphone', exact: true }).click(); await expect(speaker).not.toHaveClass(/speaking/);
    await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click(); await expect(speaker).toHaveClass(/speaking/);
    await page.getByRole('button', { name: 'Share screen', exact: true }).click();
    await expect(other.locator('main')).toHaveClass(/screen-focused/); await expect(other.locator('.screen video')).toBeVisible();
    await expect.poll(async () => (await stats(other)).some(r => r.type === 'inbound-rtp' && r.kind === 'video' && r.framesDecoded > 5)).toBe(true);
    await expect(other.locator('.screen-status')).toHaveCount(0);
    const video = await other.locator('.screen video').boundingBox(), chat = await other.locator('.message-scroll').boundingBox();
    expect(video!.height).toBeGreaterThan(chat!.height * 1.5);
    await mkdir('artifacts/evidence', { recursive: true }); await other.screenshot({ path: 'artifacts/evidence/speaking-screen-focus.png' });
    await other.getByRole('button', { name: 'Show more chat', exact: true }).click(); await expect(other.locator('main')).not.toHaveClass(/screen-focused/);
    await other.reload(); await other.getByRole('button', { name: 'Open Speaking and screens', exact: true }).click(); await other.getByRole('button', { name: 'Lounge', exact: true }).click();
    await expect(other.locator('.screen video')).toBeVisible(); await expect(other.locator('main')).not.toHaveClass(/screen-focused/);
    await other.getByRole('button', { name: 'Enlarge screens', exact: true }).click(); await expect(other.locator('main')).toHaveClass(/screen-focused/);
    await other.setViewportSize({ width: 390, height: 844 }); await expect(other.locator('.screen video')).toBeVisible();
    const mobileVideo = await other.locator('.screen video').boundingBox(), mobileChat = await other.locator('.message-scroll').boundingBox(); expect(mobileVideo!.height).toBeGreaterThan(mobileChat!.height);
    await other.screenshot({ path: 'artifacts/evidence/screen-focus-mobile.png' });
    await page.getByRole('button', { name: 'Stop sharing', exact: true }).click(); await expect(other.locator('main')).not.toHaveClass(/screen-focused/);
  } finally { await a.close(); await b.close(); }
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


test('microphone processing defaults on, changes live, persists and never unmutes', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['microphone'] }), page = await context.newPage();
  let fixtureRoom: string | undefined;
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
    fixtureRoom = (await api(page, '/bootstrap')).channels.find((c: any) => c.kind === 'voice').id;
    const initial = await settings(); expect(initial[0]).toMatchObject({ noiseSuppression: true, echoCancellation: true });
    for (const label of ['Noise suppression', 'Echo cancellation']) { await expect(page.getByRole('checkbox', { name: label, exact: true })).toBeChecked(); await page.getByRole('checkbox', { name: label, exact: true }).uncheck(); }
    await expect(page.getByText('Saved. Leave and rejoin voice to apply these changes.', { exact: true })).toHaveCount(0);
    await expect.poll(async () => (await settings())[0]).toMatchObject({ noiseSuppression: false, echoCancellation: false });
    await page.getByRole('checkbox', { name: 'Automatic microphone level', exact: true }).uncheck();
    await expect.poll(async () => (await settings())[0]).toMatchObject({ autoGainControl: false });
    await page.getByRole('combobox', { name: /^Microphone/ }).selectOption('');
    await expect.poll(async () => (await settings())[0]).toMatchObject({ noiseSuppression: false, echoCancellation: false, autoGainControl: false });
    await page.reload(); await page.getByRole('button', { name: 'Open Microphone lab', exact: true }).click(); await join();
    await expect.poll(async () => (await settings())[0]).toMatchObject({ noiseSuppression: false, echoCancellation: false });
    await page.getByRole('button', { name: 'Mute microphone', exact: true }).click(); await open();
    for (const label of ['Noise suppression', 'Echo cancellation']) { await expect(page.getByRole('checkbox', { name: label, exact: true })).not.toBeChecked(); await page.getByRole('checkbox', { name: label, exact: true }).check(); }
    await expect.poll(async () => (await settings())[0]).toMatchObject({ noiseSuppression: true, echoCancellation: true, enabled: false });
    const pendingWhileMuted = await settings();
    await close(); await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click(); await expect(page.locator('.voice-panel')).toHaveCount(0); await join();
    await expect.poll(async () => (await settings())[0]).toMatchObject({ noiseSuppression: true, echoCancellation: true, enabled: false });
    await open(); await expect(page.getByText('Saved. Leave and rejoin voice to apply these changes.', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0, { timeout: 10000 }); await expect(page.locator('.voice-card')).toHaveCount(1);
    await mkdir('artifacts/evidence', { recursive: true }); await page.screenshot({ path: 'artifacts/evidence/audio-processing-controls.png' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile('artifacts/evidence/audio-processing.json', JSON.stringify({ measuredAt: new Date().toISOString(), initial, persistedAfterReload: 'both false verified on the new microphone track', pendingWhileMuted, enabledAfterRejoin: await settings(), limitations: 'Actual browser capture/settings; acoustic noise/echo attenuation on physical devices is not measured.' }, null, 2));
  } finally {
    await context.close();
    if (fixtureRoom && process.env.DORHAM_SFU_ISOLATED_TEST === '1') { const client = new RoomServiceClient(process.env.LIVEKIT_API_URL!, process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!); await client.deleteRoom(fixtureRoom).catch(() => {}); }
  }
});
