const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const path = require('path');

// En mi PC de desarrollo (app.isPackaged === false), apunta al HTML real del
// proyecto para que cada doble-click abra la última versión guardada sin
// recompilar el .exe. En cualquier otra PC corriendo desde el código fuente
// (sin instalar), cae a la ruta relativa. Una vez instalado vía NSIS, el HTML
// viaja empaquetado dentro de resources/ (ver "extraResources" en
// package.json) y se carga desde ahí — process.resourcesPath solo existe una
// vez empaquetado, por eso antes esto rompía en cualquier PC que no fuera la mía.
const DEV_HTML = 'C:/Users/compu/Desktop/INKORA IA/INKORA 3D Modeler/inkora-3d-modeler-v10-corregido.html';
const SOURCE_HTML = path.join(__dirname, '..', 'inkora-3d-modeler-v10-corregido.html');
const BUNDLED_HTML = path.join(process.resourcesPath, 'inkora-3d-modeler-v10-corregido.html');

function resolveAppHtml() {
  if (!app.isPackaged) {
    if (fs.existsSync(DEV_HTML)) return DEV_HTML;
    if (fs.existsSync(SOURCE_HTML)) return SOURCE_HTML;
  }
  return BUNDLED_HTML;
}

const APP_HTML = resolveAppHtml();

let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#080809',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  Menu.setApplicationMenu(null);
  win.loadFile(APP_HTML);
  watchForChanges(win);
  mainWindow = win;
}

// Auto-reload: mientras la ventana está abierta, si el HTML del proyecto
// cambia en disco (porque Claude editó el archivo), recarga sola sin que
// haya que cerrar/reabrir la app. Debounce porque un guardado puede
// disparar más de un evento 'change' seguido.
function watchForChanges(win) {
  let pending = null;
  try {
    fs.watch(APP_HTML, () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.reloadIgnoringCache();
      }, 250);
    });
  } catch (err) {
    console.error('No se pudo observar cambios en el archivo:', err);
  }
}

// ── Auto-actualización (electron-updater + GitHub Releases) ─────────────────
// El botón/tarjeta de "hay una versión nueva" vive en el HTML (ver
// inkora-3d-modeler-v10-corregido.html, sección updater). Acá solo se detecta
// la versión nueva y se avisa — la descarga real ocurre recién cuando el
// usuario aprieta el botón (autoDownload=false), tal como se pidió.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

function sendStatus(status, extra = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater-status', { status, ...extra });
  }
}

autoUpdater.on('update-available', (info) => sendStatus('available', { version: info.version }));
autoUpdater.on('update-not-available', () => sendStatus('none'));
autoUpdater.on('download-progress', (p) => sendStatus('downloading', { percent: Math.round(p.percent) }));
autoUpdater.on('update-downloaded', () => sendStatus('downloaded'));
autoUpdater.on('error', (err) => sendStatus('error', { message: err?.message || String(err) }));

ipcMain.on('updater-download', () => {
  autoUpdater.downloadUpdate().catch((err) => sendStatus('error', { message: err?.message || String(err) }));
});
ipcMain.on('updater-install', () => {
  autoUpdater.quitAndInstall();
});

app.whenReady().then(() => {
  createWindow();
  // Chequeo silencioso al arrancar. Si no hay conexión o no hay releases
  // todavía, autoUpdater.on('error') lo captura sin romper la app.
  autoUpdater.checkForUpdates().catch(() => {});
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
