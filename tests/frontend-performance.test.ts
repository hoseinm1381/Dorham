import { describe, expect, it, vi } from 'vitest';
import { KeyedStore } from '../apps/web/src/keyed-store';
import { DraftStore } from '../apps/web/src/drafts';
import { historyIndex, historyOffsets } from '../apps/web/src/history-layout';
import { emojiParts, isSingleEmoji } from '../apps/web/src/emojis';

describe('independent frontend updates', () => {
  it('notifies the changed participant and clears departing participants without waking unrelated rows', () => {
    const store = new KeyedStore<boolean>(), first = vi.fn(), second = vi.fn(), all = vi.fn();
    const stop = store.subscribe('first', first); store.subscribe('second', second); store.subscribeAll(all);
    store.set('first', true); store.set('first', true);
    expect(first).toHaveBeenCalledTimes(1); expect(second).not.toHaveBeenCalled(); expect(all).toHaveBeenCalledTimes(1);
    store.replace({}); expect(first).toHaveBeenCalledTimes(2); expect(store.get('first')).toBeUndefined();
    stop(); store.set('first', true); expect(first).toHaveBeenCalledTimes(2);
  });
  it('updates an outbox in its original conversation and clears only the signed-out account', () => {
    const store = new DraftStore(), one = store.key('account', 'origin', 'one'), two = store.key('account', 'origin', 'two'), other = store.key('other', 'origin', 'one');
    const watchOne = vi.fn(), watchTwo = vi.fn(); store.subscribe(one, watchOne); store.subscribe(two, watchTwo);
    expect(store.get(one)).toBe(store.get(one));
    store.set(one, { ...store.get(one), text: 'before sending' });
    store.set(two, { ...store.get(two), text: 'new conversation draft' });
    store.set(one, { ...store.get(one), text: '' });
    expect(store.get(two).text).toBe('new conversation draft'); expect(watchOne).toHaveBeenCalledTimes(2); expect(watchTwo).toHaveBeenCalledTimes(1);
    store.set(other, { ...store.get(other), text: 'another account' });
    store.clear('account', 'origin'); expect(store.get(two).text).toBe(''); expect(store.get(other).text).toBe('another account');
  });
});
it('locates variable-height history rows at boundaries, after prepending and outside the range', () => {
  const heights = new Map([['first', 40], ['second', 250], ['older', 70]]);
  const positions = historyOffsets(['first', 'second', 'unknown'], heights);
  expect(positions).toEqual([0, 40, 290, 390]);
  expect([-10, 0, 39, 40, 289, 290, 999].map(p => historyIndex(positions, p))).toEqual([0, 0, 0, 1, 1, 2, 2]);
  const prepended = historyOffsets(['older', 'first', 'second', 'unknown'], heights);
  expect(historyIndex(prepended, 40 + 70)).toBe(2); expect(historyIndex([0], 0)).toBe(0);
});
it('preserves Unicode and custom-emoji classification when grapheme iteration stops early', () => {
  const old = (content: string) => { const text = content.trim(), parts = emojiParts(text); return parts.length === 1 && !!parts[0].emoji || [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length === 1 && /[\p{Extended_Pictographic}\p{Emoji_Presentation}]|\u20e3/u.test(text); };
  for (const text of ['', 'hello', 'سلام', '🙂', '👨‍👩‍👧‍👦', '👍🏽', '1️⃣', '🇮🇷', '©️', ':dorham-hangout:', 'a'.repeat(4000), 'سلام '.repeat(799), 'x'.repeat(3900) + '🙂', '\u0301', '\n🙂\n']) expect(isSingleEmoji(text)).toBe(old(text));
});
