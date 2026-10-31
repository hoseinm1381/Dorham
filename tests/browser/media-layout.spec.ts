import { completeRecovery, chooseScreen } from './recovery-helper';
import { RoomServiceClient } from 'livekit-server-sdk';
import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { makeVideo } from '../media-fixtures';
test.use({ trace: 'off', video: 'off' });
async function api(page: Page, route: string, body?: any) { return page.evaluate(async ({ route, body }) => { const me = await (await fetch('/api/v1/auth/me')).json(); const r = await fetch('/api/v1' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf }, body: body ? JSON.stringify({ requestId: crypto.randomUUID(), ...body }) : undefined }); if (!r.ok) throw new Error(`API ${r.status}`); return r.json(); }, { route, body }); }
async function register(page: Page, name: string) { await page.goto('/'); await page.getByRole('button', { name: 'Create an account', exact: true }).click(); await page.getByLabel('Display name', { exact: true }).fill(name); await page.getByLabel('Username', { exact: true }).fill(name); await page.getByLabel('Password', { exact: true }).fill('fixture888'); await page.getByRole('button', { name: 'Create account', exact: true }).click(); await completeRecovery(page); await expect(page.getByRole('heading', { name: `Hey, ${name}.` })).toBeVisible(); }
async function sendFile(page: Page, name: string, mimeType: string, buffer: Buffer) { await page.locator('.file-composer input[type=file]').setInputFiles({ name, mimeType, buffer }); await expect(page.locator('.attachment-draft').filter({ hasText: name })).toBeVisible(); await page.getByRole('button', { name: 'Send message', exact: true }).click(); }
test('inline image viewer and seekable video decode uploaded attachments, including after reload', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } }), page = await context.newPage(), ranges: number[] = [];
  page.on('response', response => { if (new URL(response.url()).pathname.endsWith('/media')) ranges.push(response.status()); });
  try {
    await register(page, `Inline${Date.now().toString().slice(-7)}`); const server = await api(page, '/servers', { name: 'Inline attachment lab' }); await page.getByRole('button', { name: 'Open Inline attachment lab', exact: true }).click();
    const image = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#34bca5' } }).png().toBuffer();
    await sendFile(page, 'picture.png', 'image/png', image); const thumb = page.locator('.attachment-preview img'); await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640);
    await page.getByRole('button', { name: 'Open image: picture.png', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Image viewer' })).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: 'Image viewer' })).not.toBeVisible();
    const video = await makeVideo(page); await sendFile(page, 'clip.webm', 'video/webm', video); const player = page.getByLabel('Play video: clip.webm', { exact: true });
    await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(320); await player.evaluate((v: HTMLVideoElement) => v.play()); await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(1);
    await player.evaluate((v: HTMLVideoElement) => { v.pause(); v.currentTime = 0.6; }); await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.5);
    const mp4 = await readFile('tests/fixtures/inline-video.mp4'); await sendFile(page, 'movie.mp4', 'video/mp4', mp4); const mp4Player = page.getByLabel('Play video: movie.mp4', { exact: true });
    await expect.poll(() => mp4Player.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(320); await mp4Player.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
    await expect.poll(() => mp4Player.evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(1); await mp4Player.evaluate((v: HTMLVideoElement) => v.pause());
    expect(ranges).toContain(206);
    await page.reload(); await page.getByRole('button', { name: 'Open Inline attachment lab', exact: true }).click(); await expect(page.getByLabel('Play video: clip.webm', { exact: true })).toBeVisible();
    await mkdir('artifacts/evidence', { recursive: true }); await page.screenshot({ path: 'artifacts/evidence/v04-inline-attachments.png' }); await writeFile('artifacts/evidence/v04-inline-video.webm', video);
    expect(server.id).toBeTruthy();
  } finally { await context.close(); }
});
test('screen-first layout, optional own capture preview, minimized members and peer departure sounds', async ({ browser }) => {
  const a = await browser.newContext({ locale: 'en-US', permissions: ['microphone'], viewport: { width: 1440, height: 1000 } }), b = await browser.newContext({ locale: 'en-US', permissions: ['microphone'], viewport: { width: 1440, height: 1000 } }), page = await a.newPage(), other = await b.newPage(), suffix = Date.now().toString().slice(-7);
  let fixtureRoom: string | undefined;
  for (const p of [page, other]) await p.addInitScript(() => {
    (window as any).__cues = []; (window as any).__pcs = []; const Original = RTCPeerConnection;
    (window as any).RTCPeerConnection = new Proxy(Original, { construct(Target, args) { const pc = new Target(...args); (window as any).__pcs.push(pc); return pc; } });
    window.addEventListener('dorham-sound-played', e => (window as any).__cues.push((e as CustomEvent).detail));
    navigator.mediaDevices.getDisplayMedia = async () => { const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360; const draw = canvas.getContext('2d')!; let n = 0; const timer = setInterval(() => { draw.fillStyle = n++ % 2 ? '#713ce0' : '#34bca5'; draw.fillRect(0, 0, 640, 360); }, 100); const stream = canvas.captureStream(12); (window as any).__captureTrack = stream.getVideoTracks()[0]; stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer)); return stream; };
  });
  try {
    await register(page, `PreviewA${suffix}`); await register(other, `PreviewB${suffix}`);
    const server = await api(page, '/servers', { name: 'Screen focus lab' }); fixtureRoom = (await api(page, '/bootstrap')).channels.find((c: any) => c.serverId === server.id && c.kind === 'voice').id; const invite = await api(page, `/servers/${server.id}/invites`, {}); await api(other, '/invites/join', { code: invite.code });
    for (const p of [page, other]) { await p.getByRole('button', { name: 'Open Screen focus lab', exact: true }).click(); await p.getByRole('button', { name: 'Lounge', exact: true }).click(); }
    await expect(page.locator('.voice-mini-members button')).toHaveCount(2);
    await page.getByRole('button', { name: 'Share screen', exact: true }).click(); await chooseScreen(page); await expect(other.locator('.screen video')).toBeVisible();
    await expect.poll(() => other.locator('.screen video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(300);
    await expect.poll(() => other.locator('.screen video').evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(2);
    const screen = (await other.locator('.screen video').boundingBox())!, main = (await other.locator('main').boundingBox())!, chat = (await other.locator('.message-scroll').boundingBox())!;
    expect(screen.height).toBeGreaterThan(main.height * 0.55); expect(screen.height).toBeGreaterThan(chat.height * 4); await expect(other.locator('.voice-cards')).not.toBeVisible();
    await expect(page.locator('.own-screen-preview')).toHaveCount(0); await page.getByRole('checkbox', { name: 'Preview my screen', exact: true }).check(); await expect(page.locator('.own-screen-preview video')).toBeVisible();
    await expect.poll(() => page.locator('.own-screen-preview video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(640);
    const cv = (await api(page, '/bootstrap')).channels.find((c: any) => c.serverId === server.id && c.kind === 'voice'), lease = (await api(page, `/voice/${cv.id}`)).shares[0].id;
    await page.getByRole('button', { name: 'Hide my screen preview', exact: true }).click(); await expect(page.locator('.own-screen-preview')).toHaveCount(0); expect((await api(page, `/voice/${cv.id}`)).shares[0].id).toBe(lease); expect(await page.evaluate(() => (window as any).__captureTrack.readyState)).toBe('live');
    const before = (await other.locator('main').boundingBox())!.width; await other.getByRole('button', { name: 'Minimize members panel', exact: true }).click(); expect((await other.locator('main').boundingBox())!.width).toBeGreaterThan(before + 180); expect((await other.locator('.members-sidebar').boundingBox())!.width).toBeLessThanOrEqual(35);
    await mkdir('artifacts/evidence', { recursive: true }); const mode = (await api(page, '/bootstrap')).mediaTransport; await other.screenshot({ path: `artifacts/evidence/v04-screen-focus-${mode}.png` });
    await other.getByRole('button', { name: 'Voice controls', exact: true }).click(); await expect(other.locator('.voice-cards')).toBeVisible(); await other.getByRole('button', { name: 'Minimize voice', exact: true }).click();
    const leaves = await other.evaluate(() => (window as any).__cues.filter((c: string) => c === 'leave').length); await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click(); await expect.poll(() => other.evaluate(() => (window as any).__cues.filter((c: string) => c === 'leave').length)).toBe(leaves + 1);
    await page.getByRole('button', { name: 'Lounge', exact: true }).click(); await expect(other.locator('.voice-mini-members button')).toHaveCount(2);
    const beforeClose = await other.evaluate(() => (window as any).__cues.filter((c: string) => c === 'leave').length); await page.close();
    await expect.poll(() => other.evaluate(() => (window as any).__cues.filter((c: string) => c === 'leave').length)).toBe(beforeClose + 1);
    await other.reload(); await expect(other.locator('.app')).toHaveClass(/members-collapsed/);
    await writeFile(`artifacts/evidence/v04-media-layout-${mode}.json`, JSON.stringify({ screenHeight: screen.height, mainHeight: main.height, chatHeight: chat.height, ownPreviewDecoded: true, ownPreviewClosePreservedCapture: true, otherPeerDepartureCue: true, tabCloseDepartureCue: true, membersCollapsedPersisted: true, mediaTransport: mode }, null, 2));
  } finally { await a.close(); await b.close(); if (fixtureRoom && process.env.DORHAM_SFU_ISOLATED_TEST === '1') { const client = new RoomServiceClient(process.env.LIVEKIT_API_URL!, process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!); await client.deleteRoom(fixtureRoom).catch(() => {}); } }
});
