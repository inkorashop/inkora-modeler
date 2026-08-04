const { contextBridge, ipcRenderer } = require('electron');

// La version llega como argumento del proceso, no leyendo package.json.
// El renderer corre con sandbox activado y ahi `require` solo resuelve los
// modulos que provee Electron: `require('./package.json')` lanzaba y hacia
// fallar el preload ENTERO, dejando la pagina sin inkoraSlicer, sin
// inkoraUpdater y sin inkoraAppInfo. El sintoma visible era "Abrir en
// laminador" siempre deshabilitado dentro de la app de escritorio.
const version = (process.argv
  .find(arg => arg.startsWith('--inkora-version=')) || '')
  .split('=')[1] || '';

// Puente seguro entre el proceso principal (donde vive electron-updater) y la
// página (index.html). Si el HTML se abre en un
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

// Cierre con cambios sin guardar. El proceso principal frena el cierre y
// avisa por aca; la pagina pregunta con su propio dialogo y recien cuando
// el usuario resuelve (guardo o descarto) confirma. Sin este puente —o sea,
// en el navegador— el HTML cae al aviso generico de `beforeunload`.
contextBridge.exposeInMainWorld('inkoraWindow', {
  onCloseRequest: (callback) => {
    ipcRenderer.on('app-close-request', () => callback());
  },
  confirmClose: () => ipcRenderer.send('app-close-confirmed'),
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
