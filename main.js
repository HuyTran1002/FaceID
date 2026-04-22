const { app, BrowserWindow, Tray, Menu, ipcMain, screen, globalShortcut, dialog, Notification, powerSaveBlocker, powerMonitor } = require('electron');

// Chế độ Tương thích Tuyệt đối (v1.1.32) - Khôi phục Camera & Ổn định UI
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('no-sandbox');

const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const readline = require('readline');
const { PythonShell } = require('python-shell');
const crypto = require('crypto');
const packageJson = require('./package.json');

let mainWindow;
let tray = null;
let isLocked = true;
let pythonExit = false;
let keyGuardProcess = null;
let psBlockerId = null; // Quản lý ID Tiết kiệm năng lượng (v4.2.0)

// --- TRÌNH XỬ LÝ LỖI TOÀN CỤC (v4.2.6) ---
process.on('uncaughtException', (err) => {
    logToFile(`CRITICAL ERROR (Uncaught): ${err.message}\nStack: ${err.stack}`);
});
process.on('unhandledRejection', (reason) => {
    logToFile(`CRITICAL ERROR (Unhandled): ${reason}`);
});

// Helper: Điều phối mức ưu tiên xử lý (v4.2.0)
function setSidecarPriority(level) {
    if (process.platform !== 'win32') return;
    const priorityMap = { 'idle': 'Idle', 'normal': 'Normal', 'high': 'High' };
    const pName = priorityMap[level] || 'Normal';
    
    // Áp dụng cho Python
    const aiPid = (app.isPackaged && pyProcess) ? pyProcess.pid : (pyshell && pyshell.childProcess ? pyshell.childProcess.pid : null);
    if (aiPid) {
        spawn('powershell.exe', ['-Command', `Get-Process -Id ${aiPid} | ForEach-Object { $_.PriorityClass = '${pName}' }`], { windowsHide: true });
    }
    
    // Áp dụng cho KeyGuard
    if (keyGuardProcess && keyGuardProcess.pid) {
        spawn('powershell.exe', ['-Command', `Get-Process -Id ${keyGuardProcess.pid} | ForEach-Object { $_.PriorityClass = '${pName}' }`], { windowsHide: true });
    }
    
    logToFile(`System Optimization: Set Sidecars Priority to ${pName}`);
}

