import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
const require = createRequire(import.meta.url);

async function fixture(build = '10.0.26100') {
  const handlers = new Map<string, any>(), listeners = new Map<string, any>(), windows: any[] = [], children: any[] = [];
  class Window extends EventEmitter {
    audioRequested = false; destroyed = false;
    webContents = { mainFrame: { url: '' }, isDestroyed: () => false, send: vi.fn(), setWindowOpenHandler() {}, on() {} };
    constructor(_options?: any) { super(); windows.push(this); }
    isDestroyed() { return this.destroyed; }
    getNativeWindowHandle() { const handle = Buffer.alloc(8); handle.writeBigUInt64LE(BigInt(windows.indexOf(this) + 1)); return handle; }
    loadURL(url: string) { this.webContents.mainFrame.url = url; return Promise.resolve(); }
    show() {}
    destroy() { this.destroyed = true; this.emit('closed'); }
    static getAllWindows() { return windows; }
  }
  const main = new Window(); main.webContents.mainFrame.url = 'dorham://app/index.html';
  const image = { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,aA==', resize() { return image; } };
  let sources = [{ id: 'window:555:0', name: 'Owned game', thumbnail: image }, { id: 'screen:0:0', name: 'Screen 1', thumbnail: image }, { id: 'window:1:0', name: 'Dorham itself', thumbnail: image }];
  const getSources = vi.fn(async () => sources);
  const spawn = vi.fn((_file: string, _arguments: string[], _options: unknown) => {
    const child: any = new EventEmitter(); child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() }); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = vi.fn(); children.push(child); return child;
  });
  const modules: Record<string, any> = {
    electron: { BrowserWindow: Window, ipcMain: { handle: (key: string, fn: any) => handlers.set(key, fn), on: (key: string, fn: any) => listeners.set(key, fn) }, desktopCapturer: { getSources } },
    'node:child_process': { spawn }, 'node:crypto': { randomUUID: () => 'owned-audio-id' }, 'node:fs': { existsSync: () => true }, 'node:os': { release: () => build }, 'node:path': path, 'node:url': { pathToFileURL }, './capture-origin.cjs': require('../apps/desktop/capture-origin.cjs')
  };
  const module = { exports: {} as any };
  vm.runInNewContext(await readFile('apps/desktop/screen-capture.cjs', 'utf8'), { require: (id: string) => modules[id], module, __dirname: path.resolve('apps/desktop'), process: { platform: 'win32', pid: 100 }, Buffer, BigInt, setTimeout, clearTimeout, Date });
  const controller = module.exports.createScreenCapture({ isPackaged: false }, () => main, () => 'en-US');
  const request = { frame: main.webContents.mainFrame, securityOrigin: 'dorham://app', audioRequested: true };
  const mainEvent = () => ({ sender: main.webContents, senderFrame: main.webContents.mainFrame });
  const picker = () => windows.at(-1);
  const pickerEvent = () => ({ sender: picker().webContents, senderFrame: picker().webContents.mainFrame });
  async function choose(scope = 'application', id = 'window:555:0') {
    const callback = vi.fn(), pending = controller.request(request, callback);
    const model = await handlers.get('capture:picker-model')(pickerEvent());
    await handlers.get('capture:pick')(pickerEvent(), { id, audioScope: scope }); await pending;
    return { callback, model };
  }
  return { controller, handlers, listeners, main, request, mainEvent, pickerEvent, picker, children, spawn, choose, getSources, setSources: (value: typeof sources) => { sources = value; } };
}

it('keeps chooser access in its own main frame, excludes Dorham windows, and validates the selected source', async () => {
  const f = await fixture();
  const callback = vi.fn(), pending = f.controller.request(f.request, callback);
  await expect(f.handlers.get('capture:picker-model')(f.mainEvent())).rejects.toThrow('Untrusted');
  const model = await f.handlers.get('capture:picker-model')(f.pickerEvent());
  expect(model.sources.map((source: any) => source.name)).toEqual(['Owned game', 'Screen 1']);
  await expect(f.handlers.get('capture:pick')(f.pickerEvent(), { id: 'window:999:0', audioScope: 'system' })).rejects.toThrow('unavailable');
  await expect(f.handlers.get('capture:pick')(f.pickerEvent(), { id: 'screen:0:0', audioScope: 'application' })).rejects.toThrow('application');
  await f.handlers.get('capture:pick')(f.pickerEvent(), { id: '', audioScope: 'none' }); await pending; expect(callback).toHaveBeenCalledWith(null);
});

