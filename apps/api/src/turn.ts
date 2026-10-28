import { z } from 'zod';
import { fail } from './security';

// Cloudflare requires server-generated credentials. Never send the API token to clients.
export const cloudflareTurnTtl = 86400;
const iceResponse = z.object({ iceServers: z.array(z.object({
  urls: z.union([z.string(), z.array(z.string()).min(1).max(12)]),
  username: z.string().min(1).max(2048).optional(), credential: z.string().min(1).max(2048).optional()
})).min(1).max(8) });
type Entry = { until: number; request: Promise<RTCIceServer[]> };
export class CloudflareTurn {
  private cache = new Map<string, Entry>();
  constructor(private keyId: string, private apiToken: string, private fetcher: typeof fetch = fetch, private now = Date.now) {}
  async forUser(userId: string): Promise<RTCIceServer[]> {
    const now = this.now(), previous = this.cache.get(userId);
    if (previous && previous.until > now) return structuredClone(await previous.request);
    for (const [id, entry] of this.cache) if (entry.until <= now) this.cache.delete(id);
    if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
    const entry: Entry = { until: now + 60000, request: this.generate() };
    this.cache.set(userId, entry);
    return structuredClone(await entry.request);
  }
  private async generate(): Promise<RTCIceServer[]> {
    try {
      const response = await this.fetcher(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(this.keyId)}/credentials/generate-ice-servers`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: cloudflareTurnTtl }), signal: AbortSignal.timeout(5000), redirect: 'error'
      });
      if (!response.ok || !response.body) throw new Error('TURN response failed');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 65536) throw new Error('TURN response exceeded budget'); chunks.push(value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const parsed = iceResponse.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const servers: RTCIceServer[] = [];
      for (const server of parsed.iceServers) {
        const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(url => /^(stun|turn|turns):(?:stun|turn)\.cloudflare\.com:(3478|443|80|5349)(\?transport=(udp|tcp))?$/.test(url));
        if (!urls.length) continue;
        if (urls.some(url => /^turns?:/.test(url)) && (!server.username || !server.credential)) throw new Error('TURN credentials missing');
        servers.push({ urls, ...(server.username ? { username: server.username } : {}), ...(server.credential ? { credential: server.credential } : {}) });
      }
      if (!servers.some(server => (server.urls as string[]).some(url => /^turns?:/.test(url)))) throw new Error('TURN relay missing');
      return servers;
    } catch {
      // Provider responses and request errors can include credentials. Return only safe text.
      return fail(503, 'TURN_UNAVAILABLE', 'The media relay is unavailable. Please retry shortly or contact the server owner.');
    }
  }
}
