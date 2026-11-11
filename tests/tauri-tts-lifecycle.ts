import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import { usePackagedListenOnly } from './tauri-test-microphone';

export async function proveDeferredTts(page: Page, server: string, listenerToken: string) {
  async function api<T>(route: string, token?: string, body?: object): Promise<T> {
    const response = await fetch(server + '/api/v1' + route, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Dorham-Native': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify({ requestId: randomUUID(), ...body }) } : {}),
    });
    expect(response.ok, route).toBe(true);
    return response.json() as Promise<T>;
  }
  const speaker = await api<{ accessToken: string }>('/auth/register', undefined, {
    username: `tts_${randomUUID().slice(0, 8)}`, displayName: 'Owned speech sender', password: 'Owned speech fixture password',
  });
  const room = await api<{ id: string }>('/servers', listenerToken, { name: 'Owned speech lifecycle' });
  const invite = await api<{ code: string }>(`/servers/${room.id}/invites`, listenerToken, { uses: 1 });
  await api('/invites/join', speaker.accessToken, { code: invite.code });
  const bootstrap = await api<{ channels: { kind: string; serverId: string; id: string; conversationId: string }[] }>('/bootstrap', listenerToken);
  const channels = bootstrap.channels.filter(channel => channel.serverId === room.id);
  const voice = channels.find(channel => channel.kind === 'voice')!;
  const chat = channels.find(channel => channel.kind === 'text')!;
  expect(voice && chat).toBeTruthy();
  const actor = io(server, { transports: ['websocket'], auth: { token: speaker.accessToken }, reconnection: false });
  try {
    await expect.poll(() => actor.connected, { timeout: 8000 }).toBe(true);
    const joined = await actor.timeout(5000).emitWithAck('voice:join', { requestId: randomUUID(), channelId: voice.id, eligible: false });
    expect(joined.ok).toBe(true);
    await page.reload();
    await usePackagedListenOnly(page);
    await page.evaluate(`{
      const speech = window.__ownedSpeechPlayback = [];
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args) {
        if (this.buffer) speech.push({ context: this.context, seconds: this.buffer.duration });
        return start.apply(this, args);
      };
    }`);
    await page.getByRole('button', { name: 'Open Owned speech lifecycle', exact: true }).click();
    await page.getByRole('button', { name: 'Lounge', exact: true }).click();
    await expect(page.locator('.voice-panel')).toContainText('Listening only', { timeout: 20000 });
    await api('/messages', speaker.accessToken, { conversationId: chat.conversationId, content: 'Owned voice TTS fixture', tts: true });
    await expect.poll(() => page.evaluate<number[]>('window.__ownedSpeechPlayback.map(clip => clip.seconds)'), { timeout: 15000 }).toContain(0.5);
    await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click();
    await expect.poll(() => page.evaluate<string[]>('window.__ownedSpeechPlayback.map(clip => clip.context.state)')).toEqual(['closed']);
    console.log(JSON.stringify({ packagedTtsPlayed: true, ttsContextClosedOnLeave: true }));
  } finally {
    actor.disconnect();
  }
}
