import catalog from './emoji-catalog.json';
export const emojis = catalog;
export type Emoji = typeof emojis[number];
export const emojiCategories = [
  ['all', 'All emojis'], ['expressions', 'Expressions'], ['reactions', 'Reactions'],
  ['gaming', 'Gaming'], ['dorham-exclusive', 'Only Dorham'],
] as const;
const byId = new Map(emojis.map(e => [e.id, e]));
const reactions: Record<string, string> = { '👍': 'emoji-thumbs-up', '❤️': 'emoji-heart', '😂': 'emoji-laughing', '🎉': 'emoji-party', '✅': 'emoji-checkmark' };
export const findEmoji = (value: string) => byId.get(reactions[value] || value);
export const emojiCode = (id: string) => `:${id}:`;
export function emojiParts(text: string): { text: string; emoji?: Emoji }[] {
  const parts: { text: string; emoji?: Emoji }[] = []; let start = 0;
  for (const match of text.matchAll(/:((?:emoji|dorham)-[a-z0-9-]{1,60}):/g)) {
    const emoji = byId.get(match[1]); if (!emoji) continue;
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
export function insertEmoji(text: string, id: string, start: number, end: number) {
  if (!byId.has(id)) return null;
  start = Math.max(0, Math.min(start, text.length)); end = Math.max(start, Math.min(end, text.length));
  const code = emojiCode(id), next = text.slice(0, start) + code + text.slice(end);
  return next.length <= 4000 ? { text: next, cursor: start + code.length } : null;
}
