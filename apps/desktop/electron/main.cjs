const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { Backend, commands } = require('./backend.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'dssh', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);

let mainWindow;
let backend;
let shuttingDown = false;
const previews = new Map();
const guards = new Map();
const devUrl = !app.isPackaged && process.env.DSSH_DEV_URL;
const origin = devUrl ? new URL(devUrl).origin : 'dssh://app';
const trusted = url => {
  try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}` === origin; }
  catch { return false; }
};

function configureWindow(win) {
  const windowId = win.id;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!trusted(url)) event.preventDefault();
  });
  win.on('close', event => {
    if (guards.has(win.id) && !shuttingDown && !win.webContents.isCrashed()) {
      event.preventDefault();
      win.webContents.send('dssh:event', 'desktop://close-requested', null);
    }
  });
  win.on('closed', () => {
    guards.delete(windowId); previews.delete(windowId);
    if (win === mainWindow) { mainWindow = null; shuttingDown = true; app.quit(); }
  });
}

async function makeWindow({ preview, width = 1280, height = 800 } = {}) {
  const win = new BrowserWindow({
    width, height, minWidth: preview ? 240 : 900, minHeight: preview ? 200 : 600,
    title: preview ? 'dssh 图片预览' : 'dssh', show: false,
    backgroundColor: '#1a1b26', icon: path.join(__dirname, 'icons/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  configureWindow(win);
  win.webContents.on('did-start-loading', () => guards.delete(win.id));
  if (preview) previews.set(win.id, preview);
  else mainWindow = win;
  win.once('ready-to-show', () => win.show());
  await win.loadURL(`${devUrl || 'dssh://app/index.html'}${preview ? `#/preview/${preview.id}` : ''}`);
  return win;
}

ipcMain.handle('dssh:invoke', async (event, command, args = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || event.senderFrame !== event.sender.mainFrame || !trusted(event.senderFrame.url)) throw new Error('Untrusted desktop request');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid arguments');
  if (command === 'desktop_close') { setImmediate(() => { if (!win.isDestroyed()) win.close(); }); return; }
  if (command === 'desktop_destroy') {
    setImmediate(() => {
      if (win === mainWindow) { shuttingDown = true; app.quit(); }
      else if (!win.isDestroyed()) win.destroy();
    });
    return;
  }
  if (command === 'take_pending_image') {
    const preview = previews.get(win.id);
    if (!preview || preview.id !== args.id) throw new Error('图片不存在');
    // Keep until window closes: React StrictMode can mount the preview twice.
    return preview.dataUrl;
  }
  if (win !== mainWindow) throw new Error('Preview windows cannot access SSH or local files');
  if (command === 'desktop_close_guard') {
    if (typeof args.token !== 'string') throw new Error('Invalid close subscription');
    const subscriptions = guards.get(win.id) || new Set();
    if (args.enabled) subscriptions.add(args.token); else subscriptions.delete(args.token);
    if (subscriptions.size) guards.set(win.id, subscriptions); else guards.delete(win.id);
    return;
  }
  if (command === 'desktop_open_dialog') {
    const options = args.options || {};
    const result = await dialog.showOpenDialog(win, {
      title: options.title, defaultPath: options.defaultPath, filters: options.filters,
      properties: [options.directory ? 'openDirectory' : 'openFile', ...(options.multiple ? ['multiSelections'] : [])],
    });
    return result.canceled ? null : options.multiple ? result.filePaths : result.filePaths[0] ?? null;
  }
  if (command === 'desktop_confirm') {
    const options = args.options || {};
    const result = await dialog.showMessageBox(win, {
      message: String(args.message), title: options.title || 'dssh',
      type: ['warning', 'error', 'info'].includes(options.kind) ? options.kind : 'question',
      buttons: [options.cancelLabel || '取消', options.okLabel || '确定'], defaultId: 0, cancelId: 0, noLink: true,
    });
    return result.response === 1;
  }
  if (command === 'open_image_preview') {
    if (typeof args.dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(args.dataUrl) || args.dataUrl.length > 64 * 1024 * 1024) throw new Error('Invalid preview image');
    const dimension = (value, extra, min, max) => Math.min(max, Math.max(min, (Number.isFinite(value) ? value : min) + extra));
    await makeWindow({ preview: { id: randomUUID(), dataUrl: args.dataUrl },
      width: dimension(args.width, 48, 320, 1400), height: dimension(args.height, 88, 240, 1000) });
    return;
  }
  if (!commands.has(command)) throw new Error(`Unknown command: ${command}`);
  return backend.call(command, args);
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    app.setAppUserModelId('dev.dssh.app');
    // Preserve Tauri's config location and keyring service names for existing installations.
    const configDir = (!app.isPackaged && process.env.DSSH_CONFIG_DIR) || path.join(app.getPath('appData'), 'dev.dssh.app');
    const executable = path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
      app.isPackaged ? 'backend' : 'backend/target/release', process.platform === 'win32' ? 'dssh-backend.exe' : 'dssh-backend');
    backend = new Backend(executable, configDir);
    const activeSessions = new Set();
    const originalCall = backend.call.bind(backend);
    backend.call = async (command, args) => {
      const result = await originalCall(command, args);
      if (command === 'ssh_connect') activeSessions.add(result);
      if (command === 'ssh_disconnect') activeSessions.delete(args.sessionId);
      return result;
    };
    backend.on('event', (name, payload) => {
      const exit = name.match(/^ssh:\/\/(.+)\/exit$/);
      if (exit) activeSessions.delete(exit[1]);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dssh:event', name, payload);
    });
    backend.on('failed', error => {
      if (shuttingDown) return;
      for (const id of activeSessions) {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dssh:event', `ssh://${id}/exit`, -1);
      }
      activeSessions.clear();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dssh:event', 'desktop://backend-failed', error.message);
      dialog.showErrorBox('SSH 后台停止', error.message);
    });
    const dist = path.resolve(__dirname, '../dist');
    protocol.handle('dssh', request => {
      const url = new URL(request.url);
      const file = path.resolve(dist, '.' + decodeURIComponent(url.pathname));
      if (url.host !== 'app' || !file.startsWith(dist + path.sep)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).href);
    });
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(contents === mainWindow?.webContents && trusted(details.requestingUrl || contents.getURL()) &&
        ['clipboard-read', 'clipboard-sanitized-write', 'notifications'].includes(permission));
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
      contents === mainWindow?.webContents && trusted(requestingOrigin) && ['clipboard-read', 'clipboard-sanitized-write', 'notifications'].includes(permission));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      { label: '视图', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] },
    ]));
    await makeWindow();
  }).catch(error => { dialog.showErrorBox('无法启动 dssh', error.message); shuttingDown = true; app.quit(); });
  app.on('before-quit', event => {
    if (!shuttingDown && mainWindow && !mainWindow.isDestroyed() && guards.has(mainWindow.id)) {
      event.preventDefault(); mainWindow.close();
    }
  });
  app.on('will-quit', () => { shuttingDown = true; backend?.stop(); });
  app.on('window-all-closed', () => { shuttingDown = true; app.quit(); });
}
