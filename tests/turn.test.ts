import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareTurn, cloudflareTurnTtl } from '../apps/api/src/turn';
import { config } from '../apps/api/src/config';
import { harness, event } from './helpers';

const payload = { iceServers: [
  { urls: ['stun:stun.cloudflare.com:3478'] },
  { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp', 'turn:turn.cloudflare.com:53'], username: 'temporary-user', credential: 'temporary-password', apiToken: 'must-not-reach-client' }
] };
afterEach(() => { vi.unstubAllGlobals(); });
describe('Cloudflare TURN credentials', () => {
  it('keeps the API token server-side, coalesces user retries and supports UDP/TLS relays', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload, { status: 201 }));
    let now = 0; const provider = new CloudflareTurn('key-id', 'private-api-token', fetcher, () => now);
    const [a, b] = await Promise.all([provider.forUser('alice'), provider.forUser('alice')]);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(a).toEqual(b);
    expect(fetcher.mock.calls[0][0]).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers');
    const options = fetcher.mock.calls[0][1]!;
    expect(options.headers).toEqual({ Authorization: 'Bearer private-api-token', 'Content-Type': 'application/json' });
    expect(JSON.parse(String(options.body))).toEqual({ ttl: cloudflareTurnTtl }); expect(options.redirect).toBe('error');
    expect(JSON.stringify(a)).not.toMatch(/private-api-token|must-not-reach-client|:53/);
    expect(JSON.stringify(a)).toContain('turns:turn.cloudflare.com:443?transport=tcp');
    a[1].username = 'changed'; expect((await provider.forUser('alice'))[1].username).toBe('temporary-user');
    await provider.forUser('bob'); expect(fetcher).toHaveBeenCalledTimes(2);
    now = 60001; await provider.forUser('alice'); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('returns a safe unavailable error and throttles retries after provider failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private-api-token in provider failure'));
    const provider = new CloudflareTurn('key-id', 'private-api-token', fetcher);
    for (let i = 0; i < 2; i++) await expect(provider.forUser('alice')).rejects.toMatchObject({ status: 503, code: 'TURN_UNAVAILABLE', message: 'The media relay is unavailable. Please retry shortly or contact the server owner.' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed, oversized, redirect and STUN-only responses', async () => {
    for (const response of [Response.json({ iceServers: [{ urls: ['turn:untrusted.example:3478'], username: 'x', credential: 'y' }] }), Response.json({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] }), new Response('x'.repeat(65537)), new Response('', { status: 302 })]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(new CloudflareTurn('key-id', 'private-api-token', fetcher).forUser('alice')).rejects.toMatchObject({ code: 'TURN_UNAVAILABLE' });
    }
  });
  it('requires a complete configuration with only one relay provider', () => {
    expect(() => config({ cloudflareTurnKeyId: 'key', cloudflareTurnApiToken: '' })).toThrow('Both Cloudflare');
    expect(() => config({ cloudflareTurnKeyId: '../key', cloudflareTurnApiToken: 'token' })).toThrow('valid Cloudflare');
    expect(() => config({ cloudflareTurnKeyId: 'key', cloudflareTurnApiToken: 'token', turnUrls: ['turn:another.example:3478'] })).toThrow('one TURN provider');
  });
  it('authorizes before issuing credentials and creates no ghost voice membership on failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'private-provider-detail' }, { status: 503 })); vi.stubGlobal('fetch', fetcher);
    const h = await harness({ cloudflareTurnKeyId: 'key', cloudflareTurnApiToken: 'private-api-token' });
    try {
      const owner = await h.register('owner'), outsider = await h.register('outsider'); await h.api(owner, '/servers', { name: 'TURN checks' });
      const snapshot = (await h.api(owner, '/bootstrap')).json(); expect(JSON.stringify(snapshot)).not.toContain('private-api-token');
      const channel = snapshot.channels.find((c: any) => c.kind === 'voice'), unauthorized = await h.connect(outsider), speaker = await h.connect(owner);
      await expect(event(unauthorized, 'voice:join', { channelId: channel.id, eligible: true })).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
      await expect(event(speaker, 'voice:join', { channelId: channel.id, eligible: true })).rejects.toThrow('TURN_UNAVAILABLE'); expect(fetcher).toHaveBeenCalledTimes(1);
      expect((await h.db.one('SELECT COUNT(*) AS count FROM voice_members'))!.count).toBe(0);
      expect((await h.app.inject('/ready')).statusCode).toBe(200);
    } finally { await h.close(); }
  });
});