it('cancels immediately before enumeration finishes and completes each native request once', async () => {
  const f = await fixture(), callback = vi.fn(), pending = f.controller.request(f.request, callback);
  await f.handlers.get('capture:pick')(f.pickerEvent(), { id: '', audioScope: 'none' }); await pending;
  f.controller.stop(); expect(callback).toHaveBeenCalledOnce(); expect(callback).toHaveBeenCalledWith(null);
  const selected = await f.choose(); expect(selected.callback).toHaveBeenCalledWith(expect.objectContaining({ video: expect.objectContaining({ id: 'window:555:0' }) }));
});

it('rejects a source closed after preview and does not broaden it to another application', async () => {
  const f = await fixture(), callback = vi.fn(), pending = f.controller.request(f.request, callback);
  await f.handlers.get('capture:picker-model')(f.pickerEvent()); f.setSources([]);
  await expect(f.handlers.get('capture:pick')(f.pickerEvent(), { id: 'window:555:0', audioScope: 'application' })).rejects.toThrow('closed');
  f.controller.stop(); await pending; expect(callback).toHaveBeenCalledWith(null); expect(f.spawn).not.toHaveBeenCalled();
});

it('requires a current one-use chooser grant and captures the selected window, never a renderer-supplied PID', async () => {
  const f = await fixture();
  await expect(f.handlers.get('capture:audio-start')(f.mainEvent())).rejects.toThrow('Choose');
  await f.choose();
  const starting = f.handlers.get('capture:audio-start')(f.mainEvent());
  const child = f.children[0]; child.stderr.emit('data', Buffer.from('READY 48000 2\n'));
  const result = await starting;
  expect(result).toMatchObject({ id: 'owned-audio-id', audioScope: 'application' });
  expect(f.spawn.mock.calls[0]).toEqual([expect.stringContaining('ShareAudio.exe'), ['include-window', '555', '100'], expect.objectContaining({ windowsHide: true })]);
  await expect(f.handlers.get('capture:audio-start')(f.mainEvent())).rejects.toThrow('Choose');
  f.controller.stop(); expect(child.kill).toHaveBeenCalled();
});

it('bounds queued audio, rejects foreign acknowledgements, and stops native capture on teardown', async () => {
  const f = await fixture(); await f.choose('system');
  const starting = f.handlers.get('capture:audio-start')(f.mainEvent()), child = f.children[0]; child.stderr.emit('data', Buffer.from('READY 48000 2\n')); await starting;
  expect(f.spawn.mock.calls[0][1]).toEqual(['exclude-process', '100', '100']);
  child.stdout.emit('data', Buffer.alloc(7680 * 30));
  expect(f.main.webContents.send.mock.calls.filter(([key]) => key === 'capture:audio')).toHaveLength(6);
  expect(() => f.listeners.get('capture:audio-ack')({ sender: {} }, 'owned-audio-id')).toThrow('Untrusted');
  f.listeners.get('capture:audio-ack')(f.mainEvent(), 'owned-audio-id'); child.stdout.emit('data', Buffer.alloc(7680));
  expect(f.main.webContents.send.mock.calls.filter(([key]) => key === 'capture:audio')).toHaveLength(7);
  f.controller.stop(); expect(child.stdin.end).toHaveBeenCalled(); expect(child.kill).toHaveBeenCalled();
});

it('supports video-only grants without starting an audio helper, including older Windows builds', async () => {
  const f = await fixture('10.0.19045'); expect(f.controller.supported).toBe(false);
  const result = await f.choose('system'); expect(result.callback).toHaveBeenCalledWith(expect.objectContaining({ video: expect.any(Object) }));
  expect(f.handlers.get('capture:selection')(f.mainEvent()).audioScope).toBe('none');
  await expect(f.handlers.get('capture:audio-start')(f.mainEvent())).rejects.toThrow('Choose'); expect(f.spawn).not.toHaveBeenCalled();
});
