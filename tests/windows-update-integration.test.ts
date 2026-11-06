import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

// Run the actual main-process entry point with an isolated Electron shell.
// No personal profile, installer, production endpoint or real window is used.
async function shell() {
  const app: any = new EventEmitter();
  Object.assign(app, { isPackaged: true, getPath: () => 'unused-test-profile', requestSingleInstanceLock: () => true, whenReady: async () => {}, quit: vi.fn() });
  let options: any;
  const windows: any[] = [], trays: any[] = [];
  const state = { available: false, phase: 'idle', latest: '1.2.0', progress: 0 };
  const updater = { state: () => ({ ...state }), check: vi.fn(async () => state), prepare: vi.fn(async () => {}), install: vi.fn(async () => ({ started: true })), pauseDownload: vi.fn(), wake: vi.fn(), start: vi.fn(), stop: vi.fn() };
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { mainFrame: { url: 'dorham://app/index.html' }, setWindowOpenHandler: vi.fn(), setBackgroundThrottling: vi.fn(), send: vi.fn() });
    constructor() { super(); windows.push(this); }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    isFocused() { return true; }
    show = vi.fn(); focus = vi.fn(); loadURL = vi.fn();
  }
  class Tray {
    menu: any[] = []; tooltip = '';
    constructor() { trays.push(this); }
    setToolTip(value: string) { this.tooltip = value; }
    setContextMenu(value: any[]) { this.menu = value; }
    on() {}
  }
  const handlers = new Map<string, (...args: any[]) => any>(), listeners = new Map<string, (...args: any[]) => any>();
  const powerMonitor = new EventEmitter(), dialog = { showMessageBox: vi.fn(async () => ({})) };
  const electron = { app, BrowserWindow: Window, Tray, powerMonitor, dialog, Menu: { buildFromTemplate: (value: any) => value }, nativeImage: { createFromPath: () => ({}) }, protocol: { registerSchemesAsPrivileged() {}, handle() {} }, session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDisplayMediaRequestHandler() {} } }, ipcMain: { handle: (key: string, fn: any) => handlers.set(key, fn), on: (key: string, fn: any) => listeners.set(key, fn) } };
  const modules: Record<string, any> = {
    electron,
    './updater.cjs': { createUpdater: (_app: any, _net: any, value: any) => { options = value; return updater; } },
    './voice-overlay.cjs': { createVoiceOverlay: () => ({ setActive() {}, setLocked() {}, close() {} }) },
    './screen-capture.cjs': { createScreenCapture: () => ({ supported: true, stop() {}, request() {} }) },
    './voice-hotkeys.cjs': { VoiceHotkeys: class { setActive() {} stop() {} } },
    'node:path': { join: (...parts: string[]) => parts.join('/') },
    'node:fs': {}, 'node:url': {}
  };
  const source = await readFile('apps/desktop/main.cjs', 'utf8');
  vm.runInNewContext(source, { require: (id: string) => { if (!(id in modules)) throw Error(`Unexpected module ${id}`); return modules[id]; }, __dirname: 'isolated-desktop', process: { platform: 'win32' } });
  await Promise.resolve();
  const current = windows.at(-1), tray = trays.at(-1);
  const event = () => ({ sender: current.webContents, senderFrame: current.webContents.mainFrame });
  return { app, current, tray, updater, options, state, handlers, listeners, event, powerMonitor };
}

it('connects native scheduled updates to tray progress, safe restart and call lifecycle', async () => {
  const f = await shell();
  expect(f.options.autoDownload).toBe(true); expect(f.updater.start).toHaveBeenCalledOnce();
  Object.assign(f.state, { available: true, phase: 'downloading', progress: 42 }); f.options.onState(f.state);
  expect(f.tray.tooltip).toContain('Downloading update 42%');
  expect(f.current.webContents.send).toHaveBeenCalledWith('update:state', f.state);
  expect(f.handlers.get('update:state')!(f.event())).toEqual(f.state);
  await f.handlers.get('update:prepare')!(f.event()); expect(f.updater.prepare).toHaveBeenCalledOnce();
  expect(f.tray.menu.find((item: any) => item.label?.includes('Downloading')).enabled).toBe(false);
  f.listeners.get('call:set')!(f.event(), true);
  expect(f.updater.pauseDownload).toHaveBeenCalledOnce(); expect(f.options.canInstall()).toBe(false); expect(f.options.canDownload()).toBe(false);
  Object.assign(f.state, { phase: 'ready', progress: 100 }); f.options.onState();
  expect(f.tray.menu.find((item: any) => item.label?.includes('Restart to update')).enabled).toBe(false);
  expect(() => f.handlers.get('update:install')!(f.event())).toThrow('Disconnect voice');
  f.listeners.get('call:set')!(f.event(), false);
  expect(f.options.canInstall()).toBe(true); expect(f.updater.wake).toHaveBeenCalled();
  const restart = f.tray.menu.find((item: any) => item.label?.includes('Restart to update'));
  expect(restart.enabled).toBe(true); restart.click(); expect(f.updater.install).toHaveBeenCalledOnce();
  f.app.emit('before-quit'); expect(f.updater.stop).toHaveBeenCalledOnce();
});

it('retains trusted-frame IPC and Persian tray controls, and wakes on resume', async () => {
  const f = await shell();
  expect(() => f.handlers.get('update:install')!({ sender: {} })).toThrow('Untrusted sender');
  Object.assign(f.state, { available: true, phase: 'ready' });
  f.handlers.get('ui:language')!(f.event(), 'fa-IR');
  expect(f.tray.menu[1].label).toContain('راه‌اندازی دوباره');
  f.powerMonitor.emit('resume'); expect(f.updater.wake).toHaveBeenCalled();
});