// --- SILENT KEYGUARD PLUS (C# Sidecar Source) v3.1.5 ---
const KEYGUARD_SOURCE = `
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Diagnostics;
using System.Threading;
using System.IO;

class KeyGuard {
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int VK_LWIN = 0x5B;
    private const int VK_RWIN = 0x5C;
    private const int VK_TAB = 0x09;
    private const int VK_ESCAPE = 0x1B;
    private const int LLKHF_ALTDOWN = 0x20;

    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int vKey);

    private static LowLevelKeyboardProc _proc = HookCallback;
    private static IntPtr _hookID = IntPtr.Zero;

    public static void Main(string[] args) {
        // Cơ chế Mutex để đảm bảo chỉ có 1 Watchdog chạy (v4.3.3)
        bool createdNew;
        using (Mutex mutex = new Mutex(true, "FaceID_Watchdog_Mutex", out createdNew)) {
            if (!createdNew) return;

            if (args.Length >= 3) {
                int pid;
                if (int.TryParse(args[0], out pid)) {
                    string exePath = args[1];
                    string userDataPath = args[2];
                    int deathCounter = 0; // Đếm số lần xác nhận app chết (v4.3.3)

                    Thread watchdog = new Thread(() => {
                        while (true) {
                            bool isAlive = false;
                            try {
                                Process parent = Process.GetProcessById(pid);
                                if (!parent.HasExited) isAlive = true;
                            } catch {}

                            if (!isAlive) {
                                deathCounter++;
                                if (deathCounter >= 3) break; // Xác nhận chết 3 lần (0.6s) thì mới hồi sinh
                            } else {
                                deathCounter = 0; // Reset nếu app vẫn sống
                            }

                            // Kiểm tra cờ thoát an toàn (v3.1.5)
                            string flagPath = Path.Combine(userDataPath, "FaceID_Safe_Exit.flag");
                            if (File.Exists(flagPath)) Environment.Exit(0);

                            Thread.Sleep(200); 
                        }
                        
                        // Hồi sinh App
                        string finalFlag = Path.Combine(userDataPath, "FaceID_Safe_Exit.flag");
                        if (!File.Exists(finalFlag) && exePath != "development" && File.Exists(exePath)) {
                            Thread.Sleep(500); 
                            try {
                                ProcessStartInfo psi = new ProcessStartInfo { FileName = exePath, UseShellExecute = true };
                                Process.Start(psi);
                            } catch {}
                        }
                        Environment.Exit(0);
                    });
                    watchdog.IsBackground = true;
                    watchdog.Start();
                }
            }
            _hookID = SetHook(_proc);
            Application.Run();
            UnhookWindowsHookEx(_hookID);
        }
    }

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    private static IntPtr SetHook(LowLevelKeyboardProc proc) {
        using (Process curProcess = Process.GetCurrentProcess())
        using (ProcessModule curModule = curProcess.MainModule) {
            return SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(curModule.ModuleName), 0);
        }
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0 && (wParam == (IntPtr)WM_KEYDOWN || wParam == (IntPtr)WM_SYSKEYDOWN)) {
            KBDLLHOOKSTRUCT hs = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            
            // Chặn phím Windows
            if (hs.vkCode == VK_LWIN || hs.vkCode == VK_RWIN) return (IntPtr)1;

            // Chặn Alt + Tab (v3.1.5)
            if (hs.vkCode == VK_TAB && (hs.flags & LLKHF_ALTDOWN) != 0) return (IntPtr)1;

            // Chặn Ctrl + Shift + Esc (Task Manager) (v4.0.0)
            if (hs.vkCode == VK_ESCAPE) {
                bool ctrl = (GetAsyncKeyState(0x11) & 0x8000) != 0 || (GetAsyncKeyState(0xA2) & 0x8000) != 0 || (GetAsyncKeyState(0xA3) & 0x8000) != 0;
                bool shift = (GetAsyncKeyState(0x10) & 0x8000) != 0 || (GetAsyncKeyState(0xA0) & 0x8000) != 0 || (GetAsyncKeyState(0xA1) & 0x8000) != 0;
                if (ctrl && shift) return (IntPtr)1;
            }
        }
        return CallNextHookEx(_hookID, nCode, wParam, lParam);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT {
        public int vkCode;
        public int scanCode;
        public int flags;
        public int time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);
}
`;

function compileKeyGuard() {
    if (process.platform !== 'win32') return;
    const tempPath = app.getPath('userData');
    const sourcePath = path.join(tempPath, 'KeyGuard.cs');
    // Đổi tên ngụy trang thành tiến trình giống hệ thống (v4.3.0)
    const exePath = path.join(tempPath, 'WinSecurityHealthGuard.exe'); 

    fs.writeFileSync(sourcePath, KEYGUARD_SOURCE);
    
    const cscPath = 'C:\\\\Windows\\\\Microsoft.NET\\\\Framework64\\\\v4.0.30319\\\\csc.exe';
    if (fs.existsSync(cscPath)) {
        const compile = spawn(cscPath, ['/target:winexe', `/out:${exePath}`, sourcePath], { shell: true });
        compile.on('close', (code) => {
            if (code === 0) logToFile("KeyGuard Compiled Successfully.");
            else logToFile("KeyGuard Compilation Failed with code: " + code);
        });
    } else {
        logToFile("CSC.EXE NOT FOUND. KeyGuard will not be available.");
    }
}

