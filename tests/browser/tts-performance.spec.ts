import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { mkdir, writeFile } from 'node:fs/promises';
import { completeRecovery } from './recovery-helper';

test.use({ trace: 'off', video: 'off', launchOptions: { args: ['--disable-gpu', '--renderer-process-limit=2', '--autoplay-policy=no-user-gesture-required'] } });

test('whole speech waits for completion with a small message progress bar, private delivery and deafen', async ({ page, request, baseURL }) => {
  const suffix = Date.now().toString().slice(-8), password = 'Tts-performance-fixture';
  async function account(name: string) {
    const r = await request.post('/api/v1/auth/register', { headers: { 'X-Dorham-Native': '1' }, data: { username: name + suffix, displayName: name, password, requestId: randomUUID() } });
    expect(r.status()).toBe(201); return r.json();
  }
  async function api(user: any, path: string, body?: any, method = 'POST') {
    const r = await request.fetch('/api/v1' + path, { method, headers: { Authorization: 'Bearer ' + user.accessToken }, data: body === undefined ? undefined : { requestId: randomUUID(), ...body } });
    expect(r.ok(), await r.text()).toBe(true); return r.json();
  }
  const sender = await account('Speaker'), listener = await account('Listener'), outside = await account('Outside');
  const server = await api(sender, '/servers', { name: 'Chunked speech lab' });
  const invite = await api(sender, `/servers/${server.id}/invites`, { uses: 5 });
  for (const user of [listener, outside]) await api(user, '/invites/join', { code: invite.code });
  const channels = (await api(sender, '/bootstrap', undefined, 'GET')).channels;
  const voice = channels.find((c: any) => c.kind === 'voice'), chat = channels.find((c: any) => c.kind === 'text');
  const sockets: Socket[] = [], denied: unknown[] = [];
  async function connect(user: any) {
    const socket = io(baseURL!, { transports: ['websocket'], auth: { token: user.accessToken }, reconnection: false }); sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return socket;
  }
  const actor = await connect(sender), outsider = await connect(outside);
  outsider.on('voice:tts', event => denied.push(event)); outsider.on('voice:tts-progress', event => denied.push(event));
  const action = async (name: string, body = {}) => { const result = await actor.timeout(5000).emitWithAck(name, { requestId: randomUUID(), ...body }); expect(result.ok).toBe(true); };
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    await action('voice:join', { channelId: voice.id, eligible: false });
    heartbeat = setInterval(() => { void action('voice:heartbeat', { eligible: false }).catch(() => {}); }, 5000);
    await page.addInitScript(() => {
      (window as any).__tts = [];
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function(...args: any[]) {
        if (this.buffer) (window as any).__tts.push({ at: Date.now(), seconds: this.buffer.duration, running: this.context.state === 'running', rms: Math.sqrt(this.buffer.getChannelData(0).reduce((n, v) => n + v * v, 0) / this.buffer.length) });
        return (start as any).apply(this, args);
      };
    });
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(listener.user.username);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Let’s get you in', exact: true }).click();
    await completeRecovery(page);
    await page.getByRole('button', { name: 'Open Chunked speech lab', exact: true }).click();
    await page.getByRole('button', { name: 'Lounge', exact: true }).click();
    await expect(page.locator('.gaming-voice')).toBeVisible();
    const showChat = page.getByRole('button', { name: 'Show chat', exact: true }); if (await showChat.isVisible()) await showChat.click();
    const count = () => page.evaluate(() => (window as any).__tts.length);
    const started = Date.now();
    const event = await api(sender, '/messages', { conversationId: chat.conversationId, content: '/tts سلام دوستان hello friends' });
    const progress = page.getByTestId('message').filter({ hasText: 'سلام دوستان hello friends' }).getByRole('progressbar', { name: 'Preparing speech' });
    await expect(progress).toBeVisible();
    await expect.poll(async () => Number(await progress.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(35);
    const percent = Number(await progress.getAttribute('aria-valuenow')); expect(percent).toBeGreaterThanOrEqual(0); expect(percent).toBeLessThan(100);
    expect(await count()).toBe(0);
    await mkdir('artifacts/windows-1.1.1', { recursive: true });
    await page.screenshot({ path: 'artifacts/windows-1.1.1/tts-progress-message.png' });
    await expect.poll(count).toBe(1);
    const played = await page.evaluate(() => (window as any).__tts);
    expect(played[0].at - started).toBeGreaterThanOrEqual(2900);
    await expect(progress).toHaveCount(0);
    expect(played.every((clip: any) => clip.running && clip.rms > 0.02)).toBe(true);
    expect(denied).toHaveLength(0);
    for (const id of [event.payload.id, event.payload.id + '-tts-1']) {
      const deniedResponse = await request.get('/api/v1/voice/tts/' + id + '/audio', { headers: { Authorization: 'Bearer ' + outside.accessToken } });
      expect(deniedResponse.status()).toBe(404);
    }
    const partial = await request.get('/api/v1/voice/tts/' + event.payload.id + '-tts-1/audio', { headers: { Authorization: 'Bearer ' + listener.accessToken } }); expect(partial.status()).toBe(404);
    await page.getByRole('button', { name: 'Deafen', exact: true }).click();
    await page.waitForTimeout(Math.max(0, 4100 - (Date.now() - started)));
    await api(sender, '/messages', { conversationId: chat.conversationId, content: '/tts deafened listener receives text only' });
    await expect(page.getByTestId('message').last()).toContainText('deafened listener receives text only');
    await page.waitForTimeout(3600); expect(await count()).toBe(1); await expect(page.getByRole('progressbar', { name: 'Preparing speech' })).toHaveCount(0);
    await writeFile('artifacts/windows-1.1.1/tts-whole-message-browser.json', JSON.stringify({ oneBrowserListener: true, singleCompleteWav: true, progressVisibleBesideMessage: true, progressRemovedWhenReady: true, noPartialAudio: true, observedPercent: percent, minimumThreeSecondDelay: true, privateRoomDelivery: true, progressPrivate: true, deafen: true, decodedFixturePCM: played, realPiperTestedSeparately: true }, null, 2));
  } finally { clearInterval(heartbeat); sockets.forEach(socket => socket.disconnect()); }
});
