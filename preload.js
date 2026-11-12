const { contextBridge, ipcRenderer, webUtils } = require('electron')

const call = name => (...args) => ipcRenderer.invoke(name, ...args)
contextBridge.exposeInMainWorld('api', {
  ...Object.fromEntries(['bookmarks', 'importCyberduck', 'list', 'password', 'publicCheck', 'download', 'upload', 'settings', 'retry', 'clear',
    'pickFolder', 'pickUpload', 'terminal', 'installUpdate'].map(n => [n, call(n)])),
  onTransfers: cb => ipcRenderer.on('transfers', (_, s) => cb(s)),
  onUpdate: cb => ipcRenderer.on('update', (_, u) => cb(u)),
  pathFor: file => webUtils.getPathForFile(file),
})
