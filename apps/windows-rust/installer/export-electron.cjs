// Runs only inside a private clone of the previous runtime and profile. No
// network requests or product code are loaded. Credentials leave this process
// only as a CurrentUser DPAPI-protected envelope; none are printed or logged.
const { app, BrowserWindow, protocol, safeStorage, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const base = process.env.DORHAM_MIGRATION_WORK;
const destination = process.env.DORHAM_MIGRATION_EXPORT;
if (!base || !destination || !path.isAbsolute(base) || !path.isAbsolute(destination)) process.exit(41);
app.setPath('userData', path.join(base, 'profile-work'));
protocol.registerSchemesAsPrivileged([{ scheme: 'dorham', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let timeout = setTimeout(() => app.exit(42), 30000);
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*','ws://*/*','wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  protocol.handle('dorham', () => new Response('<!doctype html><meta charset="utf-8"><title>Dorham migration</title>'));
  const settingsPath = path.join(base, 'profile-work', 'settings.json');
  const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
  let secret = null;
  if (typeof settings.secret === 'string' && settings.secret.length) {
    if (!safeStorage.isEncryptionAvailable()) throw Error('Original credential protection is unavailable.');
    secret = safeStorage.decryptString(Buffer.from(settings.secret, 'base64'));
    if (secret.length > 16384) throw Error('Invalid stored credential.');
  }
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await window.loadURL('dorham://app/index.html');
  const localStorage = await window.webContents.executeJavaScript(`(() => { const values = {}; for (let i=0;i<localStorage.length;i++) { const key=localStorage.key(i); if (/^dorham[.-]/.test(key) && key.length<=256) { const value=localStorage.getItem(key); if (value.length>2097152) throw Error('Preference exceeds supported size'); values[key]=value; } } return values; })()`);
  const preferences = {};
  if (typeof settings.server === 'string') preferences.server = settings.server;
  if (settings.voiceOverlay && typeof settings.voiceOverlay === 'object') preferences.voiceOverlay = settings.voiceOverlay;
  const payload = { schema: 1, appId: 'com.dorham.chat', sourceVersion: process.env.DORHAM_MIGRATION_SOURCE_VERSION || 'electron', settings: preferences, secret, localStorage };
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > 8*1048576) throw Error('Migration data exceeds supported size.');
  const protectedPayload = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'protect-export.ps1')], { input: serialized, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 16*1048576 }).trim();
  if (!/^[A-Za-z0-9+/]+=*$/.test(protectedPayload)) throw Error('Credential export protection failed.');
  const envelope = { schema: 1, appId: 'com.dorham.chat', protectedPayload };
  const temporary = destination + '.partial';
  fs.writeFileSync(temporary, JSON.stringify(envelope), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, destination);
  window.destroy(); clearTimeout(timeout); timeout = undefined; app.exit(0);
}).catch(() => { clearTimeout(timeout); app.exit(43); });
