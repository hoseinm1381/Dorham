const path = require('node:path');
const cleanAvatar = value => typeof value === 'string' && value.length <= 32768 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : undefined;
const positions = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
function cleanPreferences(value) { return { enabled: value?.enabled === true, position: positions.has(value?.position) ? value.position : 'top-left' }; }
function cleanState(value) {
  if (!value || typeof value.channel !== 'string' || !Array.isArray(value.members)) return null;
  return { channel: value.channel.slice(0, 80), language: value.language === 'fa-IR' ? 'fa-IR' : 'en-US', members: value.members.slice(0, 16).filter(m => typeof m?.name === 'string').map(m => ({ ...(typeof m.id === 'string' ? { id: m.id.slice(0, 80) } : {}), name: m.name.slice(0, 48), ...(cleanAvatar(m.avatar) ? { avatar: m.avatar } : {}), muted: m.muted === true, deafened: m.deafened === true, serverMuted: m.serverMuted === true, speaking: m.speaking === true })) };
}
function createVoiceOverlay(readSettings, saveSettings) {
  const { BrowserWindow, screen, app } = require('electron');
  let win, state = null, active = false, locked = false, bounds, lastSent;
  let prefs = cleanPreferences(readSettings().voiceOverlay);
  const preferences = () => ({ ...prefs });
  function close() { if (win && !win.isDestroyed()) win.destroy(); win = undefined; bounds = undefined; lastSent = undefined; }
  function place() {
    if (!win || win.isDestroyed()) return;
    const area = screen.getPrimaryDisplay().workArea;
    const width = 270, height = Math.min(area.height - 32, 20 + (state?.members.length || 0) * 38);
    const next = { x: prefs.position.endsWith('right') ? area.x + area.width - width - 16 : area.x + 16, y: prefs.position.startsWith('bottom') ? area.y + area.height - height - 16 : area.y + 16, width, height };
    if (!bounds || Object.keys(next).some(key => next[key] !== bounds[key])) { bounds = next; win.setBounds(next); }
  }
  function send(force = false) {
    const previous = force ? [] : lastSent?.members || [];
    const packet = { ...state, members: state.members.map((member, index) => {
      const old = previous.find((item, i) => member.id ? item.id === member.id : i === index);
      return { ...member, avatar: old && old.avatar === member.avatar ? undefined : member.avatar || null };
    }) };
    win.webContents.send('overlay:state', packet); lastSent = state;
  }
  function sync() {
    if (!prefs.enabled || !active || locked || !state || !state.members.length) { close(); return; }
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({ width: 270, height: 100, show: false, transparent: true, frame: false, focusable: false, skipTaskbar: true, resizable: false, movable: false, maximizable: false, minimizable: false, hasShadow: false, alwaysOnTop: true, webPreferences: { preload: path.join(__dirname, 'overlay-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
      const owned = win; owned.setIgnoreMouseEvents(true, { forward: true }); owned.setAlwaysOnTop(true, 'screen-saver');
      owned.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      owned.webContents.on('will-navigate', event => event.preventDefault());
      owned.webContents.on('did-finish-load', () => { if (win !== owned || owned.isDestroyed()) return; send(true); owned.showInactive(); });
      owned.on('closed', () => { if (win === owned) win = undefined; });
      void owned.loadFile(path.join(__dirname, 'overlay.html')).catch(() => { if (win === owned) close(); });
    }
    place(); send();
  }
  void app.whenReady().then(() => screen.on('display-metrics-changed', place));
  return { preferences, configure(value) { prefs = cleanPreferences(value); saveSettings({ ...readSettings(), voiceOverlay: prefs }); sync(); return preferences(); }, update(value) {
    const next = cleanState(value);
    if (next) for (const [index, member] of next.members.entries()) {
      const raw = value.members.filter(m => typeof m?.name === 'string')[index];
      if (!Object.hasOwn(raw, 'avatar')) { const old = state?.members.find((m, i) => member.id ? member.id === m.id : index === i); if (old?.avatar) member.avatar = old.avatar; }
    }
    const equal = next && state && next.channel === state.channel && next.language === state.language && next.members.length === state.members.length && next.members.every((member, i) => ['id', 'name', 'avatar', 'muted', 'deafened', 'serverMuted', 'speaking'].every(key => member[key] === state.members[i][key]));
    if (equal || (!next && !state)) return;
    state = next; sync();
  }, setActive(value) { if (active === (value === true)) return; active = value === true; if (!active) state = null; sync(); }, setLocked(value) { if (locked === (value === true)) return; locked = value === true; sync(); }, close };
}
module.exports = { createVoiceOverlay, cleanPreferences, cleanState };
