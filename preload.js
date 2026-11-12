const { contextBridge, ipcRenderer, webUtils } = require('electron')

const call = name => (...args) => ipcRenderer.invoke(name, ...args)
contextBridge.exposeInMainWorld('api', {
  ...Object.fromEntries(['bookmarks', 'importCyberduck', 'saveBookmark', 'deleteBookmark', 'reorderBookmarks', 'list', 'password', 'publicCheck', 'download', 'upload', 'settings', 'retry', 'clear',
    'pickFolder', 'pickUpload', 'terminal', 'installUpdate', 'downloadAs', 'contextMenu', 'confirm'].map(n => [n, call(n)])),
  remoteSize: call('remote:size'),
  remoteRename: call('remote:rename'),
  remoteDelete: call('remote:delete'),
  remoteChmod: call('remote:chmod'),
  remoteAcl: call('remote:acl'),
  onTransfers: cb => ipcRenderer.on('transfers', (_, s) => cb(s)),
  onUpdate: cb => ipcRenderer.on('update', (_, u) => cb(u)),
  pathFor: file => webUtils.getPathForFile(file),
})
