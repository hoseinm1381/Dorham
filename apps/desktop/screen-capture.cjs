/* global clearTimeout */
const { BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { trustedCaptureRequest } = require('./capture-origin.cjs');

function createScreenCapture(app, mainWindow, language, canCapture = () => true) {
  const binary = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'native', 'ShareAudio.exe') : path.join(__dirname, 'native', 'ShareAudio.exe');
  const supported = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 20348 && existsSync(binary);
  let picker, finish, listing, refreshing, selection, audio;
  const pickerUrl = pathToFileURL(path.join(__dirname, 'capture-picker.html')).href;
  const trustedPicker = event => picker && !picker.isDestroyed() && event.sender === picker.webContents && event.senderFrame === picker.webContents.mainFrame && event.senderFrame.url === pickerUrl;
  function trustedMain(event) { const win = mainWindow(); if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !event.senderFrame?.url.startsWith('dorham://app/')) throw Error('Untrusted capture sender'); }
  function ownSource(id) {
    const match = /^window:(\d+):/.exec(id);
    return match && BrowserWindow.getAllWindows().some(window => {
      const handle = window.getNativeWindowHandle();
      return (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString() === match[1];
    });
  }
  async function sources(thumbnails = true) {
    return (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: thumbnails ? { width: 320, height: 180 } : { width: 0, height: 0 }, fetchWindowIcons: thumbnails })).filter(source => !ownSource(source.id)).slice(0, 120);
  }
  const describe = source => ({ id: source.id, name: source.name.slice(0, 160), kind: source.id.startsWith('screen:') ? 'screen' : 'window', thumbnail: source.thumbnail?.isEmpty() ? '' : source.thumbnail?.toDataURL(), icon: source.appIcon?.isEmpty() ? '' : source.appIcon?.resize({ width: 24, height: 24 }).toDataURL() });
  function stopAudio(id) {
    if (!audio || (id && id !== audio.id)) return;
    const previous = audio; audio = undefined;
    previous.child.stdin.end(); previous.child.kill();
  }
  function stop() { selection = undefined; finish?.(null); if (audio && !audio.sender.isDestroyed()) audio.sender.send('capture:audio', { id: audio.id, error: 'Screen sharing stopped.' }); stopAudio(); }
  ipcMain.handle('capture:picker-model', async event => {
    if (!trustedPicker(event)) throw Error('Untrusted picker');
    const owned = picker, audioRequested = owned.audioRequested;
    if (!refreshing) {
      const task = sources().then(value => { if (picker === owned) listing = value; return value.map(describe); }).finally(() => { if (refreshing === task) refreshing = undefined; });
      refreshing = task;
    }
    const choices = await refreshing;
    return { sources: picker === owned ? choices : [], language: language(), audioRequested, audioSupported: supported };
  });
  ipcMain.handle('capture:pick', async (event, value) => {
    if (!trustedPicker(event) || !value || !['none', 'application', 'system'].includes(value.audioScope)) throw Error('Invalid capture choice');
    if (!value.id) { finish?.(null); return; }
    if (!listing) throw Error('Capture sources are still loading');
    const source = listing.find(item => item.id === value.id);
    if (!source || ownSource(source.id)) throw Error('Capture source is unavailable');
    const audioScope = picker.audioRequested && supported ? value.audioScope : 'none';
    if (audioScope === 'application' && !/^window:\d+:/.test(source.id)) throw Error('Choose an application for application sound');
    // Revalidate after the chooser has been open; closed sources never reuse
    // a stale preview. Keep the original trusted-frame check at completion.
    const fresh = (await sources(false)).find(item => item.id === source.id);
    if (!fresh || !trustedPicker(event)) throw Error('Capture source was closed. Refresh the list.');
    finish?.({ source: fresh, audioScope });
  });
  ipcMain.handle('capture:selection', event => { trustedMain(event); return selection ? { sourceName: selection.name, audioScope: selection.audioScope } : null; });
  ipcMain.handle('capture:audio-start', async event => {
    trustedMain(event);
    const grant = selection;
    if (!supported || !grant || grant.used || grant.audioScope === 'none' || Date.now() - grant.at > 30000) throw Error('Choose a supported screen or application with sound first.');
    grant.used = true; stopAudio();
    const match = /^window:(\d+):/.exec(grant.sourceId), id = randomUUID();
    if (grant.audioScope === 'application' && !match) throw Error('Invalid application source');
    const child = spawn(binary, [grant.audioScope === 'application' ? 'include-window' : 'exclude-process', grant.audioScope === 'application' ? match[1] : String(process.pid), String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const task = { id, child, sender: event.sender, outstanding: 0 }; audio = task;
    let pending = Buffer.alloc(0), status = '', ready = false;
    const failed = message => {
      if (audio !== task) return;
      if (ready && !event.sender.isDestroyed()) event.sender.send('capture:audio', { id, error: message });
      stopAudio(id);
    };
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      if (audio !== task) return;
      pending = Buffer.concat([pending, chunk]);
      // Fixed 20 ms stereo float packets; six unacknowledged packets bound
      // IPC/worklet latency. Backpressure drops old sound rather than growing.
      while (pending.length >= 7680) {
        const frame = pending.subarray(0, 7680); pending = pending.subarray(7680);
        if (task.outstanding < 6 && !event.sender.isDestroyed()) { task.outstanding++; event.sender.send('capture:audio', { id, pcm: new Uint8Array(frame) }); }
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { failed('Application audio did not start.'); reject(Error('Application audio did not start.')); }, 10000);
      const fail = () => { clearTimeout(timer); failed('Application audio stopped. Restart sharing to retry.'); if (!ready) reject(Error('Application audio is unavailable for this source.')); };
      child.on('error', fail); child.on('exit', fail);
      child.stderr.on('data', chunk => {
        status = (status + chunk.toString()).slice(-512);
        if (!ready && status.includes('READY 48000 2')) { clearTimeout(timer); if (audio !== task || selection !== grant) { child.kill(); reject(Error('Capture was cancelled.')); return; } ready = true; resolve(); }
      });
    });
    return { id, sourceName: grant.name, audioScope: grant.audioScope };
  });
  ipcMain.on('capture:audio-ack', (event, id) => { trustedMain(event); if (audio?.id === id) audio.outstanding = Math.max(0, audio.outstanding - 1); });
  ipcMain.on('capture:audio-stop', (event, id) => { trustedMain(event); if (typeof id === 'string') stopAudio(id); });
  return {
    supported, stop,
    request: async (request, callback) => {
      const main = mainWindow();
      if (!canCapture() || !trustedCaptureRequest(request, main?.webContents) || picker || audio) { callback(null); return; }
      selection = undefined;
      try {
        const result = await new Promise(resolve => {
          picker = new BrowserWindow({ parent: main, modal: true, width: 920, height: 690, minWidth: 640, minHeight: 480, backgroundColor: '#171b28', title: language() === 'fa-IR' ? 'انتخاب منبع اشتراک‌گذاری' : 'Choose what to share', autoHideMenuBar: true, show: false, webPreferences: { preload: path.join(__dirname, 'capture-picker-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
          const owned = picker; owned.audioRequested = request.audioRequested;
          finish = result => { finish = undefined; listing = undefined; refreshing = undefined; picker = undefined; if (!owned.isDestroyed()) owned.destroy(); resolve(result); };
          owned.on('closed', () => { if (picker === owned) finish?.(null); });
          owned.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
          owned.webContents.on('will-navigate', event => event.preventDefault());
          owned.once('ready-to-show', () => { if (!owned.isDestroyed()) owned.show(); });
          void owned.loadURL(pickerUrl).catch(() => { if (picker === owned) finish?.(null); });
        });
        if (!result || !trustedCaptureRequest(request, main?.webContents)) { callback(null); return; }
        selection = { sourceId: result.source.id, name: result.source.name.slice(0, 160), audioScope: result.audioScope, at: Date.now(), used: false };
        // Audio is authorized by the chooser and captured from the exact process
        // in a separate WASAPI stream. Never broaden a window to system sound.
        callback({ video: result.source });
      } catch { callback(null); }
    }
  };
}
module.exports = { createScreenCapture };
