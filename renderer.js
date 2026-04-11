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

const settingsModal = document.getElementById('settings-modal');
const newAdminPass = document.getElementById('new-admin-pass');
const newSecretPass = document.getElementById('new-secret-pass');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const settingsMsg = document.getElementById('settings-msg');
const settingsBtn = document.getElementById('settings-btn');

const confirmationModal = document.getElementById('confirmation-modal');
const confirmModalMsg = document.getElementById('confirm-modal-msg');
const confirmYesBtn = document.getElementById('confirm-yes-btn');
const confirmNoBtn = document.getElementById('confirm-no-btn');

let registeredFaces = [];
let lastCapturedData = null; 
let currentRegisteringName = ""; // Store name before scanning
let currentAuthAction = null; // 'register', 'settings', 'exit'
let confirmCallback = null;

let registeredDescriptor = null;
let isRegistering = false;
let modelsLoaded = false;
let faceMatcher = null;
let isProcessing = false;
let lastDetection = null;

const tinyFaceOptions = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.25 });

const clockTime = document.getElementById('clock-time');
const clockDate = document.getElementById('clock-date');

let pythonProcessing = false;
let pythonInterval = null;
let isPythonRegistered = false;

// Load models
async function loadModels() {
    scanStatusMsg.innerText = "Đang tải mô hình AI...";
    const MODEL_URL = './models';
    
    try {
        await Promise.all([
            faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
            faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
            faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
        ]);
        modelsLoaded = true;
        console.log("Models loaded");
        
        // Load saved face from localStorage
        const savedFace = localStorage.getItem('registeredFace');
        if (savedFace) {
            const descriptorArray = JSON.parse(savedFace);
            registeredDescriptor = new Float32Array(descriptorArray);
            faceMatcher = new faceapi.FaceMatcher(new faceapi.LabeledFaceDescriptors('User', [registeredDescriptor]));
        }
    } catch (err) {
        console.error("Error loading models:", err);
        scanStatusMsg.innerText = "Lỗi tải mô hình AI!";
    }
}

// Start Camera
async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { width: 640, height: 480 } 
        });
        video.srcObject = stream;
        return true;
    } catch (err) {
        console.error("Error accessing camera:", err);
        scanStatusMsg.innerText = "Không thể truy cập Camera!";
        return false;
    }
}

// Stop Camera
function stopCamera() {
    const stream = video.srcObject;
    if (stream) {
        const tracks = stream.getTracks();
        tracks.forEach(track => track.stop());
        video.srcObject = null;
    }
}

// Face Detection Loop
async function startDetection() {
    if (isProcessing) return;
    isProcessing = true;
    
    scanStatusMsg.innerText = "Đang tìm khuôn mặt...";
    const displaySize = { width: video.videoWidth, height: video.videoHeight };
    faceapi.matchDimensions(canvas, displaySize);

    const runDetection = async () => {
        if (!isProcessing || !video.srcObject) return;

        try {
            const detection = await faceapi.detectSingleFace(video, tinyFaceOptions)
                .withFaceLandmarks()
                .withFaceDescriptor();

            canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
            
            if (detection) {
                lastDetection = detection;
                
                const resizedDetection = faceapi.resizeResults(detection, displaySize);
                // Vẽ khung để người dùng biết đã nhận diện được
                faceapi.draw.drawDetections(canvas, resizedDetection);

                if (isRegistering) {
                    // Tự động nếu độ tin cậy cực cao, còn không để người dùng nhấn nút
                    if (detection.detection.score > 0.8) {
                        handleRegistration(detection);
                    } else {
                        scanStatusMsg.innerText = "Hãy giữ yên khuôn mặt hoặc nhấn nút quét!";
                    }
                } else {
                    // Tự động nếu độ tin cậy cực cao
                    if (detection.detection.score > 0.8) {
                        handleRecognition(detection);
                    } else {
                        scanStatusMsg.innerText = "Chạm nút để xác thực nhanh!";
                    }
                }
            } else {
                lastDetection = null;
                scanStatusMsg.innerText = "Đang tìm khuôn mặt...";
            }
        } catch (err) {
            console.error("Detection error:", err);
        }

        if (isProcessing) {
            setTimeout(runDetection, 60); // 60ms delay giữa các khung hình (~15 FPS)
        }
    };

    runDetection();
    
    // Bắt đầu quét bằng Python định kỳ (mỗi 2 giây một lần để tiết kiệm tài nguyên)
    if (!pythonInterval) {
        pythonInterval = setInterval(() => {
            if (isProcessing && !pythonProcessing && video.srcObject) {
                if (isRegistering) {
                    sendFrameToPython('register', currentRegisteringName);
                } else {
                    sendFrameToPython('detect');
                }
            }
        }, 2000);
    }
}

