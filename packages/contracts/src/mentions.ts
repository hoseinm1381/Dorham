export type Mention = { userId: string; username: string; displayName: string };
export type MentionToken = { start: number; end: number; username: string };

// Tags use ASCII usernames; recipients are bound when the message is written.
// Do not turn emails, URLs or code into pings.
function protectedRanges(text: string) {
  return [...text.matchAll(/https?:\/\/[^\s<>]+|`[^`]*(?:`|$)/g)].map(m => [m.index, m.index + m[0].length]);
}
export function mentionTokens(text: string): MentionToken[] {
  const protectedText = protectedRanges(text), tokens: MentionToken[] = [];
  for (const m of text.matchAll(/(^|[^\p{L}\p{N}_/@\\])@([a-zA-Z0-9_]{3,32})(?![\p{L}\p{N}_])/gu)) {
    const start = m.index + m[1].length, end = start + m[2].length + 1;
    if (!protectedText.some(([a, b]) => start >= a && start < b)) tokens.push({ start, end, username: m[2] });
  }
  return tokens;
}
export function mentionQuery(text: string, caret: number) {
  if (caret <= 0) return null;
  const start = text.lastIndexOf('@', caret - 1);
  if (start < 0 || (start > 0 && /[\p{L}\p{N}_/@\\]/u.test(text[start - 1])) || protectedRanges(text).some(([a, b]) => start >= a && start < b)) return null;
  const query = text.slice(start + 1, caret);
  if (!/^[\p{L}\p{N}_\u200c-]{0,48}$/u.test(query)) return null;
  let end = caret;
  while (end < text.length && /[\p{L}\p{N}_\u200c-]/u.test(text[end])) end++;
  return { start, end, query };
}
