const { ipcRenderer } = require('electron');

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const lockScreen = document.getElementById('lock-screen');
const scanScreen = document.getElementById('scan-screen');
const scanStatusMsg = document.getElementById('scan-status-msg');
const passwordModal = document.getElementById('password-modal');
const adminPass = document.getElementById('admin-pass');
const errorMsg = document.getElementById('error-msg');
const notificationModal = document.getElementById('notification-modal');
const notificationMsg = document.getElementById('notification-msg');
const closeNotificationBtn = document.getElementById('close-notification-btn');

const namingModal = document.getElementById('naming-modal');
const faceNameInput = document.getElementById('face-name-input');
const saveFaceBtn = document.getElementById('save-face-btn');

const managementModal = document.getElementById('management-modal');
const faceList = document.getElementById('face-list');
const closeManagementBtn = document.getElementById('close-management-btn');

const settingsModal = document.getElementById('management-modal'); // Unified
const newAdminPass = document.getElementById('new-admin-pass');
const newSecretPass = document.getElementById('new-secret-pass');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const settingsMsg = document.getElementById('settings-msg');
const settingsBtn = document.getElementById('settings-btn'); // No longer needed but keeping for var safety

const confirmationModal = document.getElementById('confirmation-modal');
const confirmModalMsg = document.getElementById('confirm-modal-msg');
const confirmYesBtn = document.getElementById('confirm-yes-btn');
const confirmNoBtn = document.getElementById('confirm-no-btn');

const clockTime = document.getElementById('clock-time');
const clockDate = document.getElementById('clock-date');

let isRegistering = false;
let isProcessing = false;
let pythonProcessing = false;
let pythonInterval = null;
let currentRegisteringName = "";
let currentAuthAction = null; // 'register', 'settings', 'exit'
let confirmCallback = null;
let isPythonRegistered = false;
let pythonReady = false;
let isCapturingAngle = false; // COOLDOWN FLAG
let registrationStarted = false; // NEW SESSION FLAG

let currentGuideStepIdx = 0;
const guideSteps = ['center', 'left', 'right', 'up', 'down'];
const guideStepLabels = {
    'center': 'Nhìn thẳng vào camera',
    'left': 'Quay mặt sang Trái',
    'right': 'Quay mặt sang Phải',
    'up': 'Ngước mặt lên Trên',
    'down': 'Cúi mặt xuống Dưới'
};

// --- LOGGING ---
function addLog(message, type = 'info') {
    const logBody = document.getElementById('log-content');
    const logConsole = document.getElementById('log-console');
    if (!logBody) return;

    // Bỏ hiển thị bảng System Debug Log
    // logConsole.style.display = 'block';
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const time = new Date().toLocaleTimeString();
    entry.innerHTML = `<span class="log-time">[${time}]</span> <span class="log-msg">${message}</span>`;
    logBody.appendChild(entry);
    logBody.scrollTop = logBody.scrollHeight;

    while (logBody.children.length > 50) logBody.removeChild(logBody.firstChild);
}

// --- HELPERS ---
async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
        video.srcObject = stream;
        return true;
    } catch (err) {
        addLog("Lỗi truy cập camera: " + err.message, 'error');
        return false;
    }
}

function stopCamera() {
    const stream = video.srcObject;
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        video.srcObject = null;
    }
}

function updateGuideUI(capturedDirections = []) {
    const step = guideSteps[currentGuideStepIdx];
    const textEl = document.getElementById('guide-text');
    if (!textEl) return;
    textEl.innerText = guideStepLabels[step] || "Đang hoàn tất...";

    // Reset arrows but keep 'done' states
    document.querySelectorAll('.guide-arrow').forEach(a => {
        a.classList.remove('active');
        a.classList.remove('done'); // CLEAR PREVIOUS STATE
        const arrowDir = a.id.replace('arrow-', '');
        if (capturedDirections.includes(arrowDir)) {
            a.classList.add('done');
        }
    });

    if (step !== 'center') {
        const arrow = document.getElementById(`arrow-${step}`);
        if (arrow) arrow.classList.add('active');
    }
}

