import { expect, it } from 'vitest';
import { harness, event } from './helpers';
import { fixtureSpeech } from './tts-fixture';

it('announces cold startup only to current undeafened voice epochs, before speech, without duplicate or warm alerts', async () => {
  let cold = true, generate = 0, release!: () => void;
  const h = await harness({}, { ttsSynthesize: async (_text, loading) => { generate++; if (cold) { await loading?.(); await loading?.(); } await new Promise<void>(resolve => { release = resolve; }); return fixtureSpeech(); } });
  try {
    const a = await h.register('loading_sender'), b = await h.register('loading_listener'), c = await h.register('loading_deaf'), d = await h.register('loading_outside');
    const server = (await h.api(a, '/servers', { name: 'Loading' })).json(), invite = (await h.api(a, `/servers/${server.id}/invites`, { uses: 10 })).json();
    for (const user of [b,c,d]) await h.api(user, '/invites/join', { code: invite.code });
    const channels = (await h.api(a, '/bootstrap')).json().channels, voice = channels.find((ch: any) => ch.kind === 'voice'), chat = channels.find((ch: any) => ch.kind === 'text');
    const sockets = await Promise.all([a,b,c,d].map(user => h.connect(user))), loading: any[][] = [[],[],[],[]], speech: any[][] = [[],[],[],[]];
    sockets.forEach((s,i) => { s.on('voice:tts-loading', e => loading[i].push(e)); s.on('voice:tts', e => speech[i].push(e)); });
    for (const s of sockets.slice(0,3)) await event(s, 'voice:join', { channelId: voice.id, eligible: false });
    await h.db.run('UPDATE voice_members SET deafened=1 WHERE user_id=?', [c.id]);
    const body = { conversationId: chat.conversationId, content: 'cold speech', tts: true, requestId: crypto.randomUUID() }, sent = (await h.api(a, '/messages', body)).json();
    await expect.poll(() => loading[1].length).toBe(1); expect(loading.map(x => x.length)).toEqual([1,1,0,0]); expect(speech[1]).toHaveLength(0);
    expect(loading[1][0]).toMatchObject({ id: sent.payload.id, channelId: voice.id, userId: a.id });
    await h.api(a, '/messages', body); expect(generate).toBe(1);
    release(); await expect.poll(() => speech[1].length).toBe(1); expect(speech.map(x => x.length)).toEqual([1,1,0,0]);
    cold = false;
    // Use another authorized sender rather than waiting out a per-user cooldown.
    await h.api(b, '/messages', { conversationId: chat.conversationId, content: 'warm speech', tts: true }); await expect.poll(() => generate).toBe(2); release();
    await expect.poll(() => speech[0].length).toBe(2); expect(loading.map(x => x.length)).toEqual([1,1,0,0]);
  } finally { await h.close(); }
});

it('drops a queued loading alert after the sender leaves, and has no loading alert outside voice', async () => {
  let announce!: () => Promise<void>, finish!: () => void, count = 0;
  const h = await harness({}, { ttsSynthesize: async (_text, loading) => { count++; announce = loading!; await new Promise<void>(resolve => { finish = resolve; }); return fixtureSpeech(); } });
  try {
    const a = await h.register('loading_leave'), server = (await h.api(a, '/servers', { name: 'Leave' })).json();
    const channels = (await h.api(a, '/bootstrap')).json().channels.filter((c: any) => c.serverId === server.id), chat = channels.find((c: any) => c.kind === 'text'), voice = channels.find((c: any) => c.kind === 'voice');
    const socket = await h.connect(a), alerts: any[] = [], speech: any[] = []; socket.on('voice:tts-loading', e => alerts.push(e)); socket.on('voice:tts', e => speech.push(e));
    await h.api(a, '/messages', { conversationId: chat.conversationId, content: 'outside voice', tts: true }); expect(count).toBe(0);
    await event(socket, 'voice:join', { channelId: voice.id, eligible: false });
    await h.api(a, '/messages', { conversationId: chat.conversationId, content: 'leave before startup', tts: true }); await expect.poll(() => count).toBe(1);
    await event(socket, 'voice:leave', { requestId: crypto.randomUUID() }); await announce(); finish();
    await new Promise(resolve => setTimeout(resolve, 50)); expect(alerts).toHaveLength(0); expect(speech).toHaveLength(0);
  } finally { await h.close(); }
});