function sendFrameToPython(mode, faceName = "") {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = video.videoWidth;
    tempCanvas.height = video.videoHeight;
    const ctx = tempCanvas.getContext('2d');
    
    // Flip horizontally to match what user sees
    ctx.translate(tempCanvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
    
    const imageData = tempCanvas.toDataURL('image/jpeg', 0.8);
    pythonProcessing = true;
    
    const payload = { mode, image_data: imageData };
    if (faceName) payload.face_name = faceName;
    
    ipcRenderer.send('process-image-python', payload);
}

ipcRenderer.on('python-result', (event, result) => {
    pythonProcessing = false;
    console.log("Python Result:", result);

    if (result.success && result.faces) {
        // Handle List Result - even if not in scanning mode
        renderFaceList(result.faces);
        return;
    }

    if (result.success && result.message === "Deleted successfully") {
        showNotification("Đã xóa diện mạo thành công!");
        loadFaceList();
        return;
    }

    if (result.success && result.message === "Registered successfully") {
        // Dữ liệu đã được lưu hoàn tất kèm tên - Tự động quay về
        isPythonRegistered = true;
        showNotification(`Đã đăng ký thành công diện mạo: ${result.name}`);
        switchToLockScreen();
        return;
    }

    if (!isProcessing) return;

    if (result.success) {
        if (result.match) {
            handleRecognitionSuccess(result.name || "người dùng");
        } else {
            // Nếu Python không khớp nhưng JS cũng đang chạy, chúng ta để JS quyết định hoặc chỉ thông báo nhẹ
            if (result.error === "No face detected") {
                // Đừng làm gì cả, để JS tiếp tục tìm
            } else {
                scanStatusMsg.innerText = "Python: Chưa khớp khuôn mặt...";
            }
        }
    } else {
        // Handle Error globally (both scanning and management/naming)
        const errorText = result.error || "Lỗi không xác định";
        console.error("Python Logic Error:", errorText);

        if (result.exists) {
            if (isProcessing) {
                scanStatusMsg.innerText = errorText;
                scanStatusMsg.style.color = "#ff4d4d";
                stopScanWithError(errorText);
            } else {
                // Not scanning -> probably registering via modal
                const namingError = document.getElementById('naming-error');
                if (namingError) namingError.innerText = errorText;
                resetSaveButton();
            }
        } else {
            if (!isProcessing) {
                // If in management modal or naming modal
                const namingError = document.getElementById('naming-error');
                if (namingError) {
                    namingError.innerText = errorText;
                    resetSaveButton();
                } else {
                    faceList.innerHTML = `<p class="error" style="color:#ff4d4d">Lỗi: ${errorText}</p>`;
                }
            }
        }
    }
});

function stopScanWithError(message) {
    isProcessing = false;
    if (pythonInterval) {
        clearInterval(pythonInterval);
        pythonInterval = null;
    }
    setTimeout(() => {
        showNotification(message);
        switchToLockScreen();
    }, 1500);
}

function resetSaveButton() {
    saveFaceBtn.disabled = false;
    saveFaceBtn.innerText = "Lưu diện mạo";
}

function handleRecognitionSuccess(name) {
    scanStatusMsg.innerText = `Chào ${name}! Đang mở khóa...`;
    scanStatusMsg.style.color = "#00f2ff";
    isProcessing = false;
    if (pythonInterval) {
        clearInterval(pythonInterval);
        pythonInterval = null;
    }
    setTimeout(() => {
        switchToLockScreen();
        ipcRenderer.send('unlock-success');
    }, 1000);
}

function handleRegistrationSuccess() {
    isProcessing = false;
    if (pythonInterval) {
        clearInterval(pythonInterval);
        pythonInterval = null;
    }
    
    // Show naming modal instead of just finishing
    namingModal.classList.add('active');
    faceNameInput.focus();
}

// Naming Modal setup before Scan
saveFaceBtn.addEventListener('click', () => {
    const name = faceNameInput.value.trim() || "Diện mạo mới";
    currentRegisteringName = name;
    
    namingModal.classList.remove('active');
    faceNameInput.value = '';
    
    // Bắt đầu chuyển sang màn hình quét
    switchToScanScreen(true);
});

// Recognition & Registration logic remains the same but manual trigger is removed
async function handleRecognition(detection) {
    if (!faceMatcher) {
        scanStatusMsg.innerText = "Chưa có mẫu đăng ký. Vui lòng đăng ký trước.";
        return;
    }

    const result = faceMatcher.findBestMatch(detection.descriptor);
    
    if (result.label === 'User' && result.distance < 0.55) {
        scanStatusMsg.innerText = "Chào bạn! Đang mở khóa...";
        scanStatusMsg.style.color = "#00f2ff";
        isProcessing = false;
        setTimeout(() => {
            switchToLockScreen();
            ipcRenderer.send('unlock-success');
        }, 1000);
    } else {
        scanStatusMsg.innerText = "Khuôn mặt chưa khớp!";
        scanStatusMsg.style.color = "#ff4d4d";
    }
}

// Handle Registration
async function handleRegistration(detection) {
    scanStatusMsg.innerText = "Đang đăng ký...";
    const descriptor = detection.descriptor;
    
    // Save to localStorage
    localStorage.setItem('registeredFace', JSON.stringify(Array.from(descriptor)));
    registeredDescriptor = descriptor;
    faceMatcher = new faceapi.FaceMatcher(new faceapi.LabeledFaceDescriptors('User', [registeredDescriptor]));

    scanStatusMsg.innerText = "Đăng ký thành công!";
    scanStatusMsg.style.color = "#00f2ff";
    
    isProcessing = false;
    setTimeout(() => {
        switchToLockScreen();
    }, 1500);
}

// UI State Management
function switchToScanScreen(register = false) {
    isRegistering = register;
    lockScreen.classList.remove('active');
    scanScreen.classList.add('active');
    scanStatusMsg.innerText = "Đang khởi tạo...";
    scanStatusMsg.style.color = "white";
    
    startCamera().then(success => {
        if (success) {
            video.onloadedmetadata = () => startDetection();
        }
    });
}

function switchToLockScreen() {
    stopCamera();
    isProcessing = false;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    scanScreen.classList.remove('active');
    lockScreen.classList.add('active');
    
    // Reset save button state if needed
    saveFaceBtn.disabled = false;
    saveFaceBtn.innerText = "Lưu diện mạo";
}

// Event Listeners
document.getElementById('unlock-btn').addEventListener('click', () => {
    if (!registeredDescriptor && !isPythonRegistered) {
        showNotification("Bạn chưa đăng ký khuôn mặt nào! Vui lòng nhấn 'Đăng ký mới' để thiết lập.");
        return;
    }
    switchToScanScreen(false);
});

function showNotification(message) {
    notificationMsg.innerText = message;
    notificationModal.classList.add('active');
}

closeNotificationBtn.addEventListener('click', () => {
    notificationModal.classList.remove('active');
});

// Close notification on click outside
notificationModal.addEventListener('click', (e) => {
    if (e.target === notificationModal) {
        notificationModal.classList.remove('active');
    }
});

document.getElementById('register-btn').addEventListener('click', () => {
    currentAuthAction = 'register';
    passwordModal.classList.add('active');
    adminPass.focus();
});

document.getElementById('close-modal-btn').addEventListener('click', () => {
    passwordModal.classList.remove('active');
    adminPass.value = '';
    errorMsg.innerText = '';
});

document.getElementById('verify-pass-btn').addEventListener('click', () => {
    handlePasswordVerify();
});

adminPass.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handlePasswordVerify();
});