// --- AI DETECTION LOOP ---
async function startDetection() {
    if (isProcessing) return;
    isProcessing = true;
    currentGuideStepIdx = 0;

    scanStatusMsg.innerText = pythonReady ? "Đang quét môi trường 3D..." : "Đang khởi động AI 3D...";

    const displaySize = { width: video.videoWidth, height: video.videoHeight };
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');

    const runDetection = () => {
        if (!isProcessing || !video.srcObject) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        requestAnimationFrame(runDetection);
    };
    runDetection();

    if (!pythonInterval) {
        pythonInterval = setInterval(() => {
            if (isProcessing && !pythonProcessing && !isCapturingAngle && video.srcObject && pythonReady) {
                const mode = isRegistering ? 'register' : 'detect';
                sendFrameToPython(mode, currentRegisteringName);
            }
        }, 500); // 3D PRO SPEED
    }
}

function sendFrameToPython(mode, faceName = "") {
    if (!video.videoWidth) return;

    // SCALE DOWN: Use 640px width for optimal balance between speed and accuracy
    const targetWidth = 640;
    const scale = targetWidth / video.videoWidth;
    const targetHeight = video.videoHeight * scale;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = targetWidth;
    tempCanvas.height = targetHeight;
    const ctx = tempCanvas.getContext('2d');

    ctx.translate(tempCanvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, targetWidth, targetHeight);

    // GPU OPTIMIZATION: Lower quality to 0.6 and use smaller dimensions if needed
    const imageData = tempCanvas.toDataURL('image/jpeg', 0.6);
    pythonProcessing = true;

    if (isProcessing && !isCapturingAngle) {
        scanStatusMsg.innerText = "Đang phân tích dữ liệu 3D...";
        scanStatusMsg.style.color = "#00d4ff";
    }

    ipcRenderer.send('process-image-python', {
        mode,
        image_data: imageData,
        faceName: faceName,
        reset_angles: registrationStarted // CLEAR OLD DATA ON START
    });

    if (registrationStarted) registrationStarted = false;
}

// --- IPC LISTENERS ---
ipcRenderer.on('python-result', (event, result) => {
    pythonProcessing = false;

    if (result.status === "LOADING_MODELS") {
        addLog("AI: Đang nạp dữ liệu mốc Landmark...");
        return;
    }

    if (result.status === "READY") {
        pythonReady = true;
        addLog(`AI ENGINE: ${result.mode || 'Sẵn sàng'}`);
        scanStatusMsg.innerText = "Sẵn sàng quét diện mạo Pro";
        return;
    }

    if (result.faces) {
        renderFaceList(result.faces);
        return;
    }

    if (result.message === "Deleted successfully") {
        addLog("Đã xóa diện mạo thành công!", 'info');
        loadFaceList();
        return;
    }

    if (result.status === "no_face") {
        if (isProcessing) {
            scanStatusMsg.innerText = "Vui lòng đưa khuôn mặt vào khung hình...";
            scanStatusMsg.style.color = "#ffaa00";
        }
        return;
    }

    if (result.status === "duplicate") {
        addLog(`CẢNH BÁO: Khuôn mặt đã đăng ký cho [${result.match_name}]`, 'error');
        stopCamera();
        switchToLockScreen();
        showNotification(`Khuôn mặt này đã được đăng ký trong hệ thống cho người dùng: ${result.match_name}`);
        return;
    }

    if (result.success && result.status === "registered") {
        if (!isCapturingAngle) {
            isCapturingAngle = true;
            addLog(`Đã ghi nhớ góc: ${result.direction.toUpperCase()}`, 'success');
            scanStatusMsg.innerText = `Đã thu thập dữ liệu góc ${result.direction.toUpperCase()}`;
            scanStatusMsg.style.color = "#00ff88";

            const capturedDirections = result.all_angles || [];
            updateGuideUI(capturedDirections);

            if (capturedDirections.length >= 5) {
                addLog("Chúc mừng! Đã hoàn tất bản đồ 3D khuôn mặt.", 'success');
                document.getElementById('guide-check').classList.add('show');
                isPythonRegistered = true;
                setTimeout(() => {
                    showNotification(`Hệ thống Virtual 3D đã lưu diện mạo: ${currentRegisteringName}`);
                    switchToLockScreen();
                    isCapturingAngle = false;
                }, 1500);
            } else {
                // Wait 1.5s before allowing next angle capture
                setTimeout(() => {
                    for (let i = 0; i < guideSteps.length; i++) {
                        if (!capturedDirections.includes(guideSteps[i])) {
                            currentGuideStepIdx = i;
                            break;
                        }
                    }
                    updateGuideUI(capturedDirections);
                    isCapturingAngle = false;
                    scanStatusMsg.innerText = "Đang quét môi trường 3D...";
                }, 1500);
            }
        }
        return;
    }

    if (!isProcessing) return;

    if (result.success && result.match) {
        if (result.masked) {
            addLog(`Nhận diện Fallback (Che chắn): ${result.match}`, 'warn');
        } else {
            addLog(`Nhận diện 3D khớp: ${result.match} (Góc: ${result.direction})`, 'success');
        }
        handleRecognitionSuccess(result.match, result.masked);
    } else if (!result.success && result.status !== "no_face") {
        addLog(result.message || "Không khớp dữ liệu 3D", 'warn');
    }
});

