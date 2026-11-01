import { afterEach, expect, it, vi } from 'vitest';
import type { Service } from '../apps/api/src/service';
import type { Message } from '@dorham/contracts';
import { VoiceSpeech } from '../apps/api/src/tts';
import { fixtureSpeech } from './tts-fixture';

afterEach(() => vi.useRealTimers());
function fixture(engine: (text: string) => Promise<Buffer>) {
  const one = vi.fn(async (sql: string) => sql.includes('FROM messages') ? { content: 'hello', deleted: 0 } : { channel_id: 'voice', epoch: 'epoch', server_muted: 0 });
  const db = { one, all: async () => [{ user_id: 'listener', epoch: 'epoch', socket_id: 'socket' }], transaction: async (work: any) => work({}) };
  const service = { c: { ttsIdleSeconds: 180, ttsAudioCacheMiB: 1 }, db, channel: async () => ({}) } as unknown as Service;
  const deliver = vi.fn(), speech = new VoiceSpeech(service, deliver, vi.fn(), engine);
  const message = () => ({ id: crypto.randomUUID(), content: 'hello', createdAt: Date.now() }) as Message;
  return { speech, deliver, one, message };
}
it('bounds audio by bytes and expires it during quiet maintenance without another request', async () => {
  vi.useFakeTimers();
  const audio = Buffer.alloc(600044); fixtureSpeech().copy(audio, 0, 0, 44); audio.writeUInt32LE(audio.length - 8, 4); audio.writeUInt32LE(audio.length - 44, 40);
  const h = fixture(async () => audio), first = h.message(), second = h.message();
  try {
    await h.speech.enqueue('sender-a', first); await vi.waitFor(() => expect(h.deliver).toHaveBeenCalledTimes(1));
    await h.speech.enqueue('sender-b', second); await vi.waitFor(() => expect(h.deliver).toHaveBeenCalledTimes(2));
    expect(h.speech.metrics()).toMatchObject({ cachedClips: 1, cachedAudioBytes: audio.length, audioBudgetBytes: 1048576 });
    expect(await h.speech.read('listener', first.id)).toBeNull(); expect(await h.speech.read('listener', second.id)).toEqual(audio);
    await vi.advanceTimersByTimeAsync(120000); h.speech.cleanup();
    expect(h.speech.metrics()).toMatchObject({ cachedClips: 0, cachedAudioBytes: 0, dedupEntries: 0, cooldownEntries: 0 });
    expect(await h.speech.read('listener', second.id)).toBeNull();
  } finally { await h.speech.close(); }
});
it('does not access a closed database or cache late synthesis after shutdown', async () => {
  let finish!: (audio: Buffer) => void;
  const h = fixture(async () => new Promise(resolve => { finish = resolve; }));
  await h.speech.enqueue('sender', h.message()); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await h.speech.close(); const calls = h.one.mock.calls.length;
  finish(fixtureSpeech()); await vi.waitFor(() => expect(h.speech.metrics().queued).toBe(0));
  expect(h.one).toHaveBeenCalledTimes(calls); expect(h.deliver).not.toHaveBeenCalled(); expect(h.speech.metrics().cachedAudioBytes).toBe(0);
});