let isExitFlow = false;

function handlePasswordVerify() {
    const password = adminPass.value;
    const type = (currentAuthAction === 'settings' || currentAuthAction === 'exit') ? 'secret' : 'admin';
    
    ipcRenderer.send('verify-password', { password, type });
}

ipcRenderer.on('verify-password-result', (event, { isValid, type }) => {
    if (isValid) {
        passwordModal.classList.remove('active');
        adminPass.value = '';
        errorMsg.innerText = '';
        
        if (currentAuthAction === 'register') {
            // Hiển thị bảng đặt tên TRƯỚC khi quét
            namingModal.classList.add('active');
            faceNameInput.focus();
        } else if (currentAuthAction === 'exit') {
            ipcRenderer.send('exit-app-verified');
        } else if (currentAuthAction === 'settings') {
            openManagement();
        }
        currentAuthAction = null;
    } else {
        errorMsg.innerText = type === 'secret' ? "Sai mật khẩu bí mật!" : "Sai mật khẩu!";
    }
});

// Management Logic
function openManagement() {
    managementModal.classList.add('active');
    loadFaceList();
}

function loadFaceList() {
    faceList.innerHTML = '<p>Đang tải...</p>';
    ipcRenderer.send('process-image-python', { mode: 'list', image_data: '' });
}

