const { contextBridge, ipcRenderer } = require('electron');
const { version } = require('./package.json');

// Puente seguro entre el proceso principal (donde vive electron-updater) y la
// página (inkora-3d-modeler-v10-corregido.html). Si el HTML se abre en un
// navegador normal (sin Electron), este script nunca se carga — por eso el
// HTML siempre chequea `window.inkoraUpdater` antes de usarlo, y no rompe
// nada fuera de la app instalada.
contextBridge.exposeInMainWorld('inkoraUpdater', {
  onStatus: (callback) => {
    ipcRenderer.on('updater-status', (_event, data) => callback(data));
  },
  download: () => ipcRenderer.send('updater-download'),
  install: () => ipcRenderer.send('updater-install'),
});

contextBridge.exposeInMainWorld('inkoraAppInfo', {
  version,
});

// `data` abre un unico 3MF; `files` abre un conjunto que debe quedar junto
// en la misma carpeta (OBJ + su MTL), marcando cual se abre con `open: true`.
contextBridge.exposeInMainWorld('inkoraSlicer', {
  open: ({ slicer, filename, data, files }) => ipcRenderer.invoke('slicer-open-3mf', {
    slicer,
    filename,
    data,
    files,
  }),
});
