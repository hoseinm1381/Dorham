const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  getServer: () => ipcRenderer.invoke('server:get'), setServer: url => ipcRenderer.invoke('server:set', url),
  getSecret: () => ipcRenderer.invoke('secret:get'), setSecret: value => ipcRenderer.invoke('secret:set', value),
  setInCall: value => ipcRenderer.send('call:set', value === true), version: '0.3.0'
}));