function handleRecognitionSuccess(name, isMasked=false) {
    if (isMasked) {
        scanStatusMsg.innerText = `Chào ${name}! Xác thực xuyên vật cản thành công.`;
        scanStatusMsg.style.color = "#ffaa00";
    } else {
        scanStatusMsg.innerText = `Chào ${name}! Đã xác thực 3D.`;
        scanStatusMsg.style.color = "#00f2ff";
    }
    isProcessing = false;
    if (pythonInterval) { clearInterval(pythonInterval); pythonInterval = null; }
    setTimeout(() => {
        switchToLockScreen();
        ipcRenderer.send('unlock-success');
    }, 1500);
}

// --- MODAL & UI CONTROL ---
function switchToScanScreen(register = false) {
    isRegistering = register;
    lockScreen.classList.remove('active');
    scanScreen.classList.add('active');
    scanStatusMsg.innerText = pythonReady ? "Đang quét môi trường 3D..." : "Đang khởi động AI 3D...";
    scanStatusMsg.style.color = "white";

    document.getElementById('guide-ui').style.display = isRegistering ? 'block' : 'none';
    if (isRegistering) {
        document.getElementById('guide-check').classList.remove('show');
        addLog("BẮT ĐẦU QUY TRÌNH QUÉT 3D ĐA GÓC ĐỘ");
        currentGuideStepIdx = 0; // Reset to center
        registrationStarted = true; // TRIGGER RESET IN PYTHON
        updateGuideUI();
    }

    startCamera().then(success => {
        if (success) {
            // FIX: Use simple async loop instead of onloadedmetadata to avoid double calls
            setTimeout(() => startDetection(), 500);
        } else {
            showNotification("Không thể mở Camera!");
            switchToLockScreen();
        }
    });
}

