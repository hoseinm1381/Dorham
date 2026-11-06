import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { catalogEmojiShortcodes, emojiParts, insertEmoji, searchEmojis, isSingleEmoji } from '../apps/web/src/emojis';
import { MessageContent } from '../apps/web/src/MessageContent';

describe('bundled message emojis', () => {
  it('round-trips mixed Persian, Unicode and unknown shortcodes without consuming unknown text', () => {
    const text = 'سلام 🙂 :emoji-unknown: :dorham-tea-time: <script>alert(1)</script> :emoji-happy:';
    const parts = emojiParts(text);
    expect(parts.map(p => p.text).join('')).toBe(text);
    expect(parts.filter(p => p.emoji).map(p => p.emoji!.id)).toEqual(['dorham-tea-time', 'emoji-happy']);
  });
  it('keeps links intact and escapes message markup while rendering only registered images', () => {
    const html = renderToStaticMarkup(createElement(MessageContent, { content: 'https://example.com/:emoji-happy: :dorham-tea-time: <img src=x onerror=alert(1)>', origin: 'https://dorhamapp.ir', navigate: () => {} }));
    expect(html).toContain('href="https://example.com/:emoji-happy"');
    expect(html.match(/class="custom-emoji"/g)).toHaveLength(1);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('dorham-tea-time.svg');
  });
  it('replaces the selected text at the caret, respects the message limit and rejects unknown assets', () => {
    expect(insertEmoji('hello world!', 'dorham-tea-time', 6, 11)).toEqual({ text: 'hello :dorham-tea-time:!', cursor: 23 });
    expect(insertEmoji('x'.repeat(4000), 'emoji-happy', 4000, 4000)).toBeNull();
    expect(insertEmoji('x'.repeat(4000), 'emoji-happy', 0, 100)?.text.length).toBeLessThan(4000);
    expect(insertEmoji('hello', '../../outside', 0, 0)).toBeNull();
  });
  it('searches tags and localized labels while retaining the selected category', () => {
    expect(searchEmojis('chai', 'all').map(e => e.id)).toEqual(['dorham-tea-time']);
    expect(searchEmojis('چای', 'dorham-exclusive', label => label === 'Tea Time' ? 'وقت چای' : label).map(e => e.id)).toEqual(['dorham-tea-time']);
    expect(searchEmojis('chai', 'gaming')).toEqual([]);
  });
});

it('round-trips readable catalog codes with adjacent emoji, duplicate names, and existing wire IDs', () => {
  const first = '67ff27f7-03f2-50ce-9f52-737c1e1ba38e', second = '12fefd0c-39cf-5026-bb14-0dcc7ae95dc3';
  const codes = catalogEmojiShortcodes([
    { id: first, label: 'Sheep Scout', kind: 'emoji' },
    { id: second, label: 'Sheep Scout', kind: 'emoji' },
    { id: 'ignored', label: 'Sheep Scout', kind: 'sound' },
  ]);
  const stored = `hi :dx-${first}::dx-${second}::emoji-happy: :unknown:`;
  const display = 'hi :sheep-scout::sheep-scout-2::emoji-happy: :unknown:';
  expect(codes.display(stored)).toBe(display);
  expect(codes.encode(display)).toBe(stored);
  expect(codes.encode(stored)).toBe(stored);
  expect(insertEmoji('say hello!', 'dx-' + first, 4, 9, codes.code('dx-' + first))).toEqual({ text: 'say :sheep-scout:!', cursor: 17 });
});

it('enlarges exactly one bundled or Unicode grapheme and leaves mixed messages normal', () => {
  for (const text of [':dorham-tea-time:', ' :emoji-happy: ', '🙂', '👨‍👩‍👧‍👦', '👍🏽', '🇮🇷', '1️⃣']) expect(isSingleEmoji(text), text).toBe(true);
  for (const text of ['', '1', 'hi 🙂', 'سلام :emoji-happy:', '🙂🙂', ':emoji-happy::emoji-heart:', ':unknown:', 'https://example.com/:emoji-happy:']) expect(isSingleEmoji(text), text).toBe(false);
});