function manageKeyGuard(enable) {
    if (process.platform !== 'win32') return;
    const exePath = path.join(app.getPath('userData'), 'WinSecurityHealthGuard.exe');
    const flagPath = path.join(app.getPath('userData'), 'FaceID_Safe_Exit.flag');

    if (enable) {
        try { if (fs.existsSync(flagPath)) fs.unlinkSync(flagPath); } catch(e) {}
        if (fs.existsSync(exePath) && (!keyGuardProcess || keyGuardProcess.killed)) {
            // Lấy đường dẫn EXE chuẩn: Ưu tiên bản Portable, sau đó đến bản thực thi hiện tại (v4.3.2)
            const thisExe = process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe') || 'development';
            
            keyGuardProcess = spawn(exePath, [process.pid.toString(), app.isPackaged ? thisExe : 'development', app.getPath('userData')], {
                windowsHide: true,
                detached: true 
            });
            if (keyGuardProcess.unref) keyGuardProcess.unref();
            
            // --- CƠ CHẾ BẢO VỆ CHÉO (v4.3.0) ---
            // Nếu Watchdog bị tắt đột ngột, Electron sẽ ngay lập tức hồi sinh nó.
            keyGuardProcess.on('exit', (code) => {
                const stillLocked = isLocked;
                const safeExit = fs.existsSync(flagPath);
                if (stillLocked && !safeExit) {
                    logToFile("KeyGuard KILLED unexpectedly! Respawning in 1s...");
                    keyGuardProcess = null;
                    setTimeout(() => manageKeyGuard(true), 1000);
                }
            });

            logToFile("KeyGuard Activated (Immortal Mode).");
        }
    } else {
        try { fs.writeFileSync(flagPath, 'SAFE_EXIT'); } catch(e) {}
        if (keyGuardProcess) {
            keyGuardProcess.kill();
            keyGuardProcess = null;
            logToFile("KeyGuard Deactivated.");
        }
    }
}

function hashPassword(password) {
    if (!password) return '';
    return crypto.createHash('sha256').update(password).digest('hex');
}

function verifyPassword(input, storedHash) {
    if (!storedHash) return false;
    
    // Migration logic (v3.1.0): Support both plain-text (old) and hashed (new)
    if (storedHash.length !== 64) {
        // Old password detected
        if (input === storedHash) {
            // Auto-migrate to hash
            config.adminPass = hashPassword(config.adminPass);
            config.secretPass = hashPassword(config.secretPass);
            saveConfig();
            return true;
        }
        return false;
    }
    return hashPassword(input) === storedHash;
}

// Config Management (Passwords)
const configPath = path.join(app.getPath('userData'), 'config.json');
let config = {
    adminPass: '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92',
    secretPass: '983637e6f854ca68c8b677a83d7249b0eb23e3e0ff4864115e5899982759e51c',
    autoLockTimer: 0
};

