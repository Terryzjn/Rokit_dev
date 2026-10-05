const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capturePicker', {
  onSources: (callback) => {
    const listener = (_event, sources) => callback(sources);
    ipcRenderer.on('capture-picker:sources', listener);
    return () => ipcRenderer.removeListener('capture-picker:sources', listener);
  },
  selectSource: (sourceId) => ipcRenderer.send('capture-source:selected', sourceId)
});