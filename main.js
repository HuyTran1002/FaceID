const { app, BrowserWindow, Tray, Menu, ipcMain, screen, globalShortcut, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
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
function isNewerVersion(latest, current) {
    const l = latest.split('.').map(Number);
    const c = current.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (l[i] > (c[i] || 0)) return true;
        if (l[i] < (c[i] || 0)) return false;
    }
    return false;
}

function showSystemToast(title, body) {
    if (Notification.isSupported()) {
        new Notification({ title, body, icon: path.join(__dirname, 'assets/icon.png') }).show();
    }
}

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
                
                if (isNewerVersion(latestVersion, packageJson.version)) {
                    const exeAsset = release.assets.find(a => a.name.endsWith('.exe'));
                    if (exeAsset) {
                        mainWindow.show();
                        mainWindow.webContents.send('update-available', {
                            version: latestVersion,
                            downloadUrl: exeAsset.browser_download_url,
                            releaseNotes: release.body || "Bản cập nhật mới giúp tăng cường bảo mật."
                        });
                    } else {
                        showSystemToast("Lỗi cập nhật", "Không tìm thấy file EXE trong bản phát hành mới.");
                    }
                } else {
                    if (mainWindow) mainWindow.webContents.send('update-not-available', "Bạn đang sử dụng phiên bản mới nhất (v" + packageJson.version + ").");
                }
            } catch (e) {
                showSystemToast("Lỗi cập nhật", "Dữ liệu trả về từ GitHub không hợp lệ.");
            }
        });
    }).on('error', (e) => {
        showSystemToast("Lỗi cập nhật", "Không thể kết nối với GitHub. Vui lòng kiểm tra lại mạng.");
    });
}

function installUpdate(downloadUrl) {
    if (!app.isPackaged) {
        mainWindow.webContents.send('update-error', 'Không thể cập nhật trong môi trường Develop.');
        return;
    }

    // Xác định thư mục chứa file EXE gốc mà user đang chạy
    const portableExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const appDir = path.dirname(portableExe);
    const oldFileName = path.basename(portableExe);

    // Tải file mới về CÙNG thư mục, đặt tên theo version từ GitHub
    // Tạm dùng tên cố định, sẽ được rename nếu cần
    const newExePath = path.join(appDir, 'FaceID_Security_NEW.exe');

    // Xóa file tải dở nếu có từ lần trước
    try { if (fs.existsSync(newExePath)) fs.unlinkSync(newExePath); } catch(e) {}

    // Hàm download có thể follow cả HTTP lẫn HTTPS redirect
    const downloadFollowRedirect = (url, redirectCount = 0) => {
        if (redirectCount > 5) {
            mainWindow.webContents.send('update-error', 'Quá nhiều redirect, hủy tải.');
            return;
        }

        const protocol = url.startsWith('https') ? https : http;
        const request = protocol.get(url, { headers: { 'User-Agent': 'FaceID-AutoUpdater' } }, (res) => {
            // Redirect: drain response cũ rồi follow
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                downloadFollowRedirect(res.headers.location, redirectCount + 1);
                return;
            }

            if (res.statusCode !== 200) {
                mainWindow.webContents.send('update-error', 'Lỗi HTTP khi tải: ' + res.statusCode);
                return;
            }

            const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
            let downloadedBytes = 0;
            const file = fs.createWriteStream(newExePath);

            res.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                if (totalBytes > 0) {
                    const percent = Math.round((downloadedBytes / totalBytes) * 100);
                    mainWindow.webContents.send('update-progress', Math.min(percent, 99));
                }
            });

            res.pipe(file);

            file.on('error', (err) => {
                mainWindow.webContents.send('update-error', 'Lỗi ghi file: ' + err.message);
            });

            file.on('finish', () => {
                file.close(() => {
                    // Kiểm tra sanity: file phải > 10MB mới là EXE hợp lệ
                    try {
                        const stats = fs.statSync(newExePath);
                        if (stats.size < 10 * 1024 * 1024) {
                            mainWindow.webContents.send('update-error',
                                `File tải về quá nhỏ (${(stats.size / 1024).toFixed(0)} KB). Release có thể chưa đính kèm EXE.`);
                            return;
                        }
                    } catch (e) {
                        mainWindow.webContents.send('update-error', 'Không thể kiểm tra file: ' + e.message);
                        return;
                    }

                    mainWindow.webContents.send('update-progress', 100);

                    // ĐƠN GIẢN: Xóa file cũ bằng batch chờ app tắt, rename file mới thành tên cũ, rồi mở lại
                    const batPath = path.join(appDir, '_faceid_update.bat');
                    const batContent = [
                        '@echo off',
                        'title FaceID Updater',
                        'echo Dang cap nhat FaceID Security...',
                        'echo.',
                        'echo Cho ung dung dong lai...',
                        // Chờ đến khi file cũ không còn bị lock (thử xóa liên tục)
                        ':RETRY',
                        `del /f /q "${portableExe}" 2>nul`,
                        `if exist "${portableExe}" (`,
                        '  timeout /t 1 /nobreak >nul',
                        '  goto RETRY',
                        ')',
                        'echo File cu da duoc xoa.',
                        // Rename file mới thành tên file cũ
                        `rename "${newExePath}" "${oldFileName}"`,
                        'echo Da thay the thanh cong!',
                        'echo Dang khoi dong lai...',
                        // Mở file mới (đã được rename)
                        `start "" "${portableExe}"`,
                        // Tự xóa file batch
                        `del /f /q "${batPath}"`,
                    ].join('\r\n');

                    fs.writeFileSync(batPath, batContent, 'ascii');

                    // Spawn cmd.exe detached để batch chạy độc lập hoàn toàn
                    const batProc = spawn('cmd.exe', ['/c', batPath], {
                        detached: true,
                        stdio: 'ignore',
                        windowsHide: false  // Hiện cửa sổ CMD để user theo dõi
                    });
                    batProc.unref();

                    // Chờ 800ms để batch kịp spawn xong rồi mới thoát
                    setTimeout(() => {
                        isLocked = false;
                        globalShortcut.unregisterAll();
                        if (pyProcess) pyProcess.kill();
                        app.exit(0);
                    }, 800);
                });
            });
        });

        request.on('error', (err) => {
            mainWindow.webContents.send('update-error', 'Lỗi kết nối: ' + err.message);
        });
    };

    downloadFollowRedirect(downloadUrl);
}

ipcMain.on('start-update', (event, { downloadUrl }) => {
    installUpdate(downloadUrl);
});

app.on('window-all-closed', function () {
    if (pyshell) pyshell.end();
    if (process.platform !== 'darwin') app.quit();
});