function loadConfig() {
    if (fs.existsSync(configPath)) {
        try {
            const data = fs.readFileSync(configPath, 'utf8');
            const loaded = JSON.parse(data);
            config = { ...config, ...loaded };
            
            // Đảm bảo luôn có pass mặc định nếu bị xóa/hỏng (v3.1.3)
            if (!config.adminPass) config.adminPass = '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92';
            if (!config.secretPass) config.secretPass = '983637e6f854ca68c8b677a83d7249b0eb23e3e0ff4864115e5899982759e51c';
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
            // Chỉ gọi lockApp nếu đang không ở trạng thái Khóa (v4.3.3 - Fix lỗi nháy máy)
            if (!isLocked) {
                lockApp(); 
            }
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
            logToFile("Attempting to start AI EXE at: " + exePath);
            
            if (fs.existsSync(exePath)) {
                logToFile("AI EXE Found. Spawning process...");
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
                        logToFile("AI RAW: " + line); // Ghi lại mọi thứ v2.9.0
                        try {
                            const result = JSON.parse(line);
                            if (result.status === "READY") logToFile("AI ENGINE SIGNALED READY.");
                            if (mainWindow) mainWindow.webContents.send('python-result', result);
                        } catch (e) {
                            logToFile('AI JSON PARSE ERR: ' + line);
                        }
                    }
                });

                pyProcess.on('error', (err) => {
                    logToFile('AI SPAWN ERROR: ' + err.message);
                });

                pyProcess.on('exit', (code) => {
                    if (isLocked && !pythonExit) {
                        logToFile(`AI ENGINE KILLED (Code: ${code})! Restarting AI...`);
                        setTimeout(initPython, 1000); // Tự động hồi sinh AI (v4.3.1)
                    }
                });

                pyProcess.stderr.on('data', (data) => {
                    logToFile('AI STDERR: ' + data.toString());
                });

                return;
            } else {
                logToFile("CRITICAL: AI EXE NOT FOUND at " + exePath);
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
            console.log('[AI OUTPUT]:', message); // LOG TO TERMINAL v2.1.3
            if (mainWindow) mainWindow.webContents.send('python-result', message);
        });
        pyshell.on('stderr', (stderr) => console.log('AI DEV DEBUG:', stderr));
        pyshell.on('error', (err) => console.error('AI DEV ERROR:', err));
        
    } catch (e) {
        logToFile("Failed to init AI Engine: " + e.message);
    }
}

// Hệ thống ghi log ra tệp để chẩn đoán bản Build (v2.8.7)
function logToFile(msg) {
    const logPath = path.join(app.getPath('userData'), 'debug_log.txt');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logPath, `[${timestamp}] ${msg}\n`);
}

let shieldWindows = [];

function createShields() {
    const displays = screen.getAllDisplays();
    const primaryId = screen.getPrimaryDisplay().id;
    
    displays.forEach(display => {
        if (display.id !== primaryId) {
            const shield = new BrowserWindow({
                x: display.bounds.x,
                y: display.bounds.y,
                width: display.bounds.width,
                height: display.bounds.height,
                fullscreen: true,
                alwaysOnTop: true,
                kiosk: true,
                frame: false,
                skipTaskbar: true,
                resizable: false,
                backgroundColor: '#000000',
                webPreferences: { nodeIntegration: false, contextIsolation: true }
            });
            shield.on('close', (e) => {
                if (isLocked) e.preventDefault();
            });
            shieldWindows.push(shield);
        }
    });
}

function destroyShields() {
    shieldWindows.forEach(w => {
        if (!w.isDestroyed()) w.destroy();
    });
    shieldWindows = [];
}

function createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    // Tắt Menu mặc định của ứng dụng (Triệt tiêu "Bảng Electron") (v4.2.2)
    Menu.setApplicationMenu(null);

    mainWindow = new BrowserWindow({
        width: width,
        height: height,
        show: true, // Hiển thị ngay (v4.2.6 - Fix lỗi đen màn hình)
        fullscreen: true,
        alwaysOnTop: true,
        kiosk: true,
        frame: false,
        skipTaskbar: true,
        resizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
        },
        icon: path.join(__dirname, 'assets/icon.png')
    });

    mainWindow.loadFile('index.html');

    // Chặn phím hệ thống nếu có thể (v4.2.6)
    mainWindow.on('close', (e) => {
        if (isLocked) e.preventDefault();
    });

    mainWindow.on('blur', () => {
        if (isLocked) {
            mainWindow.setAlwaysOnTop(true, 'screen-saver');
            mainWindow.setKiosk(true); // Ép lại kiosk
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
            { label: 'Kiểm tra bản cập nhật mới', click: () => { checkAndDownloadUpdate(); } },
            { type: 'separator' },
            { label: 'Thoát hoàn toàn app', click: () => { 
                mainWindow.show();
                mainWindow.webContents.send('request-exit-pass'); 
            } }
        ]);

        tray.setToolTip('FaceID App - Đang chạy ngầm');
        tray.setContextMenu(contextMenu);
        tray.on('click', () => { lockApp(); });
    } catch (e) {
        console.error("Tray creation failed:", e);
    }
}

