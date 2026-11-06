const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  getServer: () => ipcRenderer.invoke('server:get'), setServer: url => ipcRenderer.invoke('server:set', url),
  getSecret: () => ipcRenderer.invoke('secret:get'), setSecret: value => ipcRenderer.invoke('secret:set', value),
  setLanguage: value => ipcRenderer.invoke('ui:language', value),
  configureVoiceHotkey: value => ipcRenderer.invoke('voice:configure', value),
  onVoiceHotkey: listener => { const handler = (_event, value) => listener(value); ipcRenderer.on('voice:hotkey', handler); return () => ipcRenderer.removeListener('voice:hotkey', handler); },
  getOverlay: () => ipcRenderer.invoke('overlay:get'), configureOverlay: value => ipcRenderer.invoke('overlay:configure', value), updateOverlay: value => ipcRenderer.send('overlay:update', value),
  onOverlayPreferences: listener => { const handler = (_event, value) => listener(value); ipcRenderer.on('overlay:preferences', handler); return () => ipcRenderer.removeListener('overlay:preferences', handler); },
  onVisibility: listener => { let active = true; const handler = (_event, visible) => { if (active) listener(visible === true); }; ipcRenderer.on('ui:visibility', handler); void ipcRenderer.invoke('ui:visible').then(visible => { if (active) listener(visible === true); }); return () => { active = false; ipcRenderer.removeListener('ui:visibility', handler); }; },
  getCaptureCapabilities: () => ipcRenderer.invoke('capture:capabilities'),
  getCaptureSelection: () => ipcRenderer.invoke('capture:selection'),
  startCaptureAudio: () => ipcRenderer.invoke('capture:audio-start'),
  stopCaptureAudio: id => ipcRenderer.send('capture:audio-stop', id),
  acknowledgeCaptureAudio: id => ipcRenderer.send('capture:audio-ack', id),
  onCaptureAudio: listener => { const handler = (_event, value) => listener(value); ipcRenderer.on('capture:audio', handler); return () => ipcRenderer.removeListener('capture:audio', handler); },
  setInCall: value => ipcRenderer.send('call:set', value === true), getAppInfo: () => ipcRenderer.invoke('app:info'), checkUpdate: () => ipcRenderer.invoke('update:check'), installUpdate: () => ipcRenderer.invoke('update:install'),
  getUpdateState: () => ipcRenderer.invoke('update:state'), prepareUpdate: () => ipcRenderer.invoke('update:prepare'),
  onUpdateState: listener => { const handler = (_event, value) => listener(value); ipcRenderer.on('update:state', handler); return () => ipcRenderer.removeListener('update:state', handler); }
}));
