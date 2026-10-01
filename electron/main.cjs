'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

// ─── Paths ────────────────────────────────────────────────────────────────────
const IS_PACKAGED = app.isPackaged;
const ROOT = IS_PACKAGED ? process.resourcesPath : path.join(__dirname, '..');
const SERVER_SCRIPT = path.join(ROOT, 'dist-server', 'server.cjs');
const DIST_PATH     = path.join(ROOT, 'dist');
const PUBLIC_PATH   = path.join(ROOT, 'public');
const SERVER_PORT   = 3847;

// ─── Server process handle ────────────────────────────────────────────────────
let serverProc = null;
let mainWindow  = null;

// ─── Start the bundled Express server via Electron utilityProcess ─────────────
function startServer() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SERVER_SCRIPT)) {
      return reject(new Error(
        'Server bundle not found.\nExpected: ' + SERVER_SCRIPT +
        '\n\nRun build-windows.ps1 to regenerate.'
      ));
    }

    const { utilityProcess } = require('electron');

    serverProc = utilityProcess.fork(SERVER_SCRIPT, [], {
      env: {
        ...process.env,
        NODE_ENV:   'production',
        PORT:       String(SERVER_PORT),
        BIND_HOST:  '127.0.0.1',
        DIST_PATH:  DIST_PATH,
        PUBLIC_PATH: PUBLIC_PATH,
      },
      serviceName: 'iictd-server',
    });

    serverProc.on('spawn', () => resolve());
    serverProc.on('exit', (code) => {
      if (code && code !== 0 && mainWindow) {
        console.error('[server] exited with code', code);
      }
    });
  });
}

// ─── Poll until the local server is ready ────────────────────────────────────
function waitForServer(maxMs = 25000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + maxMs;
    const check = () => {
      const req = http.get(
        `http://127.0.0.1:${SERVER_PORT}/api/health`,
        { timeout: 1000 },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => {
            try {
              const json = JSON.parse(body);
              if (json.status === 'ok') return resolve(true);
            } catch {}
            scheduleRetry();
          });
        }
      );
      req.on('error', scheduleRetry);
      req.on('timeout', () => { req.destroy(); scheduleRetry(); });
    };
    const scheduleRetry = () => {
      if (Date.now() < deadline) setTimeout(check, 250);
      else resolve(false);
    };
    check();
  });
}

// ─── Loading splash (frameless dark window shown while server boots) ──────────
function createLoadingWindow() {
  const win = new BrowserWindow({
    width: 360,
    height: 220,
    frame: false,
    transparent: false,
    resizable: false,
    alwaysOnTop: true,
    center: true,
    backgroundColor: '#1e3a5f',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    skipTaskbar: true,
  });
  win.loadFile(path.join(__dirname, 'loading.html'));
  return win;
}

// ─── Main application window ──────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 960,
    minHeight: 600,
    title: 'IICTD Process Automation System (IPAS)',
    show: false,
    backgroundColor: '#f8f9fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  // Remove default menu bar
  Menu.setApplicationMenu(null);

  mainWindow.loadURL(`http://127.0.0.1:${SERVER_PORT}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // External links → system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${SERVER_PORT}`)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── IPC — exposed to renderer via preload ────────────────────────────────────
ipcMain.handle('get-server-port', () => SERVER_PORT);
ipcMain.handle('get-platform', () => process.platform);

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  const loadingWin = createLoadingWindow();

  try {
    await startServer();
    const ready = await waitForServer(25000);

    if (!ready) {
      loadingWin.close();
      dialog.showErrorBox(
        'IICTD — Server Timeout',
        'The application server did not start within 25 seconds.\n\n' +
        'Make sure you are not running another service on port ' + SERVER_PORT + '.'
      );
      app.quit();
      return;
    }
  } catch (err) {
    loadingWin.close();
    dialog.showErrorBox('IICTD — Startup Error', String(err.message || err));
    app.quit();
    return;
  }

  createMainWindow();
  loadingWin.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (serverProc) {
    try { serverProc.kill(); } catch {}
  }
});

app.on('activate', () => {
  if (!mainWindow) createMainWindow();
});