function lockApp() {
    isLocked = true;
    try { createShields(); } catch (e) {}
    mainWindow.show();
    mainWindow.setFullScreen(true);
    mainWindow.setKiosk(true);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');

    // Khóa phím qua Python (Windows key, etc)
    const lockData = { mode: 'lock_keys' };
    if (app.isPackaged && pyProcess && !pyProcess.killed) pyProcess.stdin.write(JSON.stringify(lockData) + '\n');
    else if (pyshell) pyshell.send(lockData);

    // Chặn các phím thoát hiểm qua Sidecar (v3.1.5)
    manageKeyGuard(true);

    try { globalShortcut.register('Alt+Tab', () => { return false; }); } catch (e) {}
    try { globalShortcut.register('CommandOrControl+Esc', () => { return false; }); } catch (e) {}
    try { globalShortcut.register('Alt+F4', () => { return false; }); } catch (e) {}
    try { globalShortcut.register('CommandOrControl+W', () => { return false; }); } catch (e) {}

    // Tối ưu năng lượng: Ngăn máy ngủ khi đang khóa (v4.2.0)
    if (psBlockerId === null) psBlockerId = powerSaveBlocker.start('prevent-display-sleep');

    // Tối ưu ưu tiên: Đẩy AI lên hàng đầu để nhận diện nhạy (v4.2.0)
    setSidecarPriority('high');

    mainWindow.webContents.send('app-locked');
}

function unlockApp() {
    isLocked = false;
    try { destroyShields(); } catch (e) {}
    mainWindow.setKiosk(false);
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setFullScreen(false);
    mainWindow.hide();

    // Mở khóa phím qua Python
    const unlockData = { mode: 'unlock_keys' };
    if (app.isPackaged && pyProcess && !pyProcess.killed) pyProcess.stdin.write(JSON.stringify(unlockData) + '\n');
    else if (pyshell) pyshell.send(unlockData);

    // Mở khóa các phím thoát hiểm
    manageKeyGuard(false);
    try { globalShortcut.unregister('Alt+Tab'); } catch (e) {}
    try { globalShortcut.unregister('CommandOrControl+Esc'); } catch (e) {}
    try { globalShortcut.unregister('Alt+F4'); } catch (e) {}
    try { globalShortcut.unregister('CommandOrControl+W'); } catch (e) {}

    // Giải phóng năng lượng: Cho phép máy ngủ khi đã mở khóa (v4.2.0)
    if (psBlockerId !== null) {
        powerSaveBlocker.stop(psBlockerId);
        psBlockerId = null;
    }

    // Hạ mức ưu tiên: Cho AI ngủ đông để nhường máy cho việc khác (v4.2.0)
    setSidecarPriority('idle');

    mainWindow.webContents.send('app-unlocked');
}