function switchToLockScreen() {
    stopCamera();
    isProcessing = false;
    if (pythonInterval) { clearInterval(pythonInterval); pythonInterval = null; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    scanScreen.classList.remove('active');
    lockScreen.classList.add('active');
}

// --- EVENT LISTENERS ---
document.getElementById('unlock-btn').addEventListener('click', () => {
    ipcRenderer.send('check-registration-status');
    setTimeout(() => {
        if (!isPythonRegistered) {
            showNotification("Bạn chưa đăng ký khuôn mặt nào!");
            return;
        }
        switchToScanScreen(false);
    }, 100);
});

document.getElementById('register-btn').addEventListener('click', () => {
    currentAuthAction = 'register';
    document.getElementById('modal-title').innerText = "👤 XÁC THỰC ĐĂNG KÝ";
    document.getElementById('modal-prompt').innerText = "Nhập mật khẩu để bắt đầu quét khuôn mặt mới";
    passwordModal.classList.add('active');
    adminPass.focus();
});

settingsBtn.addEventListener('click', () => {
    currentAuthAction = 'settings';
    document.getElementById('modal-title').innerText = "🔐 Quản lí nâng cao";
    document.getElementById('modal-prompt').innerText = "Nhập mật khẩu để truy cập vào cài đặt";
    passwordModal.classList.add('active');
    adminPass.focus();
});

document.getElementById('close-modal-btn').addEventListener('click', () => {
    passwordModal.classList.remove('active');
    adminPass.value = '';
    errorMsg.innerText = '';
});

function handlePasswordVerify() {
    const password = adminPass.value;
    // Hierarchical Check:
    // 'register' can use Admin or Secret pass
    // 'settings' / 'exit' MUST use Secret pass
    const authType = (currentAuthAction === 'register') ? 'admin' : 'secret';
    ipcRenderer.send('verify-password', { password, type: authType });
}

document.getElementById('verify-pass-btn').addEventListener('click', handlePasswordVerify);
adminPass.addEventListener('keypress', (e) => { if (e.key === 'Enter') handlePasswordVerify(); });

ipcRenderer.on('verify-password-result', (event, { isValid }) => {
    if (isValid) {
        passwordModal.classList.remove('active');
        adminPass.value = '';
        if (currentAuthAction === 'register') {
            namingModal.classList.add('active');
            faceNameInput.focus();
        } else if (currentAuthAction === 'settings') {
            openManagement();
        } else if (currentAuthAction === 'exit') {
            ipcRenderer.send('exit-app-verified');
        }
    } else {
        errorMsg.innerText = "Sai mật khẩu!";
    }
});

saveSettingsBtn.addEventListener('click', () => {
    const adminP = newAdminPass.value;
    const secretP = newSecretPass.value;
    if (!adminP && !secretP) {
        settingsMsg.style.color = "#ff4d4d";
        settingsMsg.innerText = "Vui lòng nhập ít nhất một mật khẩu mới!";
        return;
    }
    ipcRenderer.send('update-settings', { newAdminPass: adminP, newSecretPass: secretP });
});

ipcRenderer.on('update-settings-result', (event, { success }) => {
    if (success) {
        settingsMsg.style.color = "#00ff88";
        settingsMsg.innerText = "Cập nhật mật khẩu thành công!";
        newAdminPass.value = '';
        newSecretPass.value = '';
    } else {
        settingsMsg.style.color = "#ff4d4d";
        settingsMsg.innerText = "Lỗi khi cập nhật!";
    }
});

saveFaceBtn.addEventListener('click', () => {
    currentRegisteringName = faceNameInput.value.trim() || "User_" + Date.now();
    namingModal.classList.remove('active');
    faceNameInput.value = '';
    switchToScanScreen(true);
});

// Management Logic
function openManagement() {
    managementModal.classList.add('active');
    // Clear password fields inside
    newAdminPass.value = '';
    newSecretPass.value = '';
    settingsMsg.innerText = '';
    loadFaceList();
}
function loadFaceList() {
    faceList.innerHTML = '<p>Đang tải...</p>';
    ipcRenderer.send('process-image-python', { mode: 'list', image_data: '' });
}
function renderFaceList(faces) {
    isPythonRegistered = faces.length > 0;
    if (faces.length === 0) {
        faceList.innerHTML = '<p>Chưa có diện mạo nào.</p>';
        return;
    }
    faceList.innerHTML = faces.map(f => `
        <div class="face-item">
            <div class="face-info"><h4>${f.name}</h4><p>Ngày: ${f.date}</p></div>
            <button class="delete-icon-btn" onclick="deleteFace('${f.id}')">&times;</button>
        </div>
    `).join('');
}

window.deleteFace = (id) => {
    showCustomConfirm("Xóa diện mạo này?", () => {
        ipcRenderer.send('process-image-python', { mode: 'delete', face_id: id, image_data: '' });
    });
};

function showCustomConfirm(message, onConfirm) {
    confirmModalMsg.innerText = message;
    confirmCallback = onConfirm;
    confirmationModal.classList.add('active');
}
confirmYesBtn.addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    confirmationModal.classList.remove('active');
});
confirmNoBtn.addEventListener('click', () => confirmationModal.classList.remove('active'));

closeManagementBtn.addEventListener('click', () => managementModal.classList.remove('active'));
document.getElementById('cancel-scan-btn').addEventListener('click', () => switchToLockScreen());
closeNotificationBtn.addEventListener('click', () => notificationModal.classList.remove('active'));

function showNotification(message) {
    notificationMsg.innerText = message;
    notificationModal.classList.add('active');
}

// Clock Logic
function updateClock() {
    const now = new Date();
    clockTime.innerText = now.toLocaleTimeString('vi-VN');
    clockDate.innerText = now.toLocaleDateString('vi-VN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
setInterval(updateClock, 1000); updateClock();

// App Shortcuts & Initialization
ipcRenderer.on('registration-status-result', (event, status) => {
    isPythonRegistered = status.hasPythonReg;
});

function showExitPrompt() {
    currentAuthAction = 'exit';
    document.getElementById('modal-title').innerText = "🛑 XÁC NHẬN THOÁT";
    document.getElementById('modal-prompt').innerText = "Vui lòng nhập mật khẩu để thoát ứng dụng";
    passwordModal.classList.add('active');
    adminPass.focus();
}

// Map the exit button if it exists in UI
const exitBtn = document.getElementById('exit-btn');
if (exitBtn) exitBtn.addEventListener('click', showExitPrompt);

ipcRenderer.on('request-exit-pass', () => {
    showExitPrompt();
});

ipcRenderer.on('app-locked', () => switchToLockScreen());

ipcRenderer.send('check-registration-status');
addLog("Hệ thống FaceID 3D Pro đang khởi tạo...");
