import catalog from './emoji-catalog.json';
import { reactionEmojiId } from '../../../packages/contracts/src/emoji-reactions';
export const emojis = catalog;
export type Emoji = typeof emojis[number];
export const emojiCategories = [
  ['all', 'All emojis'], ['expressions', 'Expressions'], ['reactions', 'Reactions'],
  ['gaming', 'Gaming'], ['dorham-exclusive', 'Only Dorham'],
] as const;
const byId = new Map(emojis.map(e => [e.id, e]));
export const findEmoji = (value: string) => byId.get(reactionEmojiId(value) || value);
export const catalogEmojiToken = /^:dx-([a-f0-9-]{36}):$/;
export const emojiCode = (id: string) => `:${id}:`;
export function catalogEmojiShortcodes(items: readonly { id: string; label: string; kind: string }[]) {
  const aliases = new Map<string, string>(), ids = new Map<string, string>();
  for (const item of items) {
    if (item.kind !== 'emoji' && item.kind !== 'sticker') continue;
    const slug = item.label.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 48) || 'custom-emoji';
    const base = slug.startsWith('dx-') ? 'custom-' + slug : slug;
    let alias = base, index = 2;
    while (aliases.has(alias) || byId.has(alias)) alias = `${base}-${index++}`;
    const id = 'dx-' + item.id;
    ids.set(id, alias);
    aliases.set(alias, id);
  }
  return {
    code: (id: string) => emojiCode(ids.get(id) ?? id),
    display: (text: string) => text.replace(/:((?:dx-)[a-f0-9-]{36}):/g, (token, id: string) => ids.has(id) ? emojiCode(ids.get(id)!) : token),
    encode: (text: string) => text.replace(/:([\p{L}\p{N}-]{1,60}):/gu, (token, alias: string) => aliases.has(alias) ? emojiCode(aliases.get(alias)!) : token),
  };
}
export function emojiParts(text: string, find: (id: string) => Emoji | undefined = id => byId.get(id)): { text: string; emoji?: Emoji }[] {
  const parts: { text: string; emoji?: Emoji }[] = []; let start = 0;
  for (const match of text.matchAll(/:((?:emoji|dorham|dx)-[a-z0-9-]{1,60}):/g)) {
    const emoji = find(match[1]); if (!emoji) continue;
    if (match.index! > start) parts.push({ text: text.slice(start, match.index) });
    parts.push({ text: match[0], emoji }); start = match.index! + match[0].length;
  }
  if (start < text.length) parts.push({ text: text.slice(start) });
  return parts;
}
const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[يى]/g, 'ی').replace(/ك/g, 'ک');
export function searchEmojis(query: string, category: string, label: (text: string) => string = text => text) {
  const words = normalized(query).trim().split(/\s+/).filter(Boolean);
  return emojis.filter(e => (category === 'all' || e.category === category) && words.every(word => normalized([e.id, e.label, label(e.label), ...e.tags].join(' ')).includes(word)));
}
export function insertEmoji(text: string, id: string, start: number, end: number, code = emojiCode(id)) {
  if (!byId.has(id) && !catalogEmojiToken.test(emojiCode(id))) return null;
  start = Math.max(0, Math.min(start, text.length)); end = Math.max(start, Math.min(end, text.length));
  const next = text.slice(0, start) + code + text.slice(end);
  return next.length <= 4000 ? { text: next, cursor: start + code.length } : null;
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const pictograph = /[\p{Extended_Pictographic}\p{Emoji_Presentation}]|\u20e3/u;
export function isSingleEmoji(content: string) {
  const text = content.trim(), parts = emojiParts(text);
  if (parts.length === 1 && parts[0].emoji) return true;
  if (!pictograph.test(text)) return false;
  const iterator = segmenter.segment(text)[Symbol.iterator]();
  return !iterator.next().done && iterator.next().done === true;
}
