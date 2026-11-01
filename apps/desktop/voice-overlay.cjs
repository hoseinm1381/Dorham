const path = require('node:path');
const cleanAvatar = value => typeof value === 'string' && value.length <= 32768 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : undefined;
const positions = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
function cleanPreferences(value) { return { enabled: value?.enabled === true, position: positions.has(value?.position) ? value.position : 'top-left' }; }
function cleanState(value) {
  if (!value || typeof value.channel !== 'string' || !Array.isArray(value.members)) return null;
  return { channel: value.channel.slice(0, 80), language: value.language === 'fa-IR' ? 'fa-IR' : 'en-US', members: value.members.slice(0, 16).filter(m => typeof m?.name === 'string').map(m => ({ name: m.name.slice(0, 48), ...(cleanAvatar(m.avatar) ? { avatar: m.avatar } : {}), muted: m.muted === true, deafened: m.deafened === true, serverMuted: m.serverMuted === true, speaking: m.speaking === true })) };
}
function createVoiceOverlay(readSettings, saveSettings) {
  const { BrowserWindow, screen } = require('electron');
  let win, state = null, active = false, locked = false;
  const preferences = () => cleanPreferences(readSettings().voiceOverlay);
  function close() { if (win && !win.isDestroyed()) win.destroy(); win = undefined; }
  function place() {
    if (!win || win.isDestroyed()) return;
    const area = screen.getPrimaryDisplay().workArea;
    const prefs = preferences(), width = 270, height = Math.min(area.height - 32, 20 + (state?.members.length || 0) * 38);
    win.setBounds({ x: prefs.position.endsWith('right') ? area.x + area.width - width - 16 : area.x + 16, y: prefs.position.startsWith('bottom') ? area.y + area.height - height - 16 : area.y + 16, width, height });
  }
  function sync() {
    if (!preferences().enabled || !active || locked || !state || !state.members.length) { close(); return; }
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({ width: 270, height: 100, show: false, transparent: true, frame: false, focusable: false, skipTaskbar: true, resizable: false, movable: false, maximizable: false, minimizable: false, hasShadow: false, alwaysOnTop: true, webPreferences: { preload: path.join(__dirname, 'overlay-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
      const owned = win; owned.setIgnoreMouseEvents(true, { forward: true }); owned.setAlwaysOnTop(true, 'screen-saver');
      owned.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      owned.webContents.on('will-navigate', event => event.preventDefault());
      owned.webContents.on('did-finish-load', () => { if (win !== owned || owned.isDestroyed()) return; owned.webContents.send('overlay:state', state); owned.showInactive(); });
      owned.on('closed', () => { if (win === owned) win = undefined; });
      void owned.loadFile(path.join(__dirname, 'overlay.html')).catch(() => { if (win === owned) close(); });
    }
    place(); win.webContents.send('overlay:state', state);
  }
  return { preferences, configure(value) { const next = cleanPreferences(value); saveSettings({ ...readSettings(), voiceOverlay: next }); sync(); return next; }, update(value) { state = cleanState(value); sync(); }, setActive(value) { active = value === true; if (!active) state = null; sync(); }, setLocked(value) { locked = value === true; sync(); }, close };
}
module.exports = { createVoiceOverlay, cleanPreferences, cleanState };
