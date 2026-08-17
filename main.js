const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, protocol } = require('electron');
const path = require('path');

app.name = 'diy-phone-link';
if (process.platform === 'linux') {
    app.desktopFileName = 'diy-phone-link.desktop';
}

const { initKDEConnectBridge, setMainWindow } = require('./src/ipc/bridge');

let mainWindow = null;
let tray = null;
let bridgeInitialized = false;

// const isDev = process.env.NODE_ENV !== 'production';
const isDev = !app.isPackaged;

// Privileged schemes for serving phone photo thumbnails/previews and the live
// webcam preview frame to the renderer. Must be registered before app ready.
protocol.registerSchemesAsPrivileged([
    {
        scheme: 'photo-cache',
        privileges: { standard: true, secure: true, stream: true, bypassCSP: true }
    },
    {
        scheme: 'webcam-frame',
        privileges: { standard: true, secure: true, stream: true, bypassCSP: true }
    }
]);

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        icon: path.join(__dirname, 'build', 'icon.png'),
        minWidth: 900,
        minHeight: 600,
        frame: false, // Custom acrylic frameless window
        // titleBarStyle is only supported on Windows/macOS; on Linux the custom
        // titlebar + frame:false above is enough (the standard frame is hidden).
        ...(process.platform === 'win32' || process.platform === 'darwin' ? { titleBarStyle: 'hidden' } : {}),
        backgroundColor: '#0f172a', // Dark theme slate-900 background
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            // Keep renderer timers (e.g. the dock-embed timer) running even while
            // scrcpy's window has focus, so docking happens without needing a click.
            backgroundThrottling: false
        },
        show: false
    });

    if (bridgeInitialized && setMainWindow) {
        setMainWindow(mainWindow);
    }

    // Load URL
    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
        // mainWindow.webContents.openDevTools({ mode: 'detach' });
    } else {
        mainWindow.loadFile(path.join(__dirname, 'dist/index.html'));
    }

    // Smooth show once ready
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Crash diagnostics: a "black screen" is usually a dead renderer, so log the reason
    // instead of leaving the user (and us) in the dark.
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
        console.error('[main] renderer process gone:', JSON.stringify(details));
    });
    mainWindow.webContents.on('did-crash', () => {
        console.error('[main] webContents crashed');
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
        console.error('[main] did-fail-load:', code, desc);
    });

    // Prevent window from killing the app; hide it to tray instead
    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    // Handle window closed
    mainWindow.on('closed', () => {
        mainWindow = null;
        if (bridgeInitialized && setMainWindow) {
            setMainWindow(null);
        }
    });

}

function createTray() {
    // Create simple native tray icon
    const iconPath = path.join(__dirname, 'build', 'icon.png');
    let icon = nativeImage.createFromPath(iconPath);

    if (icon.isEmpty()) {
        // Fallback placeholder if icon is not found
        icon = nativeImage.createFromDataURL(
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAuSURBVHgB7cxBDQAACAIg2f6VzWALjHwN0JJyCYgISQiJCEkIiQhJCIkISQgJ8wc2lQYRT1A2WwAAAABJRU5ErkJggg=='
        );
    } else {
        icon = icon.resize({ width: 18, height: 18 });
    }


    tray = new Tray(icon);
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Smart Device Link', enabled: false },
        { type: 'separator' },
        {
            label: 'Open Dashboard',
            click: () => {
                if (mainWindow) {
                    if (mainWindow.isMinimized()) mainWindow.restore();
                    mainWindow.show(); // <-- ADD THIS LINE
                    mainWindow.focus();
                } else {
                    createWindow();
                }
            }
        },
        {
            label: 'Device Status: Disconnected',
            enabled: false
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                app.isQuitting = true;
                app.quit();
            }
        }
    ]);

    tray.setToolTip('Smart Device Link');
    tray.setContextMenu(contextMenu);

    tray.on('double-click', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show(); // <-- ADD THIS LINE
            mainWindow.focus();
        }
    });
}

// Window control IPC Handlers
ipcMain.on('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
    if (mainWindow) {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow.maximize();
        }
    }
});

ipcMain.on('window-close', () => {
    if (mainWindow) mainWindow.close();
});

ipcMain.handle('get-app-version', () => app.getVersion());

// App lifecycle
app.whenReady().then(() => {
    createWindow();
    createTray();
    initKDEConnectBridge(mainWindow);
    bridgeInitialized = true;

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
