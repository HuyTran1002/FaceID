const { app, BrowserWindow, Tray, Menu, ipcMain, screen, globalShortcut, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const readline = require('readline');
const { PythonShell } = require('python-shell');
const packageJson = require('./package.json');

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
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            lockApp(); 
            mainWindow.focus();
        }
    });
}

// --- HYBRID AI ENGINE INITIALIZATION ---
let pyshell = null; // Standard Mode
let pyProcess = null; // EXE Packaged Mode

function initPython() {
    try {
        if (app.isPackaged) {
            // PROD - Run from bundled Executable
            const exePath = path.join(process.resourcesPath, 'python_core', 'face_logic', 'face_logic.exe');
            if (fs.existsSync(exePath)) {
                // console.log("Khởi động Production AI Core (EXE)...");
                pyProcess = spawn(exePath, [], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true,
                    env: { ...process.env, PYTHONUNBUFFERED: "1" }
                });

                const rl = readline.createInterface({
                    input: pyProcess.stdout,
                    terminal: false
                });

                rl.on('line', (line) => {
                    if (line.trim()) {
                        try {
                            const result = JSON.parse(line);
                            if (mainWindow) mainWindow.webContents.send('python-result', result);
                        } catch (e) {
                            console.log('AI PARSE ERR:', line);
                        }
                    }
                });

                // Tắt log debug từ backend
                // pyProcess.stderr.on('data', (data) => console.log('AI DEBUG:', data.toString()));
                pyProcess.on('error', (err) => console.error('AI EXE ERR:', err));
                return;
            } else {
                console.error("Critical: Không tìm thấy face_logic.exe trong resourcesPath");
            }
        }
        
        // DEV - Run from .venv source
        // console.log("Khởi động Development AI Core (Script)...");
        const pyOptions = {
            mode: 'json',
            pythonPath: path.join(__dirname, '.venv', 'Scripts', 'python.exe'), 
            pythonOptions: ['-u'], 
            scriptPath: __dirname
        };
        pyshell = new PythonShell('face_logic.py', pyOptions);
        
        pyshell.on('message', (message) => {
            if (mainWindow) mainWindow.webContents.send('python-result', message);
        });
        // pyshell.on('stderr', (stderr) => console.log('AI DEV DEBUG:', stderr));
        pyshell.on('error', (err) => console.error('AI DEV ERROR:', err));
        
    } catch (e) {
        console.error("Failed to init AI Engine:", e);
    }
}

function createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    mainWindow = new BrowserWindow({
        width: width,
        height: height,
        fullscreen: true,
        alwaysOnTop: true,
        kiosk: true,
        frame: false,
        skipTaskbar: true,
        resizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, 'assets/icon.png')
    });

    mainWindow.loadFile('index.html');

    mainWindow.on('close', (e) => {
        if (isLocked) e.preventDefault();
    });

    mainWindow.on('blur', () => {
        if (isLocked) {
            mainWindow.setAlwaysOnTop(true, 'screen-saver');
            mainWindow.focus();
        }
    });
}

function createTray() {
    try {
        const iconPath = path.join(__dirname, 'assets/icon.png');
        tray = new Tray(iconPath);
        
        const contextMenu = Menu.buildFromTemplate([
            { label: 'FaceID Security (v' + packageJson.version + ')', enabled: false },
            { type: 'separator' },
            { label: 'Mở ứng dụng', click: () => { mainWindow.show(); mainWindow.setFullScreen(true); } },
            { label: 'Khóa ngay lập tức', click: () => { lockApp(); } },
            { type: 'separator' },
            { label: 'Kiểm tra bản cập nhật mới', click: () => { checkAndDownloadUpdate(); } },
            { type: 'separator' },
            { label: 'Thoát hoàn toàn app', click: () => { 
                mainWindow.show();
                mainWindow.webContents.send('request-exit-pass'); 
            } }
        ]);

        tray.setToolTip('FaceID App - Đang chạy ngầm');
        tray.setContextMenu(contextMenu);
        tray.on('click', () => { mainWindow.show(); });
    } catch (e) {
        console.error("Tray creation failed:", e);
    }
}

