export type MessagePart = { text: string; url?: string; channel?: { serverId: string; channelId: string } };
export function channelLink(origin: string, serverId: string, channelId: string) {
  const url = new URL(origin); url.pathname = '/'; url.search = ''; url.hash = '';
  url.searchParams.set('server', serverId); url.searchParams.set('channel', channelId); return url.href;
}
export function channelTarget(value: string, appOrigin: string) {
  try {
    const url = new URL(value, appOrigin), base = new URL(appOrigin);
    if (url.origin !== base.origin || url.username || url.password || url.pathname !== '/') return undefined;
    const serverId = url.searchParams.get('server'), channelId = url.searchParams.get('channel');
    if (!serverId || !channelId || !/^[a-zA-Z0-9_-]{1,80}$/.test(serverId) || !/^[a-zA-Z0-9_-]{1,80}$/.test(channelId)) return undefined;
    return { serverId, channelId };
  } catch { return undefined; }
}
export function messageParts(content: string, appOrigin: string): MessagePart[] {
  const parts: MessagePart[] = []; let start = 0;
  for (const match of content.matchAll(/https?:\/\/[^\s<>"']+/giu)) {
    const index = match.index!, original = match[0]; let candidate = original.replace(/[.,!?;:]+$/u, '');
    while (candidate.endsWith(')') && (candidate.match(/\)/g)?.length || 0) > (candidate.match(/\(/g)?.length || 0)) candidate = candidate.slice(0, -1);
    if (index > start) parts.push({ text: content.slice(start, index) });
    try {
      const url = new URL(candidate), channel = channelTarget(candidate, appOrigin);
      const valid = !url.username && !url.password && Boolean(url.hostname) && (url.protocol === 'https:' || Boolean(channel));
      parts.push({ text: candidate, ...(valid ? { url: url.href, channel } : {}) });
    } catch { parts.push({ text: candidate }); }
    if (original.length > candidate.length) parts.push({ text: original.slice(candidate.length) });
    start = index + original.length;
  }
  if (start < content.length) parts.push({ text: content.slice(start) }); return parts;
}
