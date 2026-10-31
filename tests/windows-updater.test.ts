import { it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as contracts from '../packages/contracts/src/releases';
const { createUpdater } = createRequire(import.meta.url)('../apps/desktop/updater.cjs');
async function fixture(corrupt = false, inCall = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dorham-updater-'));
  const binary = Buffer.alloc(4096, 19), digest = createHash('sha256').update(binary).digest('hex');
  const file = { version: '1.0.1', url: contracts.RELEASE_ORIGIN + '/downloads/1.0.1/Dorham-1.0.1-Windows-x64.exe', appId: contracts.APP_ID, sha256: corrupt ? '0'.repeat(64) : digest, size: binary.length };
  const fetch = vi.fn(async (url: string) => url.endsWith('latest.json') ? new Response(JSON.stringify({ schema: 1, version: file.version, windows: file })) : new Response(binary, { headers: { 'content-length': String(binary.length) } }));
  const spawn = vi.fn(() => { const child = new EventEmitter() as any; child.unref = vi.fn(); queueMicrotask(() => child.emit('spawn')); return child; });
  const app = { getVersion: () => '1.0.0', getPath: () => directory, quit: vi.fn() };
  const updater = createUpdater(app, { fetch }, { contracts, spawn, canInstall: () => !inCall });
  return { directory, binary, spawn, updater, clean: () => rm(directory, { recursive: true, force: true }) };
}
it('checks the installed version and launches only the verified downloaded installer', async () => {
  const f = await fixture(); try {
    expect(await f.updater.check()).toMatchObject({ current: '1.0.0', latest: '1.0.1', available: true });
    expect(await f.updater.install()).toEqual({ started: true }); expect(f.spawn).toHaveBeenCalledOnce();
    expect(await readFile(path.join(f.directory, 'updates/installer.exe'))).toEqual(f.binary);
  } finally { await f.clean(); }
});
it('rejects a changed payload without launching it and removes the incomplete download', async () => {
  const f = await fixture(true); try { await expect(f.updater.install()).rejects.toThrow('verification'); expect(f.spawn).not.toHaveBeenCalled(); expect(await readdir(path.join(f.directory, 'updates'))).toEqual([]); } finally { await f.clean(); }
});
it('does not close a voice call that began during the download', async () => {
  const f = await fixture(false, true); try { await expect(f.updater.install()).rejects.toThrow('Disconnect voice'); expect(f.spawn).not.toHaveBeenCalled(); } finally { await f.clean(); }
});
