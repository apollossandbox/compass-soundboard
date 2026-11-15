const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('dris', {
  loadLibrary: () => ipcRenderer.invoke('lib:load'),
  saveLibrary: (data) => ipcRenderer.invoke('lib:save', data),
  pickSounds: () => ipcRenderer.invoke('sounds:pick'),
  pickOne: () => ipcRenderer.invoke('sounds:pickOne'),
  importPaths: (paths) => ipcRenderer.invoke('sounds:importPaths', paths),
  readSound: (file) => ipcRenderer.invoke('sounds:read', file),
  copySound: (file) => ipcRenderer.invoke('sounds:copy', file),
  exportPreset: (preset) => ipcRenderer.invoke('preset:export', preset),
  importPreset: () => ipcRenderer.invoke('preset:import'),
  deleteSound: (file) => ipcRenderer.invoke('sounds:delete', file),
  openSoundsFolder: () => ipcRenderer.invoke('sounds:openFolder'),
  setHotkeys: (list) => ipcRenderer.invoke('hotkeys:set', list),
  pauseHotkeys: () => ipcRenderer.invoke('hotkeys:pause'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, id) => cb(id)),
});

contextBridge.exposeInMainWorld('drisKit', {
  scan: () => ipcRenderer.invoke('kit:scan'),
  folder: (dir) => ipcRenderer.invoke('kit:folder', dir),
  pickFolder: () => ipcRenderer.invoke('kit:pickFolder'),
  pickFile: () => ipcRenderer.invoke('kit:pickFile'),
  auto: () => ipcRenderer.invoke('kit:auto'),
  read: (p) => ipcRenderer.invoke('kit:read', p),
});

contextBridge.exposeInMainWorld('drisUpdate', {
  version: () => ipcRenderer.invoke('app:version'),
  check: () => ipcRenderer.invoke('update:check'),
  download: () => ipcRenderer.invoke('update:download'),
  install: () => ipcRenderer.invoke('update:install'),
  openReleases: () => ipcRenderer.invoke('update:openReleases'),
  onStatus: (cb) => ipcRenderer.on('update', (_e, m) => cb(m)),
});
