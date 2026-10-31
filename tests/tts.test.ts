import { expect, it } from 'vitest';
import { harness, event } from './helpers';
import { fixtureSpeech } from './tts-fixture';
import { ttsMessage } from '../packages/contracts/src/tts';
it('recognizes /tts without treating similar words as commands', () => {
  expect(ttsMessage('/tts سلام hello')).toEqual({ requested: true, text: 'سلام hello' });
  expect(ttsMessage('/ttstuff hello').requested).toBe(false);
});
it('delivers speech only to the same live voice epoch, keeps no-voice text normal and protects audio access', async () => {
  let resolve!: (buffer: Buffer) => void, syntheses = 0;
  const h = await harness({}, { ttsSynthesize: async () => { syntheses++; return new Promise<Buffer>(r => { resolve = r; }); } });
  try {
    const a = await h.register('speech_a'), b = await h.register('speech_b'), c = await h.register('speech_c');
    const server = (await h.api(a, '/servers', { name: 'Speech lab' })).json(), invite = (await h.api(a, `/servers/${server.id}/invites`, { uses: 10 })).json();
    for (const person of [b, c]) await h.api(person, '/invites/join', { code: invite.code });
    const channels = (await h.api(a, '/bootstrap')).json().channels, voice = channels.find((ch: any) => ch.kind === 'voice'), chat = channels.find((ch: any) => ch.kind === 'text');
    const sa = await h.connect(a), sb = await h.connect(b), sc = await h.connect(c), received: any[] = [], own: any[] = [], outside: any[] = [];
    sa.on('voice:tts', e => own.push(e));
    sb.on('voice:tts', e => received.push(e)); sc.on('voice:tts', e => outside.push(e));
    const plain = (await h.api(a, '/messages', { conversationId: chat.conversationId, content: '/tts no voice' })).json(); expect(plain.payload.content).toBe('no voice'); expect(syntheses).toBe(0);
    await event(sa, 'voice:join', { channelId: voice.id, eligible: false }); await event(sb, 'voice:join', { channelId: voice.id, eligible: false });
    const body = { conversationId: chat.conversationId, content: '/tts سلام friends', requestId: crypto.randomUUID() };
    const posted = (await h.api(a, '/messages', body)).json(); await h.api(a, '/messages', body);
    await expect.poll(() => syntheses).toBe(1); resolve(fixtureSpeech()); await expect.poll(() => received.length).toBe(1); expect(outside).toHaveLength(0);
    const audio = await h.api(b, `/voice/tts/${posted.payload.id}/audio`); expect(audio.statusCode).toBe(200); expect(audio.headers['cache-control']).toBe('private, no-store');
    expect((await h.api(c, `/voice/tts/${posted.payload.id}/audio`)).statusCode).toBe(404);
    await event(sb, 'voice:leave', { requestId: crypto.randomUUID() }); expect((await h.api(b, `/voice/tts/${posted.payload.id}/audio`)).statusCode).toBe(404);
    await event(sb, 'voice:join', { channelId: voice.id, eligible: false }); expect((await h.api(b, `/voice/tts/${posted.payload.id}/audio`)).statusCode).toBe(404);
    await h.api(b, '/messages', { conversationId: chat.conversationId, content: 'leaving before generation ends', tts: true }); await expect.poll(() => syntheses).toBe(2); await event(sb, 'voice:leave', { requestId: crypto.randomUUID() }); resolve(fixtureSpeech()); await new Promise(r => setTimeout(r, 50)); expect(own).toHaveLength(1);
    await h.db.run('UPDATE voice_members SET server_muted=1 WHERE user_id=?', [a.id]);
    await h.api(a, '/messages', { conversationId: chat.conversationId, content: 'muted text', tts: true }); await new Promise(r => setTimeout(r, 30)); expect(syntheses).toBe(2);
  } finally { await h.close(); }
});