function lockApp() {
    isLocked = true;
    mainWindow.show();
    mainWindow.setFullScreen(true);
    mainWindow.setKiosk(true);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');

    // Khóa phím qua Python (Windows key, etc)
    const lockData = { mode: 'lock_keys' };
    if (app.isPackaged && pyProcess && !pyProcess.killed) pyProcess.stdin.write(JSON.stringify(lockData) + '\n');
    else if (pyshell) pyshell.send(lockData);

    // Chặn các phím thoát hiểm

    try { globalShortcut.register('Alt+Tab', () => { return false; }); } catch (e) {}
    try { globalShortcut.register('CommandOrControl+Esc', () => { return false; }); } catch (e) {}
    try { globalShortcut.register('Alt+F4', () => { return false; }); } catch (e) {}
    try { globalShortcut.register('CommandOrControl+W', () => { return false; }); } catch (e) {}

    mainWindow.webContents.send('app-locked');
}

function unlockApp() {
    isLocked = false;
    mainWindow.setKiosk(false);
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setFullScreen(false);
    mainWindow.hide();

    // Mở khóa phím qua Python
    const unlockData = { mode: 'unlock_keys' };
    if (app.isPackaged && pyProcess && !pyProcess.killed) pyProcess.stdin.write(JSON.stringify(unlockData) + '\n');
    else if (pyshell) pyshell.send(unlockData);

    // Mở khóa các phím thoát hiểm
    try { globalShortcut.unregister('Alt+Tab'); } catch (e) {}
    try { globalShortcut.unregister('CommandOrControl+Esc'); } catch (e) {}
    try { globalShortcut.unregister('Alt+F4'); } catch (e) {}
    try { globalShortcut.unregister('CommandOrControl+W'); } catch (e) {}

    mainWindow.webContents.send('app-unlocked');
}

app.whenReady().then(() => {
    createWindow();
    createTray();
    initPython(); 

    globalShortcut.register('CommandOrControl+Shift+I', () => {
        if (mainWindow) mainWindow.webContents.toggleDevTools();
    });

    globalShortcut.register('CommandOrControl+Alt+L', () => {
        if (mainWindow) mainWindow.webContents.send('request-exit-pass');
    });

    globalShortcut.register('CommandOrControl+Alt+K', () => {
        lockApp();
    });
});

ipcMain.on('unlock-success', () => { unlockApp(); });
ipcMain.on('request-lock', () => { lockApp(); });

ipcMain.on('update-settings', (event, { newAdminPass, newSecretPass }) => {
    if (newAdminPass) config.adminPass = newAdminPass;
    if (newSecretPass) config.secretPass = newSecretPass;
    saveConfig();
    event.reply('update-settings-result', { success: true });
});

ipcMain.on('verify-password', (event, { password, type }) => {
    let isValid = false;
    if (type === 'admin') {
        isValid = (password === config.adminPass || password === config.secretPass);
    } else if (type === 'secret') {
        isValid = (password === config.secretPass);
    }
    event.reply('verify-password-result', { isValid, type });
});

ipcMain.on('exit-app-verified', () => {
    isLocked = false;
    globalShortcut.unregisterAll();
    if (pyProcess) pyProcess.kill();
    app.exit(0);
});

ipcMain.on('process-image-python', (event, data) => {
    data.user_data_path = app.getPath('userData');
    if (app.isPackaged && pyProcess && !pyProcess.killed) {
        pyProcess.stdin.write(JSON.stringify(data) + '\n');
    } else if (pyshell) {
        pyshell.send(data);
    }
});

