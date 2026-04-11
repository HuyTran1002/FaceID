const { app, BrowserWindow, Tray, Menu, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const { PythonShell } = require('python-shell');
const fs = require('fs');

let mainWindow;
let tray = null;
let isLocked = true;
let pythonExit = false;

// Config Management (Passwords)
const configPath = path.join(app.getPath('userData'), 'config.json');
let config = {
    adminPass: '123456',
    secretPass: '999999'
};

function loadConfig() {
    if (fs.existsSync(configPath)) {
        try {
            const data = fs.readFileSync(configPath, 'utf8');
            config = { ...config, ...JSON.parse(data) };
        } catch (e) {
            console.error("Failed to load config:", e);
        }
    } else {
        saveConfig();
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error("Failed to save config:", e);
    }
}

loadConfig();

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // Nếu người dùng cố gắng mở instance thứ hai, hãy hiện app và Khóa ngay lập tức
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            lockApp(); 
            mainWindow.focus();
        }
    });
}

// Initialize Python Shell
const pyOptions = {
    mode: 'json',
    pythonPath: 'py', // Using 'py' as verified earlier
    pythonOptions: ['-u'], // get print results in real-time
    scriptPath: __dirname,
};

let pyshell = new PythonShell('face_logic.py', pyOptions);

pyshell.on('message', function (message) {
    if (mainWindow) {
        mainWindow.webContents.send('python-result', message);
    }
});

pyshell.on('stderr', function (stderr) {
    console.log('PYTHON DEBUG:', stderr);
});

pyshell.on('error', function (err) {
    console.error('PYTHON ERROR:', err);
});

function createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    mainWindow = new BrowserWindow({
        width: width,
        height: height,
        fullscreen: true,
        alwaysOnTop: true,
        frame: false,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        closable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        },
        icon: path.join(__dirname, 'assets/icon.png')
    });

    mainWindow.loadFile('index.html');

    // Prevent closing with Alt+F4
    mainWindow.on('close', (e) => {
        if (isLocked) {
            e.preventDefault();
        }
    });

    // Handle being pushed back by other windows
    mainWindow.on('blur', () => {
        if (isLocked) {
            mainWindow.setAlwaysOnTop(true, 'screen-saver');
            mainWindow.focus();
        }
    });
}

function createTray() {
    const iconPath = path.join(__dirname, 'assets/icon.png');
    tray = new Tray(iconPath);
    
    const contextMenu = Menu.buildFromTemplate([
        { 
            label: 'FaceID Security', 
            enabled: false 
        },
        { type: 'separator' },
        { 
            label: 'Mở ứng dụng', 
            click: () => {
                mainWindow.show();
                mainWindow.setFullScreen(true);
            } 
        },
        { 
            label: 'Khóa ngay lập tức', 
            click: () => {
                lockApp();
            } 
        },
        { type: 'separator' },
        { 
            label: 'Thoát hoàn toàn app', 
            click: () => {
                mainWindow.show();
                mainWindow.webContents.send('request-exit-pass');
            } 
        }
    ]);

    tray.setToolTip('FaceID App - Đang chạy ngầm');
    tray.setContextMenu(contextMenu);

    // Xử lý click chuột trái
    tray.on('click', () => {
        mainWindow.show();
    });

    // Xử lý chuột phải rõ ràng cho Windows
    tray.on('right-click', () => {
        tray.popUpContextMenu(contextMenu);
    });
}

function lockApp() {
    isLocked = true;
    mainWindow.show();
    mainWindow.setFullScreen(true);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.webContents.send('app-locked');
}

function unlockApp() {
    isLocked = false;
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setFullScreen(false);
    mainWindow.hide();
    mainWindow.webContents.send('app-unlocked');
}

app.whenReady().then(() => {
    createWindow();
    createTray();

    // Phím tắt mở DevTools để debug
    globalShortcut.register('CommandOrControl+Shift+I', () => {
        if (mainWindow) {
            mainWindow.webContents.toggleDevTools();
        }
    });

    // Phím tắt thoát app (Ctrl + Alt + L)
    globalShortcut.register('CommandOrControl+Alt+L', () => {
        if (mainWindow) {
            mainWindow.webContents.send('request-exit-pass');
        }
    });

    // Phím tắt khóa màn hình (Ctrl + Alt + K)
    globalShortcut.register('CommandOrControl+Alt+K', () => {
        lockApp();
    });

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

ipcMain.on('unlock-success', () => {
    unlockApp();
});

ipcMain.on('request-lock', () => {
    lockApp();
});

ipcMain.on('get-config', (event) => {
    event.reply('config-result', { adminPass: config.adminPass, secretPass: config.secretPass });
});

ipcMain.on('update-config', (event, newConfig) => {
    config = { ...config, ...newConfig };
    saveConfig();
    event.reply('update-config-success');
});

ipcMain.on('verify-password', (event, { password, type }) => {
    // type: 'admin' or 'secret'
    let isValid = false;
    if (type === 'admin') {
        isValid = (password === config.adminPass || password === config.secretPass);
    } else {
        isValid = (password === config.secretPass);
    }
    event.reply('verify-password-result', { isValid, type });
});

ipcMain.on('exit-app-verified', () => {
    isLocked = false;
    globalShortcut.unregisterAll();
    // Bỏ qua tất cả các sự kiện 'close' và đóng ngay lập tức
    app.exit(0);
});

ipcMain.on('process-image-python', (event, data) => {
    if (pyshell) {
        // Gửi kèm đường dẫn userData để Python biết chỗ lưu/đọc file
        data.user_data_path = app.getPath('userData');
        pyshell.send(data);
    }
});

ipcMain.on('check-registration-status', (event) => {
    const userDataPath = app.getPath('userData');
    const pythonRegPath = path.join(userDataPath, 'registered_face.json');
    let hasPythonReg = false;
    if (fs.existsSync(pythonRegPath)) {
        const data = JSON.parse(fs.readFileSync(pythonRegPath, 'utf8'));
        hasPythonReg = Array.isArray(data) ? data.length > 0 : (data.encoding ? true : false);
    }
    event.reply('registration-status-result', { hasPythonReg });
});

ipcMain.on('emergency-exit', () => {
    // Show password modal for exit
    if (mainWindow) {
        mainWindow.webContents.send('request-exit-pass');
    }
});

app.on('window-all-closed', function () {
    pythonExit = true;
    if (pyshell) pyshell.end();
    if (process.platform !== 'darwin') app.quit();
});
