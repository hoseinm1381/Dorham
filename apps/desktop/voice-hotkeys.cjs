const { spawn } = require('node:child_process');
const path = require('node:path');
const keys = require('./voice-keys.json');
function parse(value) {
  if (!value || !['open', 'push', 'toggle'].includes(value.mode) || typeof value.background !== 'boolean') throw new Error('Invalid voice hotkey');
  const b = value.binding;
  if (!b || !Object.hasOwn(keys, b.code) || !['ctrl', 'alt', 'shift'].every(k => typeof b[k] === 'boolean') || (b.alt && b.code === 'F4')) throw new Error('Unsupported voice hotkey');
  return { mode: value.mode, background: value.background, binding: { code: b.code, ctrl: b.ctrl, alt: b.alt, shift: b.shift } };
}
class VoiceHotkeys {
  constructor(app, emit) { this.app = app; this.emit = emit; this.active = false; this.child = null; this.preferences = null; this.watchdog = null; this.generation = 0; }
  configure(value) { const next = parse(value); if (JSON.stringify(next) === JSON.stringify(this.preferences)) return; this.preferences = next; this.restart(); }
  setActive(value) { if (this.active === value) return; this.active = value; this.restart(); }
  stop() { this.generation++; if (this.watchdog) clearInterval(this.watchdog); this.watchdog = null; const child = this.child; this.child = null; if (child) { child.stdin.end(); child.kill(); } this.emit({ type: 'release' }); }
  restart() {
    this.stop(); const p = this.preferences;
    if (!this.active || !p?.background || p.mode === 'open') return;
    if (process.platform !== 'win32') { this.emit({ type: 'error', message: 'Background voice hotkeys require Windows.' }); return; }
    const binary = this.app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'native', 'VoiceHotkey.exe') : path.join(__dirname, 'native', 'VoiceHotkey.exe');
    const b = p.binding, mods = Number(b.ctrl) | (Number(b.alt) << 1) | (Number(b.shift) << 2), generation = this.generation;
    const child = spawn(binary, [String(keys[b.code]), String(mods), String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); this.child = child;
    let last = Date.now(), buffer = '', failed = false;
    const fail = () => { if (failed || generation !== this.generation) return; failed = true; this.stop(); this.emit({ type: 'error', message: 'Background hotkey stopped. Microphone released; reselect the voice input mode to retry.' }); };
    child.on('error', fail); child.on('exit', fail); child.stdin.on('error', () => {});
    child.stdout.on('data', data => { if (generation !== this.generation) return; buffer += data.toString(); let end; while ((end = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (!['D', 'U', 'H'].includes(line)) { fail(); return; } last = Date.now(); if (line !== 'H') this.emit({ type: line === 'D' ? 'down' : 'up' }); } if (buffer.length > 16) fail(); });
    this.watchdog = setInterval(() => { if (Date.now() - last > 2200) fail(); }, 500);
  }
}
module.exports = { VoiceHotkeys, parse };
