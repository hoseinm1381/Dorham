import { afterEach, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as contracts from '../packages/contracts/src/releases';
const { createUpdater } = createRequire(import.meta.url)('../apps/desktop/updater.cjs');
afterEach(() => vi.useRealTimers());
async function fixture(corrupt = false, inCall = false, extra: Record<string, any> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dorham-updater-'));
  const binary = Buffer.alloc(4096, 19), digest = createHash('sha256').update(binary).digest('hex');
  const file = { version: '1.0.1', url: contracts.RELEASE_ORIGIN + '/downloads/1.0.1/Dorham-1.0.1-Windows-x64.exe', appId: contracts.APP_ID, sha256: corrupt ? '0'.repeat(64) : digest, size: binary.length };
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith('windows.json') ? new Response(JSON.stringify({ schema: 1, version: file.version, windows: file })) : new Response(binary, { headers: { 'content-length': String(binary.length) } }));
  const spawn = vi.fn(() => { const child = new EventEmitter() as any; child.unref = vi.fn(); queueMicrotask(() => child.emit('spawn')); return child; });
  const app = { getVersion: () => '1.0.0', getPath: () => directory, quit: vi.fn() };
  const updater = createUpdater(app, { fetch }, { contracts, spawn, canInstall: () => !inCall, ...extra });
  return { directory, binary, file, fetch, app, spawn, updater, clean: async () => { updater.stop(); await rm(directory, { recursive: true, force: true }); } };
}
it('checks the installed version and launches only the verified downloaded installer', async () => {
  const f = await fixture(); try {
    expect(await f.updater.check()).toMatchObject({ current: '1.0.0', latest: '1.0.1', available: true });
    expect(await f.updater.install()).toEqual({ started: true }); expect(f.spawn).toHaveBeenCalledOnce();
    expect(await readFile(path.join(f.directory, 'updates', `installer-${f.file.version}-${f.file.sha256}.exe`))).toEqual(f.binary);
    expect(f.spawn).toHaveBeenCalledWith(expect.any(String), ['/S', '--updated', '--force-run'], expect.objectContaining({ windowsHide: true }));
  } finally { await f.clean(); }
});
it('rejects a changed payload without launching it and removes the incomplete download', async () => {
  const f = await fixture(true); try { await expect(f.updater.install()).rejects.toThrow('verification'); expect(f.spawn).not.toHaveBeenCalled(); expect(await readdir(path.join(f.directory, 'updates'))).toEqual([]); } finally { await f.clean(); }
});
it('does not close a voice call that began during the download', async () => {
  let inCall = false;
  const f = await fixture(false, false, { canInstall: () => !inCall, onState: (state: any) => { if (state.phase === 'ready') inCall = true; } });
  try { await expect(f.updater.install()).rejects.toThrow('Disconnect voice'); expect(f.spawn).not.toHaveBeenCalled(); } finally { await f.clean(); }
});

it('automatically stages a verified update, reports progress, and reuses it when restarting', async () => {
  const states: any[] = [], f = await fixture(false, false, { autoDownload: true, onState: (state: any) => states.push(state) });
  try {
    await f.updater.check(); await f.updater.prepare();
    expect(f.updater.state()).toMatchObject({ available: true, phase: 'ready', progress: 100 });
    expect(states.some(s => s.phase === 'downloading')).toBe(true); expect(f.spawn).not.toHaveBeenCalled();
    await f.updater.install();
    expect(f.fetch.mock.calls.filter(([url]) => !url.endsWith('windows.json'))).toHaveLength(1);
    await expect(f.updater.install()).rejects.toThrow('already installing'); expect(f.spawn).toHaveBeenCalledOnce();
  } finally { await f.clean(); }
});

it('coalesces concurrent checks and prevents installation during an existing call', async () => {
  const f = await fixture(false, true);
  try {
    await Promise.all([f.updater.check(), f.updater.check(), f.updater.check()]); expect(f.fetch).toHaveBeenCalledOnce();
    await expect(f.updater.install()).rejects.toThrow('Disconnect voice'); expect(f.fetch).toHaveBeenCalledOnce(); expect(f.spawn).not.toHaveBeenCalled();
  } finally { await f.clean(); }
});

it('does not automatically download during calls and starts when the call ends', async () => {
  let inCall = true;
  const f = await fixture(false, false, { autoDownload: true, canDownload: () => !inCall });
  try {
    await f.updater.check(); expect(f.fetch).toHaveBeenCalledOnce(); expect(f.updater.state().phase).toBe('available');
    inCall = false; f.updater.wake(); await f.updater.prepare(); expect(f.updater.state().phase).toBe('ready');
  } finally { await f.clean(); }
});

it('rehashes the cached installer after app restart and rejects later disk tampering', async () => {
  const f = await fixture();
  let second: any;
  try {
    await f.updater.check(); await f.updater.prepare();
    const installer = path.join(f.directory, 'updates', `installer-${f.file.version}-${f.file.sha256}.exe`);
    let tamper = false;
    second = createUpdater(f.app, { fetch: f.fetch }, { contracts, spawn: f.spawn, onState: (state: any) => {
      if (tamper && state.phase === 'ready') writeFileSync(installer, Buffer.alloc(f.binary.length, 42));
    } });
    await second.check(); await second.prepare(); expect(f.fetch.mock.calls.filter(([url]) => !url.endsWith('windows.json'))).toHaveLength(1);
    // Alter the file after prepare verifies it, before the separate launch-time check.
    tamper = true;
    await expect(second.install()).rejects.toThrow('verification'); expect(f.spawn).not.toHaveBeenCalled();
  } finally { second?.stop(); await f.clean(); }
});

