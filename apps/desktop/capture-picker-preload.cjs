const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('capturePicker', Object.freeze({ model: () => ipcRenderer.invoke('capture:picker-model'), choose: value => ipcRenderer.invoke('capture:pick', value) }));