function renderFaceList(faces) {
    isPythonRegistered = faces.length > 0;
    if (faces.length === 0) {
        faceList.innerHTML = '<p>Chưa có dữ liệu khuôn mặt nào.</p>';
        return;
    }
    
    faceList.innerHTML = faces.map(f => `
        <div class="face-item">
            <div class="face-info">
                <h4>${f.name}</h4>
                <p>ID: ${f.id} - Ngày: ${f.date}</p>
            </div>
            <button class="delete-icon-btn" onclick="deleteFace('${f.id}')">
                &times;
            </button>
        </div>
    `).join('');
}

// Custom Confirm Dialog
function showCustomConfirm(message, onConfirm) {
    confirmModalMsg.innerText = message;
    confirmCallback = onConfirm;
    confirmationModal.classList.add('active');
}

confirmYesBtn.addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    confirmationModal.classList.remove('active');
    confirmCallback = null;
});

confirmNoBtn.addEventListener('click', () => {
    confirmationModal.classList.remove('active');
    confirmCallback = null;
});

// Expose to window for inline onclick
window.deleteFace = (id) => {
    showCustomConfirm("Bạn có chắc chắn muốn xóa diện mạo này không?", () => {
        ipcRenderer.send('process-image-python', { mode: 'delete', face_id: id, image_data: '' });
    });
};

settingsBtn.addEventListener('click', () => {
    currentAuthAction = 'settings';
    passwordModal.classList.add('active');
    adminPass.focus();
});

closeManagementBtn.addEventListener('click', () => {
    managementModal.classList.remove('active');
});

// Add a button inside Management to open Security Settings
const securityBtn = document.createElement('button');
securityBtn.className = 'primary-btn';
securityBtn.style.marginTop = '10px';
securityBtn.innerText = 'Đổi mật khẩu bảo mật';
securityBtn.onclick = () => {
    settingsModal.classList.add('active');
};
managementModal.querySelector('.modal-content').insertBefore(securityBtn, managementModal.querySelector('.modal-footer'));

saveSettingsBtn.addEventListener('click', () => {
    const adminP = document.getElementById('new-admin-pass').value;
    const secretP = document.getElementById('new-secret-pass').value;
    
    const updates = {};
    if (adminP) updates.adminPass = adminP;
    if (secretP) updates.secretPass = secretP;
    
    if (Object.keys(updates).length > 0) {
        ipcRenderer.send('update-config', updates);
        settingsMsg.innerText = "Đã cập nhật mật khẩu thành công!";
        setTimeout(() => {
            settingsModal.classList.remove('active');
            settingsMsg.innerText = '';
        }, 1500);
    }
});

closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('active');
});

document.getElementById('cancel-scan-btn').addEventListener('click', () => {
    if (pythonInterval) {
        clearInterval(pythonInterval);
        pythonInterval = null;
    }
    switchToLockScreen();
});

// Clock Logic
function updateClock() {
    const now = new Date();
    
    // Time: 24h format
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    clockTime.innerText = `${hours}:${minutes}:${seconds}`;
    
    // Date: Vietnamese format
    const days = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
    const dayName = days[now.getDay()];
    const date = now.getDate();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    clockDate.innerText = `${dayName}, Ngày ${date} Tháng ${month}, ${year}`;
}

setInterval(updateClock, 1000);
updateClock();

// Initialize
// Load models in background, but don't start camera until needed
async function init() {
    await loadModels();
    ipcRenderer.send('check-registration-status');
}

init();

ipcRenderer.on('registration-status-result', (event, status) => {
    isPythonRegistered = status.hasPythonReg;
    console.log("Initial Python Registration Status:", isPythonRegistered);
});

// Listen for lock/unlock from Main
ipcRenderer.on('app-locked', () => {
    switchToLockScreen();
    document.getElementById('status-text').innerText = "Đã Khóa";
});

ipcRenderer.on('app-unlocked', () => {
    document.getElementById('status-text').innerText = "Đã Mở Khóa";
});

ipcRenderer.on('request-exit-pass', () => {
    currentAuthAction = 'exit';
    passwordModal.classList.add('active');
    adminPass.focus();
    errorMsg.innerText = '';
});
