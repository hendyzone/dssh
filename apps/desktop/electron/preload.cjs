const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Never expose ipcRenderer or its event objects to web content.
contextBridge.exposeInMainWorld('dssh', {
  invoke: (command, args) => ipcRenderer.invoke('dssh:invoke', command, args),
  listen: (name, handler) => {
    const listener = (_event, eventName, payload) => { if (eventName === name) handler(payload); };
    ipcRenderer.on('dssh:event', listener);
    return () => ipcRenderer.removeListener('dssh:event', listener);
  },
  filePath: file => webUtils.getPathForFile(file),
});