it('pauses a background download for a call and resumes the saved bytes', async () => {
  let inCall = false;
  const f = await fixture(false, false, { autoDownload: true, canDownload: () => !inCall });
  try {
    await f.updater.check(); await f.updater.prepare();
    // Use a new app-owned cache so the next download has actual pending bytes.
    await rm(path.join(f.directory, 'updates', `installer-${f.file.version}-${f.file.sha256}.exe`));
    f.fetch.mockImplementationOnce(async (_url, init) => new Response(new ReadableStream({ start(stream) {
      stream.enqueue(f.binary.subarray(0, 1024));
      init?.signal?.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
    } }), { headers: { 'content-length': String(f.binary.length) } }));
    const task = f.updater.prepare();
    // Attach the rejection assertion before aborting, avoiding an unhandled promise.
    const aborted = expect(task).rejects.toThrow('Aborted');
    await vi.waitFor(() => expect(f.updater.state()).toMatchObject({ phase: 'downloading', progress: 25 }));
    inCall = true; f.updater.pauseDownload(); await aborted;
    expect(await readdir(path.join(f.directory, 'updates'))).toEqual([expect.stringMatching(/\.download$/)]); expect(f.updater.state().phase).toBe('available');
    f.fetch.mockImplementationOnce(async (_url, init) => {
      expect(new Headers(init?.headers).get('range')).toBe('bytes=1024-');
      return new Response(f.binary.subarray(1024), { status: 206, headers: { 'content-range': 'bytes 1024-4095/4096' } });
    });
    inCall = false; f.updater.wake(); await f.updater.prepare(); expect(f.updater.state().phase).toBe('ready'); expect(f.spawn).not.toHaveBeenCalled();
  } finally { await f.clean(); }
});

it('preserves a staged update across an offline check, without executing anything', async () => {
  const f = await fixture();
  try {
    await f.updater.check(); await f.updater.prepare();
    f.fetch.mockRejectedValueOnce(Error('offline'));
    await expect(f.updater.check()).rejects.toThrow('offline');
    expect(f.updater.state()).toMatchObject({ available: true, phase: 'ready', progress: 100 }); expect(f.spawn).not.toHaveBeenCalled();
  } finally { await f.clean(); }
});

it('does not download the current or an older release, even with automatic updates enabled', async () => {
  const f = await fixture(false, false, { autoDownload: true });
  try {
    f.app.getVersion = () => '1.0.2';
    await f.updater.check();
    expect(f.updater.state()).toMatchObject({ available: false, phase: 'idle' }); expect(f.fetch).toHaveBeenCalledOnce();
    await expect(f.updater.install()).rejects.toThrow('up to date'); expect(f.spawn).not.toHaveBeenCalled();
  } finally { await f.clean(); }
});

it('does not quit if Windows cannot launch the installer and allows a cached retry', async () => {
  const f = await fixture();
  try {
    f.spawn.mockImplementationOnce(() => { const child = new EventEmitter() as any; child.unref = vi.fn(); queueMicrotask(() => child.emit('error', Error('launch failed'))); return child; });
    await expect(f.updater.install()).rejects.toThrow('launch failed'); expect(f.app.quit).not.toHaveBeenCalled();
    expect(f.updater.state().phase).toBe('ready');
    await expect(f.updater.install()).resolves.toEqual({ started: true }); expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(f.fetch.mock.calls.filter(([url]) => !url.endsWith('windows.json'))).toHaveLength(1);
  } finally { await f.clean(); }
});

it('automatically resumes an interrupted payload and blocks oversized manifests', async () => {
  const f = await fixture();
  try {
    f.fetch.mockImplementationOnce(async () => new Response('x'.repeat(16385)));
    await expect(f.updater.check()).rejects.toThrow('Invalid update response'); expect(f.spawn).not.toHaveBeenCalled();
    await f.updater.check();
    f.fetch.mockImplementationOnce(async () => new Response(f.binary.subarray(0, 1000), { headers: { 'content-length': String(f.binary.length) } }));
    f.fetch.mockImplementationOnce(async (_url, init) => {
      expect(new Headers(init?.headers).get('range')).toBe('bytes=1000-');
      return new Response(f.binary.subarray(1000), { status: 206, headers: { 'content-range': 'bytes 1000-4095/4096' } });
    });
    await f.updater.prepare(); expect(f.updater.state().phase).toBe('ready');
    expect(f.fetch).toHaveBeenCalledTimes(4);
    expect(f.spawn).not.toHaveBeenCalled();
  } finally { await f.clean(); }
});

it('checks at startup/hourly, throttles focus wakeups and stops its timers', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  try {
    f.updater.start(); f.updater.start(); await vi.advanceTimersByTimeAsync(9999); expect(f.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(f.fetch).toHaveBeenCalledOnce();
    f.updater.wake(); await vi.advanceTimersByTimeAsync(1); expect(f.fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3600000); expect(f.fetch).toHaveBeenCalledTimes(2);
    f.updater.stop(); await vi.advanceTimersByTimeAsync(3600000); expect(f.fetch).toHaveBeenCalledTimes(2);
  } finally { await f.clean(); }
});
