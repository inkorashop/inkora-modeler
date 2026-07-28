const electronApi = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Si el entorno hereda ELECTRON_RUN_AS_NODE=1, electron.exe ejecuta este
// archivo como Node y `require('electron')` devuelve la ruta del binario en
// vez de las APIs de Electron. Relanzamos limpiando esa variable para que el
// acceso directo local siga abriendo la app.
if (typeof electronApi === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronApi, [__dirname], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env,
  });
  child.unref();
  process.exit(0);
}

const { app, BrowserWindow, Menu, ipcMain } = electronApi;
const { autoUpdater } = require('electron-updater');

// En desarrollo, incluso si se abre electron/dist/win-unpacked desde el
// acceso directo local, cargar el HTML vivo del repo evita ejecutar una copia
// empaquetada vieja. En una instalacion real sin .git cerca, se usa el HTML
// empaquetado en resources/.
const HTML_FILENAME = 'inkora-3d-modeler-v10-corregido.html';
const BUNDLED_HTML = path.join(process.resourcesPath, HTML_FILENAME);

function findRepoHtmlNear(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const html = path.join(dir, HTML_FILENAME);
    const gitDir = path.join(dir, '.git');
    if (fs.existsSync(html) && fs.existsSync(gitDir)) return html;
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return null;
}

function resolveAppHtml() {
  const repoHtml = findRepoHtmlNear(__dirname) || findRepoHtmlNear(process.cwd());
  if (repoHtml) return repoHtml;
  return BUNDLED_HTML;
}

const APP_HTML = resolveAppHtml();

let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    title: `INKORA 3D Modeler v${app.getVersion()}`,
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

// Abrir el 3MF actual en laminadores instalados.
const SLICERS = {
  bambu: {
    label: 'Bambu Studio',
    winFolders: ['Bambu Studio', 'BambuStudio'],
    winExecutables: ['bambu-studio.exe', 'BambuStudio.exe', 'Bambu Studio.exe'],
    winCommands: ['bambu-studio.exe', 'BambuStudio.exe'],
    macApps: ['Bambu Studio', 'BambuStudio'],
    linuxCommands: ['bambu-studio', 'BambuStudio'],
  },
  orca: {
    label: 'Orca Slicer',
    winFolders: ['OrcaSlicer', 'Orca Slicer', 'Orca-Slicer'],
    winExecutables: ['orca-slicer.exe', 'OrcaSlicer.exe', 'Orca Slicer.exe'],
    winCommands: ['orca-slicer.exe', 'OrcaSlicer.exe'],
    macApps: ['Orca Slicer', 'OrcaSlicer'],
    linuxCommands: ['orca-slicer', 'OrcaSlicer'],
  },
};

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function slicerCandidates(slicer) {
  const cfg = SLICERS[slicer];
  if (!cfg) return [];

  if (process.platform === 'darwin') {
    return cfg.macApps.map(appName => ({ command: 'open', args: ['-a', appName] }));
  }

  if (process.platform === 'win32') {
    const baseDirs = unique([
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : null,
    ]);
    const paths = [];
    baseDirs.forEach(base => {
      cfg.winFolders.forEach(folder => {
        cfg.winExecutables.forEach(exe => {
          paths.push(path.join(base, folder, exe));
        });
      });
    });

    const existingPaths = unique(paths).filter(candidate => {
      try { return fs.existsSync(candidate); }
      catch { return false; }
    });

    return [
      ...existingPaths.map(command => ({ command, args: [] })),
      ...cfg.winCommands.map(command => ({ command, args: [] })),
    ];
  }

  return cfg.linuxCommands.map(command => ({ command, args: [] }));
}

function launchDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    child.once('error', err => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

async function openFileInSlicer(slicer, filePath) {
  const cfg = SLICERS[slicer];
  if (!cfg) throw new Error('Laminador no reconocido.');

  const candidates = slicerCandidates(slicer);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      await launchDetached(candidate.command, [...candidate.args, filePath]);
      return;
    } catch (err) {
      lastError = err;
    }
  }

  const err = new Error(`No encontre ${cfg.label} instalado. Instalalo en la ruta normal o agregalo al PATH para que INKORA pueda abrirlo directamente.`);
  err.code = 'SLICER_NOT_FOUND';
  err.cause = lastError;
  throw err;
}

function sanitize3MFName(name) {
  const raw = path.basename(String(name || 'inkora-model')).replace(/\.[^.]+$/, '');
  const clean = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return clean || 'inkora-model';
}

function bufferFromPayload(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new Error('No se recibieron datos 3MF validos.');
}

async function writeTemp3MF(payload) {
  const buffer = bufferFromPayload(payload?.data);
  if (!buffer.length) throw new Error('El 3MF generado esta vacio.');
  if (buffer.length > 250 * 1024 * 1024) throw new Error('El 3MF generado es demasiado grande para abrirlo automaticamente.');

  const tempDir = path.join(app.getPath('temp'), 'inkora-3d-modeler');
  await fs.promises.mkdir(tempDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 17);
  const filePath = path.join(tempDir, `${sanitize3MFName(payload?.filename)}-${stamp}.3mf`);
  await fs.promises.writeFile(filePath, buffer);
  return filePath;
}

// Auto-actualizacion (electron-updater + GitHub Releases).
// La tarjeta vive en el HTML; aca solo se detecta y se avisa.
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

ipcMain.handle('slicer-open-3mf', async (_event, payload) => {
  try {
    if (!payload || !SLICERS[payload.slicer]) {
      throw new Error('Laminador no reconocido.');
    }
    const filePath = await writeTemp3MF(payload);
    await openFileInSlicer(payload.slicer, filePath);
    return { ok: true, filePath };
  } catch (err) {
    console.error('No se pudo abrir el laminador:', err);
    return {
      ok: false,
      message: err?.message || 'No se pudo abrir el laminador.',
    };
  }
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
