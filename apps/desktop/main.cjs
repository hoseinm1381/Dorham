const { app, BrowserWindow, ipcMain, safeStorage, protocol, net, session, desktopCapturer, dialog, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
protocol.registerSchemesAsPrivileged([{ scheme: 'dorham', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
let win, tray, inCall = false, quitting = false;
const root = path.join(__dirname, 'dist');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } };
const saveSettings = settings => { fs.writeFileSync(settingsFile(), JSON.stringify(settings), { mode: 0o600 }); };
const trusted = event => { if (!event.senderFrame?.url.startsWith('dorham://app/')) throw new Error('Untrusted sender'); };
app.whenReady().then(() => {
  protocol.handle('dorham', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response('Forbidden', { status: 403 });
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(root, relative);
    if (!file.startsWith(`${root}${path.sep}`)) return new Response('Forbidden', { status: 403 });
    const response = await net.fetch(pathToFileURL(file).href);
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:*; connect-src 'self' https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*; media-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'");
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  });
  const permissions = new Set(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(contents.getURL().startsWith('dorham://app/') && permissions.has(permission)));
  session.defaultSession.setPermissionCheckHandler((contents, permission) => Boolean(contents?.getURL().startsWith('dorham://app/')) && permissions.has(permission));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (request.securityOrigin !== 'dorham://app') return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const choices = sources.slice(0, 18);
      const result = await dialog.showMessageBox(win, { type: 'question', title: 'Share your screen', message: 'Choose the screen or window to share', detail: 'Everything visible in the selected source will be shared with this voice channel.', buttons: [...choices.map(s => s.name), 'Cancel'], cancelId: choices.length, noLink: true });
      callback(result.response < choices.length ? { video: choices[result.response] } : {});
    } catch { callback({}); }
  });
  ipcMain.handle('server:get', event => { trusted(event); return readSettings().server || ''; });
  ipcMain.handle('server:set', (event, value) => { trusted(event); const url = new URL(value); if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('HTTPS is required'); saveSettings({ ...readSettings(), server: url.origin, secret: undefined }); });
  ipcMain.handle('secret:get', event => { trusted(event); const secret = readSettings().secret; return secret && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(secret, 'base64')) : null; });
  ipcMain.handle('secret:set', (event, value) => { trusted(event); if (value && !safeStorage.isEncryptionAvailable()) throw new Error('Windows credential protection is unavailable'); saveSettings({ ...readSettings(), secret: value ? safeStorage.encryptString(value).toString('base64') : undefined }); });
  ipcMain.on('call:set', (event, value) => { trusted(event); inCall = value === true; if (tray) tray.setToolTip(inCall ? 'Dorham — in voice' : 'Dorham'); });
  win = new BrowserWindow({ width: 1370, height: 880, minWidth: 720, minHeight: 540, backgroundColor: '#101218', title: 'Dorham', icon: path.join(__dirname, 'icon.ico'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(({ url }) => { try { const target = new URL(url); if (target.protocol === 'https:' && !target.username && !target.password) void shell.openExternal(target.href); } catch { /* Invalid links stay closed. */ } return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('dorham://app/')) event.preventDefault(); });
  win.on('close', event => { if (inCall && !quitting) { event.preventDefault(); win.hide(); } else { quitting = true; app.quit(); } });
  win.loadURL('dorham://app/index.html');
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')));
  tray.setToolTip('Dorham'); tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Dorham', click: () => win.show() }, { type: 'separator' }, { label: 'Quit (disconnect voice)', click: () => { quitting = true; app.quit(); } }])); tray.on('double-click', () => win.show());
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (!inCall) app.quit(); });
app.on('activate', () => win?.show());
