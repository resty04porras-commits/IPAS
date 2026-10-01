'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  getPlatform:   () => ipcRenderer.invoke('get-platform'),
});
