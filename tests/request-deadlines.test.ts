import { it, expect, vi, afterEach } from 'vitest';
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false }, registerPlugin: () => ({}) }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function client() { vi.stubGlobal('window', { dispatchEvent: vi.fn() }); return import('../apps/web/src/api'); }
it('read/mutation/auth deadlines are distinct and never automatically resend timed-out content', async () => {
  const { request } = await client(), deadlines: number[] = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { deadlines.push(ms); return timeout(5); });
  const fetch = vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))); vi.stubGlobal('fetch', fetch);
  await expect(request('/bootstrap')).rejects.toMatchObject({ code: 'TIMEOUT' });
  await expect(request('/messages', { content: 'Do not resend', requestId: 'fixed-id' })).rejects.toMatchObject({ code: 'TIMEOUT' });
  await expect(request('/auth/login', {})).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(deadlines).toEqual([15000, 20000, 30000]); expect(fetch).toHaveBeenCalledTimes(3);
  expect(JSON.parse(fetch.mock.calls[1][1].body).requestId).toBe('fixed-id');
});
it('explicit cancellation ends an in-flight request without an automatic retry', async () => {
  const { request } = await client(), controller = new AbortController();
  const fetch = vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))); vi.stubGlobal('fetch', fetch);
  const result = request('/bootstrap', undefined, 'GET', true, { signal: controller.signal }); controller.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' }); expect(fetch).toHaveBeenCalledTimes(1);
});
