const { app, BrowserWindow, ipcMain, safeStorage, protocol, net, session, desktopCapturer, dialog, Tray, Menu, nativeImage, shell, powerMonitor } = require('electron');
const { createUpdater } = require('./updater.cjs');
const { VoiceHotkeys } = require('./voice-hotkeys.cjs');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
protocol.registerSchemesAsPrivileged([{ scheme: 'dorham', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
let win, tray, inCall = false, quitting = false;
let interfaceLanguage = 'en-US';
// Enable only after the installed loopback/exclusion regression passes.
const systemAudioSafe = false;
const voiceHotkeys = new VoiceHotkeys(app, event => { if (win && !win.isDestroyed()) win.webContents.send('voice:hotkey', { ...event, background: !win.isFocused() }); });
const root = path.join(__dirname, 'dist');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } };
const saveSettings = settings => { fs.writeFileSync(settingsFile(), JSON.stringify(settings), { mode: 0o600 }); };
const trusted = event => { if (!event.senderFrame?.url.startsWith('dorham://app/')) throw new Error('Untrusted sender'); };
const updater = createUpdater(app, net, { canInstall: () => !inCall });
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.whenReady().then(() => {
  if (!primary) return;
  ipcMain.handle('app:info', event => { trusted(event); return { version: app.getVersion(), platform: 'windows' }; });
  ipcMain.handle('update:check', event => { trusted(event); return updater.check(); });
  ipcMain.handle('update:install', event => { trusted(event); if (inCall) throw Error('Disconnect voice before installing an update.'); return updater.install(); });
  protocol.handle('dorham', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response('Forbidden', { status: 403 });
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(root, relative);
    if (!file.startsWith(`${root}${path.sep}`)) return new Response('Forbidden', { status: 403 });
    const response = await net.fetch(pathToFileURL(file).href);
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:*; connect-src 'self' https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*; media-src 'self' blob: https: http://localhost:* http://127.0.0.1:*; object-src 'none'; frame-src 'none'; base-uri 'none'");
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    return new Response(response.body, { status: response.status, headers });
  });
  const permissions = new Set(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write', 'speaker-selection']);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(contents.getURL().startsWith('dorham://app/') && permissions.has(permission)));
  session.defaultSession.setPermissionCheckHandler((contents, permission) => Boolean(contents?.getURL().startsWith('dorham://app/')) && permissions.has(permission));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (request.securityOrigin !== 'dorham://app') return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const fa = interfaceLanguage === 'fa-IR'; let page = 0;
      for (;;) {
        const choices = sources.slice(page * 10, (page + 1) * 10), buttons = choices.map(s => s.name);
        const next = page * 10 + 10 < sources.length ? buttons.push(fa ? 'صفحه بعد' : 'Next page') - 1 : -1;
        const previous = page > 0 ? buttons.push(fa ? 'صفحه قبل' : 'Previous page') - 1 : -1;
        const cancel = buttons.push(fa ? 'لغو' : 'Cancel') - 1;
        const result = await dialog.showMessageBox(win, { type: 'question', title: fa ? 'اشتراک‌گذاری صفحه' : 'Share your screen', message: fa ? 'صفحه یا پنجره موردنظر را انتخاب کنید' : 'Choose the screen or window to share', detail: request.audioRequested && systemAudioSafe ? (fa ? 'تصویر انتخاب‌شده و صدای سیستم به‌جز صدای دورهم ارسال می‌شود.' : 'The selected picture and system sound, excluding Dorham, will be shared.') : (fa ? 'تمام محتوای قابل‌مشاهده در منبع انتخاب‌شده با اعضای این کانال صوتی به اشتراک گذاشته می‌شود.' : 'Everything visible in the selected source will be shared with this voice channel.'), buttons, cancelId: cancel, noLink: true });
        if (result.response === next && next >= 0) { page++; continue; }
        if (result.response === previous && previous >= 0) { page--; continue; }
        callback(result.response < choices.length ? { video: choices[result.response], ...(request.audioRequested && systemAudioSafe ? { audio: 'loopback' } : {}) } : {}); break;
      }
    } catch { callback({}); }
  });
  ipcMain.handle('server:get', event => { trusted(event); return readSettings().server || ''; });
  ipcMain.handle('ui:language', (event, value) => { trusted(event); if (value === 'fa-IR' || value === 'en-US') interfaceLanguage = value; });
  ipcMain.handle('server:set', (event, value) => { trusted(event); const url = new URL(value); if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('HTTPS is required'); saveSettings({ ...readSettings(), server: url.origin, secret: undefined }); });
  ipcMain.handle('secret:get', event => { trusted(event); const secret = readSettings().secret; return secret && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(secret, 'base64')) : null; });
  ipcMain.handle('secret:set', (event, value) => { trusted(event); if (value && !safeStorage.isEncryptionAvailable()) throw new Error('Windows credential protection is unavailable'); saveSettings({ ...readSettings(), secret: value ? safeStorage.encryptString(value).toString('base64') : undefined }); });
  ipcMain.handle('voice:configure', (event, value) => { trusted(event); voiceHotkeys.configure(value); return { supported: process.platform === 'win32' }; });
  ipcMain.on('call:set', (event, value) => { trusted(event); inCall = value === true; voiceHotkeys.setActive(inCall); win?.webContents.setBackgroundThrottling(!inCall); if (tray) tray.setToolTip(inCall ? 'Dorham — in voice' : 'Dorham'); });
  win = new BrowserWindow({ width: 1370, height: 880, minWidth: 720, minHeight: 540, backgroundColor: '#101218', title: 'Dorham', icon: path.join(__dirname, 'icon.ico'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: true } });
  win.webContents.setWindowOpenHandler(({ url }) => { try { const target = new URL(url); if (target.protocol === 'https:' && !target.username && !target.password) void shell.openExternal(target.href); } catch { /* Invalid links stay closed. */ } return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('dorham://app/')) event.preventDefault(); });
  win.webContents.on('render-process-gone', () => { voiceHotkeys.setActive(false); inCall = false; });
  powerMonitor.on('suspend', () => voiceHotkeys.setActive(false)); powerMonitor.on('lock-screen', () => voiceHotkeys.setActive(false));
  powerMonitor.on('resume', () => voiceHotkeys.setActive(inCall)); powerMonitor.on('unlock-screen', () => voiceHotkeys.setActive(inCall));
  win.on('close', event => { if (inCall && !quitting) { event.preventDefault(); win.hide(); } else { quitting = true; app.quit(); } });
  win.loadURL('dorham://app/index.html');
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')));
  tray.setToolTip('Dorham'); tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Dorham', click: () => win.show() }, { type: 'separator' }, { label: 'Quit (disconnect voice)', click: () => { quitting = true; app.quit(); } }])); tray.on('double-click', () => win.show());
});
app.on('before-quit', () => { quitting = true; voiceHotkeys.stop(); });
app.on('window-all-closed', () => { if (!inCall) app.quit(); });
app.on('activate', () => win?.show());