app.whenReady().then(() => {
    // Dọn dẹp trạng thái lỗi cũ (v4.3.3)
    try {
        const flagPath = path.join(app.getPath('userData'), 'FaceID_Safe_Exit.flag');
        if (fs.existsSync(flagPath)) fs.unlinkSync(flagPath);
    } catch(e) {}
    
    // AutoRun chuẩn hóa (v4.2.6 - Sửa lỗi .reg file gây crash)
    try {
        const portablePath = process.env.PORTABLE_EXECUTABLE_FILE;
        if (app.isPackaged && portablePath) {
            // Lưu trực tiếp file EXE vào Registry thông qua PowerShell (Ổn định nhất cho Portable)
            const psCmd = `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'FaceID Security' -Value '"${portablePath}"'`;
            spawn('powershell.exe', ['-Command', psCmd], { windowsHide: true });
        } else {
            // Trong môi trường Dev hoặc bản cài đặt thường
            app.setLoginItemSettings({
                openAtLogin: true,
                path: process.execPath,
                args: app.isPackaged ? [] : [path.resolve('.')]
            });
        }
    } catch(e) {
        logToFile('AutoRun Registration Error: ' + e.message);
    }

    compileKeyGuard();
    createWindow();
    createTray();
    initPython(); 
    
    // Khởi động module theo dõi Treo máy (v4.1.1)
    setInterval(() => {
        const timerVal = parseInt(config.autoLockTimer, 10) || 0;
        if (!isLocked && timerVal > 0) {
            try {
                const idleTime = powerMonitor.getSystemIdleTime();
                if (idleTime >= timerVal) {
                    logToFile(`Auto-Lock Triggered: Idle for ${idleTime}s (Limit: ${timerVal}s)`);
                    lockApp();
                }
            } catch (e) {
                logToFile("PowerMonitor Error: " + e.message);
            }
        }
    }, 2000); // Kiểm tra mỗi 2 giây cho nhạy

    globalShortcut.register('CommandOrControl+Shift+I', () => {
        if (!app.isPackaged && mainWindow) mainWindow.webContents.toggleDevTools();
    });

    // Đồng bộ hóa trạng thái khóa ban đầu: Kích hoạt High Priority và Power Blocking (v4.2.0)
    lockApp();

    // --- HARD LOCK LOOP v4.2.2 ---
    // Trong 10 giây đầu khởi chạy, ép cửa sổ khóa liên tục để chống lại việc bị đè lúc Login
    let loopCount = 0;
    const hardLockInterval = setInterval(() => {
        if (isLocked && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setKiosk(true);
            mainWindow.setAlwaysOnTop(true, 'screen-saver');
            if (loopCount % 4 === 0) mainWindow.focus(); // Mỗi 2s lấy lại focus một lần
        }
        loopCount++;
        if (loopCount > 20) clearInterval(hardLockInterval); // Sau 10s (20 * 500ms) thì dừng loop
    }, 500); // 500ms cho mượt

    globalShortcut.register('CommandOrControl+Alt+L', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.webContents.send('request-exit-pass');
        }
    });

    globalShortcut.register('CommandOrControl+Alt+K', () => {
        lockApp();
    });
});

ipcMain.on('unlock-success', () => { unlockApp(); });
ipcMain.on('request-lock', () => { lockApp(); });

ipcMain.on('get-user-data-path', (event) => {
    event.reply('user-data-path', app.getPath('userData'), config);
});

ipcMain.on('update-config', (event, newConfig) => {
    // Tự động mã hóa mật khẩu nếu có thay đổi (v3.1.0)
    if (newConfig.adminPass) newConfig.adminPass = hashPassword(newConfig.adminPass);
    if (newConfig.secretPass) newConfig.secretPass = hashPassword(newConfig.secretPass);
    
    config = { ...config, ...newConfig };
    saveConfig();
    logToFile(`Config updated: AutoLock=${config.autoLockTimer}s`);
    event.reply('config-updated', { success: true });
});

ipcMain.on('update-settings', (event, { newAdminPass, newSecretPass }) => {
    if (newAdminPass) config.adminPass = hashPassword(newAdminPass);
    if (newSecretPass) config.secretPass = hashPassword(newSecretPass);
    saveConfig();
    event.reply('update-settings-result', { success: true });
});

ipcMain.on('verify-password', (event, { password, type }) => {
    let isValid = false;
    if (type === 'admin') {
        isValid = verifyPassword(password, config.adminPass) || verifyPassword(password, config.secretPass);
    } else if (type === 'secret') {
        isValid = verifyPassword(password, config.secretPass);
    }
    event.reply('verify-password-result', { isValid, type });
});

ipcMain.on('exit-app-verified', () => {
    isLocked = false;
    manageKeyGuard(false);
    globalShortcut.unregisterAll();
    if (pyProcess) pyProcess.kill();
    app.exit(0);
});

