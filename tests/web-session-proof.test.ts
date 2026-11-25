import { afterEach, expect, it, vi } from 'vitest';

const socket = vi.hoisted(() => ({ io: vi.fn(() => ({})) }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false }, registerPlugin: () => ({}) }));
vi.mock('socket.io-client', () => ({ io: socket.io }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); socket.io.mockClear(); });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const identity = (csrf = 'old-proof', id = 'same-user') => reply({ csrf, user: { id } });
const denied = () => reply({ error: { code: 'CSRF', message: 'Refresh your session and retry.' } }, 403);
async function client(fetch: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), location: { origin: 'https://dorham.example' } });
  vi.stubGlobal('fetch', fetch);
  const api = await import('../apps/web/src/api');
  await api.request('/auth/me');
  return api;
}

it('recovers a same-account cookie/proof mismatch once and retains the mutation request ID', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(identity()).mockResolvedValueOnce(denied()).mockResolvedValueOnce(identity('new-proof')).mockResolvedValueOnce(reply({ ok: true }));
  const api = await client(fetch);
  await expect(api.request('/messages', { content: 'سلام hello' })).resolves.toEqual({ ok: true });
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(fetch.mock.calls[1][1].headers['X-CSRF-Token']).toBe('old-proof');
  expect(fetch.mock.calls[3][1].headers['X-CSRF-Token']).toBe('new-proof');
  expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual(JSON.parse(fetch.mock.calls[1][1].body));
  expect(window.dispatchEvent).not.toHaveBeenCalled();
});

it('never repeats a mutation as a different account from another browser tab', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(identity()).mockResolvedValueOnce(denied()).mockResolvedValueOnce(identity('other-proof', 'other-user'));
  const api = await client(fetch);
  await expect(api.request('/messages', { content: 'belongs to the first user' })).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'dorham-session-revoked' }));
});

it('does not loop when a refreshed proof is still rejected', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(identity()).mockResolvedValueOnce(denied()).mockResolvedValueOnce(identity('new-proof')).mockResolvedValueOnce(denied());
  const api = await client(fetch);
  await expect(api.request('/messages', { content: 'one retry only' })).rejects.toMatchObject({ code: 'CSRF' });
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('shares one proof read between simultaneous rejected requests', async () => {
  let reads = 0;
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith('/auth/me')) {
      reads++;
      if (reads === 1) return identity();
      await new Promise(resolve => setTimeout(resolve, 10));
      return identity('new-proof');
    }
    return (options.headers as Record<string, string>)['X-CSRF-Token'] === 'new-proof' ? reply({ ok: true }) : denied();
  });
  const api = await client(fetch);
  await Promise.all([api.request('/messages', { content: 'first' }), api.request('/messages', { content: 'second' })]);
  expect(reads).toBe(2);
  expect(fetch).toHaveBeenCalledTimes(6);
});

it('refreshes the same-account proof before a socket reconnect handshake', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(identity()).mockResolvedValueOnce(identity('socket-proof'));
  const api = await client(fetch);
  api.connectSocket();
  const auth = (socket.io.mock.calls[0] as unknown as [string, { auth: (cb: (data: unknown) => void) => void }])[1].auth;
  const callback = vi.fn(); auth(callback);
  await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ csrf: 'socket-proof' }));
});

it('honors cancellation during proof recovery without resending content', async () => {
  const controller = new AbortController();
  const fetch = vi.fn().mockResolvedValueOnce(identity()).mockResolvedValueOnce(denied()).mockImplementationOnce(async () => { controller.abort(); return identity('new-proof'); });
  const api = await client(fetch);
  await expect(api.request('/messages', { content: 'cancelled' }, 'POST', true, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('keeps the account for feature-level 401s and invalid gateway responses', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(identity())
    .mockResolvedValueOnce(reply({ error: { code: 'UNAUTHENTICATED' } }, 401))
    .mockResolvedValueOnce(new Response('<html>gateway</html>', { status: 401 }))
    .mockResolvedValueOnce(identity());
  const api = await client(fetch);
  await expect(api.request('/voice/test')).rejects.toMatchObject({ status: 401 });
  await expect(api.request('/auth/me')).rejects.toMatchObject({ status: 401 });
  await expect(api.request('/auth/me')).resolves.toMatchObject({ user: { id: 'same-user' } });
  expect(window.dispatchEvent).not.toHaveBeenCalled();
});

it('clears a browser session when the identity endpoint definitively rejects it', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(identity())
    .mockResolvedValueOnce(reply({ error: { code: 'UNAUTHENTICATED' } }, 401));
  const api = await client(fetch);
  await expect(api.request('/auth/me')).rejects.toMatchObject({ status: 401 });
  expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'dorham-session-revoked' }));
});

it('retains a Windows refresh rotation when the gateway fails and reuses it after reconnecting', async () => {
  let stored: string | null = 'refresh-token';
  const desktop = { getSecret: async () => stored, setSecret: vi.fn(async (value: string | null) => { stored = value; }) };
  vi.stubGlobal('window', { desktop, dispatchEvent: vi.fn(), location: { origin: 'https://dorham.example' } });
  const rejected = () => reply({ error: { code: 'UNAUTHENTICATED' } }, 401);
  const fetch = vi.fn().mockResolvedValueOnce(rejected()).mockResolvedValueOnce(new Response('Gateway authentication failed', { status: 403 }))
    .mockResolvedValueOnce(rejected()).mockResolvedValueOnce(reply({ refreshToken: 'next-token', accessToken: 'access', csrf: 'proof' }))
    .mockResolvedValueOnce(identity());
  vi.stubGlobal('fetch', fetch);
  const api = await import('../apps/web/src/api');
  // setServer accepts the release origin and clears any credential from the previous server.
  desktop.setSecret.mockClear();
  Object.assign(desktop, { setServer: vi.fn(async () => {}) });
  await api.setServer('https://dorham.example');
  stored = 'refresh-token';
  desktop.setSecret.mockClear();
  await expect(api.request('/auth/me')).rejects.toThrow('temporarily unavailable');
  expect(stored).toContain('refresh-token');
  await expect(api.request('/auth/me')).resolves.toMatchObject({ user: { id: 'same-user' } });
  expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[3][1].body);
  expect(stored).toBe('next-token');
  expect(window.dispatchEvent).not.toHaveBeenCalled();
});
