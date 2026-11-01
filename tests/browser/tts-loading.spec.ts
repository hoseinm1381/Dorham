import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import { writeFile } from 'node:fs/promises';
import { completeRecovery } from './recovery-helper';

test.use({ trace: 'off', launchOptions: { args: ['--disable-gpu', '--renderer-process-limit=2', '--autoplay-policy=no-user-gesture-required'] } });
test('cold-start recordings play in each listener language before speech, and obey mute TTS and deafen', async ({ page, request, baseURL }) => {
  page.setDefaultTimeout(12000);
  const suffix = Date.now().toString().slice(-8), password = 'loading-browser-fixture';
  async function account(name: string) { const r = await request.post('/api/v1/auth/register', { headers: { 'X-Dorham-Native': '1' }, data: { username: name + suffix, displayName: name, password, requestId: randomUUID() } }); expect(r.status()).toBe(201); return r.json(); }
  const a = await account('Speaker'), b = await account('Listener');
  async function api(user: any, path: string, body?: any, method = 'POST') { const r = await request.fetch('/api/v1' + path, { method, headers: { Authorization: 'Bearer ' + user.accessToken }, data: body === undefined ? undefined : { requestId: randomUUID(), ...body } }); expect(r.ok(), await r.text()).toBe(true); return r.json(); }
  const server = await api(a, '/servers', { name: 'Loading lab' }), invite = await api(a, `/servers/${server.id}/invites`, {}); await api(b, '/invites/join', { code: invite.code });
  const channels = (await api(a, '/bootstrap', undefined, 'GET')).channels, voice = channels.find((c: any) => c.kind === 'voice'), chat = channels.find((c: any) => c.kind === 'text');
  const actor = io(baseURL!, { transports: ['websocket'], auth: { token: a.accessToken }, reconnection: false });
  async function action(name: string, body: any = {}) { const result = await actor.timeout(5000).emitWithAck(name, { requestId: randomUUID(), ...body }); expect(result.ok).toBe(true); return result.data; }
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { actor.once('connect', resolve); actor.once('connect_error', reject); }); await action('voice:join', { channelId: voice.id, eligible: false });
    heartbeat = setInterval(() => { void action('voice:heartbeat', { eligible: false }).catch(() => {}); }, 5000);
    await page.addInitScript(() => { (window as any).__speech = []; (window as any).__decodes = []; const decode = AudioContext.prototype.decodeAudioData; AudioContext.prototype.decodeAudioData = function(data: ArrayBuffer) { const entry: any = { bytes: data.byteLength, magic: new TextDecoder().decode(data.slice(0,12)) }; (window as any).__decodes.push(entry); return decode.call(this,data).then(buffer => { entry.seconds=buffer.duration; return buffer; }, error => { entry.error=String(error); throw error; }); }; const start = AudioBufferSourceNode.prototype.start; AudioBufferSourceNode.prototype.start = function(...args: any[]) { if (this.buffer) (window as any).__speech.push({ seconds: this.buffer.duration, time: performance.now(), rms: Math.sqrt(this.buffer.getChannelData(0).reduce((n,v) => n+v*v,0)/this.buffer.length) }); return (start as any).apply(this,args); }; });
    await page.goto('/'); await page.getByLabel('Username', { exact: true }).fill(b.user.username); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Let’s get you in', exact: true }).click(); await completeRecovery(page); await page.getByRole('button', { name: 'Open Loading lab', exact: true }).click();
    // No physical microphone is needed to listen to speech.
    await page.getByRole('button', { name: 'Lounge', exact: true }).click(); await expect(page.locator('.gaming-voice')).toBeVisible();
    await writeFile('artifacts/evidence/v107-loading-cache-debug.json', JSON.stringify(await page.evaluate(async () => {
      const entries = []; for (const name of await caches.keys()) { const cache=await caches.open(name); for (const r of await cache.keys()) if(r.url.includes('tts-loading')) { const response=(await cache.match(r))!; entries.push({url:r.url,status:response.status,bytes:(await response.arrayBuffer()).byteLength}); } }
      return {controller:navigator.serviceWorker.controller?.scriptURL,entries};
    }), null, 2));
    const count = () => page.evaluate(() => (window as any).__speech.length), loadingFiles: string[] = [];
    page.on('request', r => { if (/tts-loading-(en|fa)-[^/]+\.wav\?v=1\.0\.7$/.test(r.url())) loadingFiles.push(r.url()); });
    await api(a, '/messages', { conversationId: chat.conversationId, content: 'English cold fixture', tts: true }); await expect.poll(count).toBe(2);
    let played = await page.evaluate(() => (window as any).__speech); expect(played[0].seconds).toBeCloseTo(1.606, 2); expect(played[1].seconds).toBeCloseTo(0.5, 2); expect(played[1].time-played[0].time).toBeGreaterThan(1400); expect(loadingFiles[0]).toMatch(/tts-loading-en-[^/]+\.wav\?v=1\.0\.7$/);
    await page.getByRole('button', { name: 'Account settings', exact: true }).click(); await page.getByLabel('Language', { exact: true }).selectOption('fa-IR'); await page.getByRole('button', { name: 'بستن پنجره', exact: true }).click();
    // A second sender avoids the independent four-second request cooldown.
    const secondAt = Date.now(); await api(b, '/messages', { conversationId: chat.conversationId, content: 'سلام، آزمون شروع سرد', tts: true }); await expect.poll(count).toBe(4);
    played = await page.evaluate(() => (window as any).__speech); expect(played[2].seconds).toBeCloseTo(2.511, 2); expect(played[3].seconds).toBeCloseTo(0.5, 2); expect(played[3].time-played[2].time).toBeGreaterThan(2300); expect(loadingFiles[1]).toMatch(/tts-loading-fa-[^/]+\.wav\?v=1\.0\.7$/); expect(played[0].rms).toBeGreaterThan(0.005); expect(played[2].rms).toBeGreaterThan(0.005);
    // Use English labels again for playback controls, retaining the same voice membership.
    await page.getByRole('button', { name: 'تنظیمات حساب', exact: true }).click(); await page.getByLabel('زبان', { exact: true }).selectOption('en-US'); await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: 'Mute TTS', exact: true }).click(); await api(a, '/messages', { conversationId: chat.conversationId, content: 'TTS muted listener', tts: true }); await expect(page.getByTestId('message').last()).toContainText('TTS muted listener'); await page.waitForTimeout(250); expect(await count()).toBe(4); expect(loadingFiles).toHaveLength(2);
    await page.getByRole('button', { name: 'Unmute TTS', exact: true }).click(); await page.getByRole('button', { name: 'Deafen', exact: true }).click(); await page.waitForTimeout(Math.max(0, 4100 - (Date.now() - secondAt))); await api(b, '/messages', { conversationId: chat.conversationId, content: 'Deafened listener', tts: true }); await expect(page.getByTestId('message').last()).toContainText('Deafened listener'); await page.waitForTimeout(250); expect(await count()).toBe(4); expect(loadingFiles).toHaveLength(2);
    await writeFile('artifacts/evidence/v107-tts-loading-browser.json', JSON.stringify({ oneChromeListener: true, realSocketApiSender: true, fixtureSynthesisSignalsCold: true, realBundledEnglishPersianPcmDecoded: true, clips: played, loadingFiles, serializedBeforeSpeech: true, languageFollowsListenerUi: true, muteTtsAndDeafenPreventFetchAndPlayback: true, physicalMicrophoneUsed: false }, null, 2));
  } finally {
    await writeFile('artifacts/evidence/v107-tts-loading-playback-debug.json', JSON.stringify(await page.evaluate(() => ({ played: (window as any).__speech, decodes: (window as any).__decodes, resources: performance.getEntriesByType('resource').filter(r => /tts|audio/.test(r.name)).map(r => ({ name: r.name, duration: r.duration })) })), null, 2));
    clearInterval(heartbeat); actor.disconnect();
  }
});
