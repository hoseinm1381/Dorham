import { afterEach, expect, it, vi } from 'vitest';
import { acceptTtsProgress, clearTtsProgress, ttsProgressStore } from '../apps/web/src/TtsProgress';
import type { VoiceTtsProgress } from '../packages/contracts/src/tts';
const event = (id: string, percent = 20): VoiceTtsProgress => ({ id, messageId: id, channelId: 'voice', userId: 'speaker', percent, phase: 'synthesizing', expiresAt: Date.now() + 60000 });
afterEach(() => clearTtsProgress());
it('updates only the matching message, keeps progress monotonic and removes it on completion', () => {
  const one = vi.fn(), other = vi.fn(); const a = ttsProgressStore.subscribe('one', one), b = ttsProgressStore.subscribe('other', other);
  try {
    acceptTtsProgress(event('one', 35)); acceptTtsProgress(event('one', 5));
    expect(ttsProgressStore.get('one')?.percent).toBe(35); expect(one).toHaveBeenCalledOnce(); expect(other).not.toHaveBeenCalled();
    acceptTtsProgress({ ...event('one', 100), phase: 'finished' }); expect(ttsProgressStore.get('one')).toBeUndefined(); expect(one).toHaveBeenCalledTimes(2);
  } finally { a(); b(); }
});
it('bounds pending speech indicators and ignores malformed, expired and out-of-range updates', () => {
  for (const percent of [-1, 101, NaN, 1.5]) acceptTtsProgress(event('invalid', percent));
  acceptTtsProgress({ ...event('expired'), expiresAt: Date.now() - 1 }); expect(ttsProgressStore.snapshot()).toEqual({});
  for (let i=0; i<30; i++) acceptTtsProgress(event(String(i)));
  expect(Object.keys(ttsProgressStore.snapshot())).toHaveLength(16);
  clearTtsProgress(); expect(ttsProgressStore.snapshot()).toEqual({});
});
