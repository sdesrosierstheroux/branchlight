import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { chooseStartupRepository, defaultRepositoryFolder } from '../repositories.mjs';
import { cleanLayout } from '../layout.mjs';
import { branchlightAppId, windowsLaunchIdentity, windowsAppDetails } from './windows-identity.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
app.setName('Branchlight');
app.setPath('userData', path.join(app.getPath('appData'), 'branchlight-git'));
if (process.platform === 'win32') app.setAppUserModelId(branchlightAppId);
let window;
let service;
let origin;
let preferences = {};
let settingsPath;
let saveQueue = Promise.resolve();

function savePreferences() {
    const data = JSON.stringify(preferences, null, 2);
    saveQueue = saveQueue.catch(() => {}).then(() => writeFile(settingsPath, data));
    return saveQueue;
}

function trusted(event) {
    return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
        new URL(event.senderFrame.url).origin === origin;
}

async function pickFolder() {
    const result = await dialog.showOpenDialog(window, {
        title: 'Open Git repository', properties: ['openDirectory'],
        defaultPath: preferences.repository || defaultRepositoryFolder,
    });
    return result.canceled ? null : result.filePaths[0];
}

async function start() {
    nativeTheme.themeSource = 'dark';
    await mkdir(app.getPath('userData'), { recursive: true });
    const identity = process.platform === 'win32' ? windowsLaunchIdentity({
        isPackaged: app.isPackaged, executablePath: process.execPath,
        portableDirectory: process.env.PORTABLE_EXECUTABLE_DIR, portableFile: process.env.PORTABLE_EXECUTABLE_FILE,
        applicationDirectory: path.dirname(directory), userData: app.getPath('userData'),
    }) : null;
    if (identity) await writeFile(identity.icon, await readFile(path.join(directory, 'branchlight.ico')));
    settingsPath = path.join(app.getPath('userData'), 'preferences.json');
    try {
        const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
        if (typeof saved?.repository === 'string') preferences.repository = saved.repository;
        preferences.layout = cleanLayout(saved?.layout);
    } catch {}
    const requested = process.argv.slice(app.isPackaged ? 1 : 2).find(value => !value.startsWith('-'));
    const root = await chooseStartupRepository({ requested, saved: preferences.repository });
    if (root) {
        preferences.repository = root;
        await savePreferences();
    }
    const { server, token } = await createApp(root, { onRepositoryOpened: async next => {
        preferences.repository = next;
        await savePreferences();
    } });
    service = server;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    window = new BrowserWindow({
        width: 1540, height: 960, minWidth: 1024, minHeight: 640,
        backgroundColor: '#20212b', title: 'Branchlight', show: false,
        icon: identity?.icon || path.join(directory, 'branchlight.ico'),
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(directory, 'preload.cjs'),
            nodeIntegration: false, contextIsolation: true, sandbox: true,
            webSecurity: true, webviewTag: false,
        },
    });
    if (identity) window.setAppDetails(windowsAppDetails(identity));
    const session = window.webContents.session;
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !(details.url.startsWith(`${origin}/`) || details.url.startsWith('data:image/')) });
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-frame-navigate', event => {
        const target = new URL(event.url);
        if (!event.isMainFrame || target.origin !== origin || target.pathname !== '/') event.preventDefault();
    });
    window.webContents.on('will-navigate', (event, url) => {
        const target = new URL(url);
        if (target.origin !== origin || target.pathname !== '/') event.preventDefault();
    });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    ipcMain.handle('choose-repository', event => trusted(event) ? pickFolder() : null);
    ipcMain.handle('load-layout', event => trusted(event) ? cleanLayout(preferences.layout) : {});
    ipcMain.handle('save-layout', async (event, layout) => {
        if (!trusted(event)) return false;
        preferences.layout = cleanLayout(layout);
        await savePreferences();
        return true;
    });
    ipcMain.handle('copy-commit-hash', (event, hash) => {
        if (trusted(event) && typeof hash === 'string' && /^[a-f0-9]{40,64}$/i.test(hash)) {
            clipboard.writeText(hash);
            return true;
        }
        return false;
    });
    const refresh = () => window?.webContents.send('refresh-application');
    window.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'F5') {
            event.preventDefault();
            refresh();
        }
    });
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => { window = null; });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: 'File', submenu: [
            { label: 'Switch repository…', accelerator: 'CmdOrCtrl+O', click: () => window?.webContents.send('open-repository') },
            { type: 'separator' }, { role: 'quit' },
        ] },
        { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
        { label: 'View', submenu: [
            { label: 'Refresh repository', accelerator: 'CmdOrCtrl+R', click: refresh },
            { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' },
        ] },
    ]));
    await window.loadURL(`${origin}/#${token}`);
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (window?.isMinimized()) window.restore();
        window?.show();
        window?.focus();
    });
    app.on('window-all-closed', () => app.quit());
    let closing = false;
    app.on('before-quit', event => {
        if (closing || !service) return;
        closing = true;
        event.preventDefault();
        service.closeAllConnections();
        service.close(() => saveQueue.catch(() => {}).finally(() => app.quit()));
    });
    app.whenReady().then(start).catch(error => {
        dialog.showErrorBox('Branchlight could not start', `${error.stderr || error.message}\n\nMake sure Git is installed and available on PATH.`);
        app.quit();
    });
}