ipcMain.on('check-registration-status', (event) => {
    const userDataPath = app.getPath('userData');
    const pythonRegPath = path.join(userDataPath, 'registered_face.json');
    let hasPythonReg = false;
    if (fs.existsSync(pythonRegPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(pythonRegPath, 'utf8'));
            hasPythonReg = Array.isArray(data) ? data.length > 0 : !!data.encoding;
        } catch(e) {}
    }
    event.reply('registration-status-result', { hasPythonReg });
});
// --- AUTO UPDATE ENGINE ---
function checkAndDownloadUpdate() {
    const options = {
        hostname: 'api.github.com',
        path: '/repos/HuyTran1002/FaceID/releases/latest',
        method: 'GET',
        headers: { 'User-Agent': 'FaceID-AutoUpdater' }
    };

    https.get(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
            if (res.statusCode !== 200) {
                if (mainWindow) mainWindow.webContents.send('update-error', 'Không thể kết nối máy chủ GitHub.');
                return;
            }
            try {
                const release = JSON.parse(data);
                const latestVersion = release.tag_name.replace('v', '');
                
                if (latestVersion !== packageJson.version) {
                    const exeAsset = release.assets.find(a => a.name.endsWith('.exe'));
                    if (exeAsset) {
                        mainWindow.show();
                        mainWindow.webContents.send('update-available', {
                            version: latestVersion,
                            downloadUrl: exeAsset.browser_download_url,
                            releaseNotes: release.body || "Bản cập nhật mới giúp tăng cường bảo mật."
                        });
                    } else {
                        if (mainWindow) mainWindow.webContents.send('update-error', 'Bản cập nhật không đính kèm file thưc thi EXE.');
                    }
                } else {
                    if (mainWindow) {
                        mainWindow.show();
                        mainWindow.webContents.send('update-not-available');
                    }
                }
            } catch (e) {
                if (mainWindow) mainWindow.webContents.send('update-error', 'Lỗi xử lý Data GitHub.');
            }
        });
    }).on('error', (e) => {
        if (mainWindow) mainWindow.webContents.send('update-error', e.message);
    });
}

function installUpdate(downloadUrl) {
    const tempDir = os.tmpdir();
    const tempExePath = path.join(tempDir, 'FaceID_Update.exe');
    const updateBatPath = path.join(tempDir, 'faceid_install.bat');

    const file = fs.createWriteStream(tempExePath);

    const downloadFile = (url) => {
        https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                downloadFile(res.headers.location);
                return;
            }
            if (res.statusCode !== 200) {
                mainWindow.webContents.send('update-error', 'Lỗi server tải xuống: ' + res.statusCode);
                return;
            }

            const totalBytes = parseInt(res.headers['content-length'], 10);
            let downloadedBytes = 0;

            res.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                let percent = Math.round((downloadedBytes / totalBytes) * 100);
                mainWindow.webContents.send('update-progress', percent);
            });

            res.pipe(file);

            file.on('finish', () => {
                file.close();
                mainWindow.webContents.send('update-progress', 100);
                
                // Construct the autonomous script
                let currentExe = process.execPath;
                // If running in Dev (unpacked), we shouldn't replace electron.exe!
                if (!app.isPackaged) {
                    mainWindow.webContents.send('update-error', 'Không thể cài bản Update trong môi trường Develop.');
                    return;
                }

                // Delay 2 sec, suicide current file, replace with temp file, re-run, suicide bat file.
                const batContent = `
@echo off
echo Dang ap dung phien ban moi nhat...
timeout /t 2 /nobreak > NUL
del "${currentExe}"
copy /Y "${tempExePath}" "${currentExe}"
start "" "${currentExe}"
del "${updateBatPath}"
`;
                fs.writeFileSync(updateBatPath, batContent);
                
                // Detach cmd runner
                const updaterProc = spawn('cmd.exe', ['/c', updateBatPath], {
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: true
                });
                updaterProc.unref();
                
                // Shutdown cleanly to release the lock
                app.quit();
            });
        }).on('error', (err) => {
            fs.unlink(tempExePath, () => {});
            mainWindow.webContents.send('update-error', 'Lỗi đường truyền: ' + err.message);
        });
    };

    downloadFile(downloadUrl);
}

ipcMain.on('start-update', (event, { downloadUrl }) => {
    installUpdate(downloadUrl);
});

app.on('window-all-closed', function () {
    if (pyshell) pyshell.end();
    if (process.platform !== 'darwin') app.quit();
});
