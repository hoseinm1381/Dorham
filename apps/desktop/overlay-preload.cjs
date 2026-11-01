const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('voiceOverlay', Object.freeze({ onState: listener => { const handler = (_event, value) => listener(value); ipcRenderer.on('overlay:state', handler); return () => ipcRenderer.removeListener('overlay:state', handler); } }));