// --- LỊCH SỬ MỞ KHÓA v4.1.0 ---
ipcMain.on('record-unlock-history', (event, name) => {
    const historyPath = path.join(app.getPath('userData'), 'unlock_history.json');
    let history = [];
    if (fs.existsSync(historyPath)) {
        try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch(e) {}
    }
    history.unshift({ name, timestamp: new Date().toISOString() });
    if (history.length > 200) history = history.slice(0, 200);
    try { fs.writeFileSync(historyPath, JSON.stringify(history, null, 2)); } catch(e) {}
});

ipcMain.on('get-unlock-history', (event) => {
    const historyPath = path.join(app.getPath('userData'), 'unlock_history.json');
    let history = [];
    if (fs.existsSync(historyPath)) {
        try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch(e) {}
    }
    event.reply('unlock-history-data', history);
});

ipcMain.on('clear-unlock-history', (event) => {
    const historyPath = path.join(app.getPath('userData'), 'unlock_history.json');
    try { if (fs.existsSync(historyPath)) fs.unlinkSync(historyPath); } catch(e) {}
});

ipcMain.on('process-image', (event, data) => {
    data.user_data_path = app.getPath('userData');
    if (app.isPackaged && pyProcess && !pyProcess.killed) {
        pyProcess.stdin.write(JSON.stringify(data) + '\n');
    } else if (pyshell) {
        pyshell.send(data);
    }
});

ipcMain.on('check-registration-status', (event) => {
    const userDataPath = app.getPath('userData');
    const pythonRegPath = path.join(userDataPath, 'faces_v2.json');
    let hasPythonReg = false;
    if (fs.existsSync(pythonRegPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(pythonRegPath, 'utf8'));
            hasPythonReg = Array.isArray(data) ? data.length > 0 : false;
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

let popupWindow = null;
function showStyledPopup(title, msg) {
    if (popupWindow) popupWindow.close();
    popupWindow = new BrowserWindow({
        width: 400, height: 250, frame: false, transparent: true, alwaysOnTop: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
        icon: path.join(__dirname, 'assets/icon.png')
    });
    popupWindow.loadURL(`file://${path.join(__dirname, 'alert.html')}?title=${encodeURIComponent(title)}&msg=${encodeURIComponent(msg)}`);
    popupWindow.on('closed', () => { popupWindow = null; });
}

ipcMain.on('close-popup', () => { if (popupWindow) popupWindow.close(); });

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
        headers: { 'User-Agent': 'FaceID-AutoUpdater' },
        timeout: 15000,
        rejectUnauthorized: false
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
                    showStyledPopup('Kiểm tra cập nhật', "Bạn đang sử dụng phiên bản mới nhất (v" + packageJson.version + ").");
                }
            } catch (e) {
                showSystemToast("Lỗi cập nhật", "Dữ liệu trả về từ GitHub không hợp lệ.");
            }
        });
    }).on('error', (e) => {
        showStyledPopup("Lỗi mạng hiển thị", "Tường lửa hoặc mạng công ty quá yếu. Lỗi: " + e.message);
    }).on('timeout', () => {
        showStyledPopup("Lỗi cập nhật", "Thời gian kết nối quá lâu. Mạng của bạn quá yếu.");
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
        const request = protocol.get(url, { headers: { 'User-Agent': 'FaceID-AutoUpdater' }, timeout: 60000, rejectUnauthorized: false }, (res) => {
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

app.on('before-quit', () => {
    if (pyProcess) pyProcess.kill();
    if (pyshell) pyshell.end();
    manageKeyGuard(false);
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});
// Tự động cấp quyền Camera (v2.8.7)
app.on('web-contents-created', (event, contents) => {
    contents.session.setPermissionCheckHandler((webContents, permission) => {
        if (permission === 'media') return true;
        return false;
    });
    contents.session.setPermissionRequestHandler((webContents, permission, callback) => {
        if (permission === 'media') return callback(true);
        callback(false);
    });
});
