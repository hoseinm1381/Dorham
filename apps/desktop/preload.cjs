const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  getServer: () => ipcRenderer.invoke('server:get'), setServer: url => ipcRenderer.invoke('server:set', url),
  getSecret: () => ipcRenderer.invoke('secret:get'), setSecret: value => ipcRenderer.invoke('secret:set', value),
  setLanguage: value => ipcRenderer.invoke('ui:language', value),
  configureVoiceHotkey: value => ipcRenderer.invoke('voice:configure', value),
  onVoiceHotkey: listener => { const handler = (_event, value) => listener(value); ipcRenderer.on('voice:hotkey', handler); return () => ipcRenderer.removeListener('voice:hotkey', handler); },
  setInCall: value => ipcRenderer.send('call:set', value === true), systemAudioSafe: false, version: '0.5.0'
}));
