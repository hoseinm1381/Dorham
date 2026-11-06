const { app, BrowserWindow, ipcMain, safeStorage, protocol, net, session, dialog, Tray, Menu, nativeImage, shell, powerMonitor } = require('electron');
const { createUpdater } = require('./updater.cjs');
const { createVoiceOverlay } = require('./voice-overlay.cjs');
const { createScreenCapture } = require('./screen-capture.cjs');
const { VoiceHotkeys } = require('./voice-hotkeys.cjs');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
protocol.registerSchemesAsPrivileged([{ scheme: 'dorham', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
let win, tray, inCall = false, quitting = false;
let interfaceLanguage = 'en-US';
let screenCapture;
const voiceHotkeys = new VoiceHotkeys(app, event => { if (win && !win.isDestroyed()) win.webContents.send('voice:hotkey', { ...event, background: !win.isFocused() }); });
const root = path.join(__dirname, 'dist');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settingsCache;
const readSettings = () => { if (!settingsCache) { try { settingsCache = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { settingsCache = {}; } } return settingsCache; };
const saveSettings = settings => { const temporary = settingsFile() + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(settings), { mode: 0o600 }); fs.renameSync(temporary, settingsFile()); settingsCache = settings; };
const voiceOverlay = createVoiceOverlay(readSettings, saveSettings);
const trusted = event => { if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !event.senderFrame?.url.startsWith('dorham://app/')) throw new Error('Untrusted sender'); };
const updater = createUpdater(app, net, { canInstall: () => !inCall, canDownload: () => !inCall, autoDownload: app.isPackaged, onState: state => {
  if (win && !win.isDestroyed()) win.webContents.send('update:state', state);
  renderTray();
} });
function renderTray() {
  if (!tray) return;
  const state = updater.state(), fa = interfaceLanguage === 'fa-IR';
  const status = state.phase === 'ready' ? (fa ? `راه‌اندازی دوباره برای به‌روزرسانی ${state.latest}` : `Restart to update ${state.latest}`)
    : state.phase === 'downloading' ? (fa ? `دریافت به‌روزرسانی ${state.progress}%` : `Downloading update ${state.progress}%`)
    : state.phase === 'installing' ? (fa ? 'در حال نصب به‌روزرسانی…' : 'Installing update…')
    : state.available ? (fa ? `به‌روزرسانی ${state.latest} موجود است` : `Update ${state.latest} available`) : '';
  tray.setToolTip(`Dorham${inCall ? (fa ? ' — در تماس صوتی' : ' — in voice') : ''}${status ? ` — ${status}` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: fa ? 'باز کردن دورهم' : 'Open Dorham', click: () => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } },
    ...(status ? [{ label: status, enabled: state.available && !inCall && !['downloading', 'installing'].includes(state.phase), click: () => {
      void updater.install().catch(() => { void dialog.showMessageBox(win, { type: 'error', message: fa ? 'به‌روزرسانی انجام نشد. دوباره تلاش کنید.' : 'The update could not be started. Try again later.' }); });
    } }] : []),
    { type: 'separator' }, { label: fa ? 'خروج (قطع تماس صوتی)' : 'Quit (disconnect voice)', click: () => { quitting = true; app.quit(); } }
  ]));
}
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.whenReady().then(() => {
  if (!primary) return;
  screenCapture = createScreenCapture(app, () => win, () => interfaceLanguage, () => inCall);
  ipcMain.handle('capture:capabilities', event => { trusted(event); return { sharedAudio: screenCapture.supported }; });
  ipcMain.handle('ui:visible', event => { trusted(event); return win.isVisible() && !win.isMinimized(); });
  ipcMain.handle('overlay:get', event => { trusted(event); return voiceOverlay.preferences(); });
  ipcMain.handle('overlay:configure', (event, value) => { trusted(event); const preferences = voiceOverlay.configure(value); win.webContents.send('overlay:preferences', preferences); return preferences; });
  ipcMain.on('overlay:update', (event, value) => { trusted(event); voiceOverlay.update(value); });
  ipcMain.handle('app:info', event => { trusted(event); return { version: app.getVersion(), platform: 'windows' }; });
  ipcMain.handle('update:check', event => { trusted(event); return updater.check(); });
  ipcMain.handle('update:state', event => { trusted(event); return updater.state(); });
  ipcMain.handle('update:prepare', async event => { trusted(event); await updater.prepare(); });
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
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => { void screenCapture.request(request, callback); });
  ipcMain.handle('server:get', event => { trusted(event); return readSettings().server || ''; });
  ipcMain.handle('ui:language', (event, value) => { trusted(event); if (value === 'fa-IR' || value === 'en-US') { interfaceLanguage = value; renderTray(); } });
  ipcMain.handle('server:set', (event, value) => { trusted(event); const url = new URL(value); if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('HTTPS is required'); saveSettings({ ...readSettings(), server: url.origin, secret: undefined }); });
  ipcMain.handle('secret:get', event => { trusted(event); const secret = readSettings().secret; return secret && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(secret, 'base64')) : null; });
  ipcMain.handle('secret:set', (event, value) => { trusted(event); if (value && !safeStorage.isEncryptionAvailable()) throw new Error('Windows credential protection is unavailable'); saveSettings({ ...readSettings(), secret: value ? safeStorage.encryptString(value).toString('base64') : undefined }); });
  ipcMain.handle('voice:configure', (event, value) => { trusted(event); voiceHotkeys.configure(value); return { supported: process.platform === 'win32' }; });
  ipcMain.on('call:set', (event, value) => { trusted(event); inCall = value === true; voiceOverlay.setActive(inCall); voiceHotkeys.setActive(inCall); win?.webContents.setBackgroundThrottling(!inCall); if (inCall) updater.pauseDownload(); else { screenCapture.stop(); updater.wake(); } renderTray(); });
  win = new BrowserWindow({ width: 1370, height: 880, minWidth: 720, minHeight: 540, backgroundColor: '#101218', title: 'Dorham', icon: path.join(__dirname, 'icon.ico'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: true } });
  for (const event of ['show', 'hide', 'minimize', 'restore']) win.on(event, () => win.webContents.send('ui:visibility', win.isVisible() && !win.isMinimized()));
  win.webContents.setWindowOpenHandler(({ url }) => { try { const target = new URL(url); if (target.protocol === 'https:' && !target.username && !target.password) void shell.openExternal(target.href); } catch { /* Invalid links stay closed. */ } return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('dorham://app/')) event.preventDefault(); });
  win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) { voiceOverlay.setActive(false); screenCapture.stop(); } });
  win.webContents.on('render-process-gone', () => { voiceHotkeys.setActive(false); inCall = false; voiceOverlay.setActive(false); screenCapture.stop(); });
  powerMonitor.on('suspend', () => { voiceHotkeys.setActive(false); voiceOverlay.setLocked(true); screenCapture.stop(); }); powerMonitor.on('lock-screen', () => { voiceHotkeys.setActive(false); voiceOverlay.setLocked(true); screenCapture.stop(); });
  powerMonitor.on('resume', () => { voiceHotkeys.setActive(inCall); voiceOverlay.setLocked(false); if (app.isPackaged) updater.wake(); }); powerMonitor.on('unlock-screen', () => { voiceHotkeys.setActive(inCall); voiceOverlay.setLocked(false); });
  win.on('focus', () => { if (app.isPackaged) updater.wake(); });
  win.on('close', event => { if (inCall && !quitting) { event.preventDefault(); win.hide(); } else { quitting = true; app.quit(); } });
  win.loadURL('dorham://app/index.html');
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')));
  renderTray(); tray.on('double-click', () => win.show());
  if (app.isPackaged) updater.start();
});
app.on('before-quit', () => { quitting = true; updater.stop(); screenCapture?.stop(); voiceHotkeys.stop(); voiceOverlay.close(); });
app.on('window-all-closed', () => { if (!inCall) app.quit(); });
app.on('activate', () => win?.show());
