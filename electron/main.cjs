const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require('electron');

let desktopHttpServer;
let mainWindow;
let isQuitting = false;

const getCredentialFilePath = () => path.join(app.getPath('userData'), 'provider-credentials.bin');

const loadProviderCredentials = () => {
  const credentialPath = getCredentialFilePath();
  if (!fs.existsSync(credentialPath) || !safeStorage.isEncryptionAvailable()) return {};
  try {
    const encrypted = fs.readFileSync(credentialPath);
    const parsed = JSON.parse(safeStorage.decryptString(encrypted));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.error('Could not read encrypted provider credentials:', error?.message || String(error));
    return {};
  }
};

const saveProviderCredentials = credentials => {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const sanitized = Object.fromEntries(
    Object.entries(credentials || {})
      .filter(([providerId, apiKey]) => providerId && typeof apiKey === 'string' && apiKey)
  );
  const credentialPath = getCredentialFilePath();
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
  fs.writeFileSync(credentialPath, safeStorage.encryptString(JSON.stringify(sanitized)));
  return true;
};

const isTrustedRenderer = event => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  try {
    const pageUrl = new URL(event.sender.getURL());
    return pageUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(pageUrl.hostname);
  } catch {
    return false;
  }
};

const requireTrustedRenderer = event => {
  if (!isTrustedRenderer(event)) throw new Error('桌面接口仅允许当前共振画布窗口使用。');
};

ipcMain.on('desktop-credentials:load', event => {
  event.returnValue = isTrustedRenderer(event) ? loadProviderCredentials() : {};
});

ipcMain.on('desktop-credentials:save', (event, credentials) => {
  try {
    event.returnValue = isTrustedRenderer(event) && saveProviderCredentials(credentials);
  } catch (error) {
    console.error('Could not save encrypted provider credentials:', error?.message || String(error));
    event.returnValue = false;
  }
});

ipcMain.handle('desktop:choose-directory', async event => {
  requireTrustedRenderer(event);
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: '选择图片保存文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const directoryPath = fs.realpathSync(result.filePaths[0]);
  return { path: directoryPath, name: path.basename(directoryPath) || directoryPath };
});

ipcMain.handle('desktop:save-generated-image', async (event, payload) => {
  requireTrustedRenderer(event);
  const requestedDirectory = typeof payload?.directoryPath === 'string' ? payload.directoryPath : '';
  const filename = path.basename(String(payload?.filename || ''));
  const data = payload?.data;
  if (!requestedDirectory || !filename || filename === '.' || filename === '..' || filename.length > 240 || !data) {
    throw new Error('保存图片参数无效。');
  }
  const directoryPath = fs.realpathSync(requestedDirectory);
  if (!fs.statSync(directoryPath).isDirectory()) throw new Error('图片保存目录不可用。');
  const bytes = data instanceof Uint8Array
    ? Buffer.from(data)
    : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  fs.writeFileSync(path.join(directoryPath, filename), bytes);
  return { saved: true };
});

const getRequestedPort = () => {
  const inlineArg = process.argv.find(arg => arg.startsWith('--port='));
  const portArgIndex = process.argv.indexOf('--port');
  const rawValue = inlineArg?.slice('--port='.length)
    ?? (portArgIndex >= 0 ? process.argv[portArgIndex + 1] : undefined);
  if (rawValue === undefined) return 0;
  const port = Number(rawValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid --port value: ${rawValue}`);
  return port;
};

const listen = (server, port) => new Promise((resolve, reject) => {
  const onError = error => reject(error);
  server.once('error', onError);
  server.listen(port, '127.0.0.1', () => {
    server.off('error', onError);
    resolve();
  });
});

const getServerAddress = () => {
  const address = desktopHttpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Local canvas server did not expose a TCP address.');
  return `http://127.0.0.1:${address.port}`;
};

const startLocalCanvasServer = async () => {
  if (desktopHttpServer) return getServerAddress();
  const root = fs.realpathSync(app.getAppPath());
  const publicDirectory = path.join(root, 'dist');
  if (!fs.existsSync(path.join(publicDirectory, 'index.html'))) {
    throw new Error(`Desktop build output is missing: ${path.join(publicDirectory, 'index.html')}`);
  }
  const companionUrl = pathToFileURL(path.join(root, 'server', 'desktop-companion.mjs')).href;
  const { createDesktopCompanion, DESKTOP_UPSTREAM } = await import(companionUrl);
  const upstream = String(process.env.RESONANTOR_SERVER_URL || DESKTOP_UPSTREAM).trim();
  const projectRoot = path.join(app.getPath('desktop'), '共智体画布工程');
  desktopHttpServer = createDesktopCompanion({ publicDirectory, projectRoot, upstream });
  try {
    await listen(desktopHttpServer, getRequestedPort());
  } catch (error) {
    desktopHttpServer = null;
    throw error;
  }
  return getServerAddress();
};

const createMainWindow = async () => {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }
  const serverUrl = await startLocalCanvasServer();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(serverUrl);
};

const closeLocalCanvasServer = async () => {
  const server = desktopHttpServer;
  desktopHttpServer = null;
  if (!server) return;
  await new Promise(resolve => {
    server.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
        console.error('Could not close local canvas server:', error.message || String(error));
      }
      resolve();
    });
  });
};

app.whenReady().then(async () => {
  app.setAppUserModelId('com.xtapnow.canvas3004');
  try {
    await createMainWindow();
  } catch (error) {
    dialog.showErrorBox('共振画布启动失败', error?.stack || String(error));
    await closeLocalCanvasServer();
    app.exit(1);
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length > 0) return;
  void createMainWindow().catch(error => dialog.showErrorBox('共振画布启动失败', error?.stack || String(error)));
});

app.on('before-quit', event => {
  if (isQuitting || !desktopHttpServer) return;
  isQuitting = true;
  event.preventDefault();
  closeLocalCanvasServer().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
