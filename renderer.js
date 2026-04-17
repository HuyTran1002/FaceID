const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

// --- APP STATE V2.3.4.6 (PERSONALIZED PRO MASTER) ---
let isProcessing = false;
let isRegistering = false;
let isLocked = true;
let currentRegisteringName = "";
let scanProgress = 0;

// Roulette System v4.1
let rouletteInterval = null;
let profilePool = [];
let pythonReady = false;
let pythonProcessing = false;
let USER_DATA_PATH = "";
let APP_CONFIG = { adminPass: '123456', secretPass: '999999' };
let currentAuthAction = "";
let cameraStream = null;

// UI ELEMENTS
const video = document.getElementById('video');
const scanScreen = document.getElementById('scan-screen');
const lockScreen = document.getElementById('lock-screen');
const scanStatusMsg = document.getElementById('scan-status-msg');
const progressBar = document.getElementById('scan-progress-bar');
const completionText = document.getElementById('completion-text');
const sculptorCanvas = document.getElementById('sculptor-canvas');
const sctx = sculptorCanvas?.getContext('2d');
const clockTime = document.getElementById('clock-time');
const clockDate = document.getElementById('clock-date');

// --- INITIALIZATION ---
window.addEventListener('DOMContentLoaded', () => {
    updateClock();
    setInterval(updateClock, 1000);
    loadSettings();
    
    if (sculptorCanvas) {
        sculptorCanvas.width = 300;
        sculptorCanvas.height = 400;
    }

    // Tương tác phím Enter (v2.3.2+)
    document.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') {
            const activeModal = document.querySelector('.modal.active');
            if (activeModal) {
                const primaryBtn = activeModal.querySelector('.primary-btn');
                if (primaryBtn) primaryBtn.click();
            }
        } else if (e.key === 'Escape' && isProcessing) {
            stopScan();
        }
    });

    // Trình lắng nghe sự kiện nút bấm (v2.3.2.1)
    document.getElementById('save-settings-btn')?.addEventListener('click', saveAdvancedSettings);
    document.getElementById('close-management-btn')?.addEventListener('click', () => closeModal('management-modal'));
    document.getElementById('close-modal-btn')?.addEventListener('click', () => closeModal('password-modal'));
    document.getElementById('close-notification-btn')?.addEventListener('click', () => closeModal('notification-modal'));
    document.getElementById('cancel-scan-btn')?.addEventListener('click', stopScan);
    
    document.getElementById('confirm-yes-btn')?.addEventListener('click', () => {
        if (window.pendingDeleteId) {
            executeDeleteFace(window.pendingDeleteId);
            closeModal('confirmation-modal');
        }
    });
    document.getElementById('confirm-no-btn')?.addEventListener('click', () => closeModal('confirmation-modal'));
});

function updateClock() {
    const now = new Date();
    if (clockTime) clockTime.innerText = now.toLocaleTimeString('vi-VN', { hour12: false });
    if (clockDate) clockDate.innerText = now.toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
}

async function initCamera() {
    try {
        if (cameraStream) stopCamera();
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: 24 } });
        video.srcObject = cameraStream;
    } catch (err) { 
        console.error("CAMERA ERROR", err);
        updateUIStatus("LỖI CAMERA: Vui lòng kiểm tra quyền truy cập!");
        alert("KHÔNG THỂ KHỞI TẠO CAMERA: " + err.message);
    }
}

function stopCamera() {
    if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        cameraStream = null;
        video.srcObject = null;
    }
}

// --- SKETCHING LOGIC V2.3.4 (PRO MASTER) ---
function drawFaceSketch(result) {
    if (!result || !result.features) return;
    const f = result.features;
    const alpha = isRegistering ? 1.0 : 0.6;
    const cw = sculptorCanvas.width;
    const ch = sculptorCanvas.height;

    // --- ASPECT RATIO COMPENSATION v2.5.1 ---
    const vw = video.videoWidth || 480;
    const vh = video.videoHeight || 360;
    const vAR = vw / vh;
    const cAR = cw / ch;

    let targetW, targetH, offsetX = 0, offsetY = 0;
    if (vAR > cAR) {
        targetW = cw;
        targetH = cw / vAR;
        offsetY = (ch - targetH) / 2;
    } else {
        targetH = ch;
        targetW = ch * vAR;
        offsetX = (cw - targetW) / 2;
    }

    const mapX = (x) => offsetX + x * targetW;
    const mapY = (y) => offsetY + y * targetH;

    sctx.clearRect(0, 0, cw, ch);
    sctx.strokeStyle = `rgba(0, 242, 255, ${alpha})`;
    sctx.lineWidth = 1.5;
    sctx.lineCap = 'round';

    const drawPrecisePath = (ctx, pts, close = false) => {
        if (!pts || pts.length < 2) return;
        ctx.beginPath();
        ctx.moveTo(mapX(pts[0][0]), mapY(pts[0][1]));
        for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(mapX(pts[i][0]), mapY(pts[i][1]));
        }
        if (close) ctx.closePath();
        ctx.stroke();
    };

    if (f.silhouette) drawPrecisePath(sctx, f.silhouette, true);
    if (f.left_eye) drawPrecisePath(sctx, f.left_eye, true);
    if (f.right_eye) drawPrecisePath(sctx, f.right_eye, true);

    // Vẽ Môi (v4.2.4: Tắt hoàn toàn nếu bị che khuất ở cả 2 chế độ)
    const isOccluded = (result.occlusion && result.occlusion.mouth) || result.cleanroom_mode;
    if (f.lips && !isOccluded) {
        drawPrecisePath(sctx, f.lips, true);
    }

    if (f.brows) {
        if (f.brows.left) drawPrecisePath(sctx, f.brows.left, false);
        if (f.brows.right) drawPrecisePath(sctx, f.brows.right, false);
    }
    if (f.bridge) drawPrecisePath(sctx, f.bridge, false);

    // Iris Tracking (v4.0)
    if (f.iris) {
        sctx.lineWidth = 1;
        sctx.strokeStyle = "rgba(0, 242, 255, 0.8)";
        if (f.iris.left) drawPrecisePath(sctx, f.iris.left, true);
        if (f.iris.right) drawPrecisePath(sctx, f.iris.right, true);
    }

    // Bio-Mesh Lưới (v4.0)
    if (f.mesh) {
        sctx.lineWidth = 0.5;
        sctx.strokeStyle = `rgba(0, 242, 255, ${alpha * 0.3})`;
        if (f.mesh.horizontal) drawPrecisePath(sctx, f.mesh.horizontal, false);
        if (f.mesh.vertical) drawPrecisePath(sctx, f.mesh.vertical, false);
    }

    if (f.bio) updateBioOverlay(f.bio);

    // Laser Quét
    const laserY = mapY(result.pitch / 50 + 0.5); // Hiệu chỉnh laser theo pitch chuẩn hóa
    sctx.shadowBlur = 10;
    sctx.shadowColor = "var(--primary)";
    sctx.fillStyle = "rgba(0, 242, 255, 0.4)";
    sctx.fillRect(0, laserY, cw, 2);
    sctx.shadowBlur = 0;
}

// (Hàm drawPath cũ xóa - đã tích hợp vào drawPrecisePath bên trong drawFaceSketch v2.5.1)

function updateBioOverlay(bio) {
    const overlay = document.getElementById('bio-overlay');
    if (!overlay) return;
    overlay.innerHTML = `
        <div class="bio-stat"><span>BPM:</span> <span class="pulse-text">${bio.bpm}</span></div>
        <div class="bio-stat"><span>DEPTH:</span> <span>${bio.depth}mm</span></div>
        <div class="bio-stat"><span>SKIN:</span> <span style="color:${bio.skin}; text-shadow: 0 0 5px ${bio.skin}">${bio.skin}</span></div>
        <div class="bio-stat"><span>FOCUS:</span> <span>${Math.round(bio.focus * 100)}%</span></div>
    `;
    overlay.style.borderLeftColor = bio.skin;
}

// --- SCANNING SYSTEM ---
async function startScan(mode, faceName = "") {
    isProcessing = true;
    isRegistering = (mode === 'register');
    currentRegisteringName = faceName;
    
    // Reset UI v4.0 HUD
    scanProgress = 0;
    if (progressBar) progressBar.style.width = '0%';
    if (completionText) completionText.innerText = '0%';
    if (sctx) sctx.clearRect(0, 0, sculptorCanvas.width, sculptorCanvas.height);
    
    // Dọn dẹp ảnh đối soát cũ (v4.0.1)
    const oldProfileImg = document.getElementById('profile-match-img');
    const oldNameBadge = document.getElementById('match-name-badge');
    if (oldProfileImg) oldProfileImg.src = "";
    if (oldNameBadge) {
        oldNameBadge.innerText = "SEARCHING...";
        oldNameBadge.classList.add('searching-blink');
    }
    scanScreen.classList.remove('matching');
    
    // FACE ROULETTE INIT (v4.1)
    if (!isRegistering) {
        startFaceRoulette();
    }
    
    // HUD HUD Mode Toggling
    scanScreen.classList.add('active');
    scanScreen.classList.remove('register-mode', 'detect-mode');
    scanScreen.classList.add(isRegistering ? 'register-mode' : 'detect-mode');
    
    lockScreen.classList.remove('active');
    updateUIStatus(isRegistering ? "KIỂM TRA LUỒNG AI..." : "ĐANG KHỞI TẠO AI...");
    
    await initCamera(); 
    triggerNextFrame(800); 
}

function stopScan() {
    isProcessing = false;
    stopCamera(); 
    
    clearInterval(rouletteInterval);
    rouletteInterval = null;
    
    scanScreen.classList.remove('active', 'register-mode', 'detect-mode', 'matching');
    lockScreen.classList.add('active');
    if (sctx) sctx.clearRect(0, 0, sculptorCanvas.width, sculptorCanvas.height);
}

// --- FACE ROULETTE ENGINE v4.1 ---
function startFaceRoulette() {
    profilePool = [];
    const imgEl = document.getElementById('profile-match-img');
    const pipPanel = document.querySelector('.floating-pip-panel');
    const faces = getFaces();
    const profileDir = path.join(USER_DATA_PATH, 'profiles');
    
    // Nạp tất cả ảnh hồ sơ có sẵn
    faces.forEach(f => {
        if (f.thumbnail) {
            const tPath = path.join(profileDir, f.thumbnail);
            if (fs.existsSync(tPath)) {
                try {
                    const b64 = fs.readFileSync(tPath, 'base64');
                    profilePool.push(`data:image/jpeg;base64,${b64}`);
                } catch(e) {}
            }
        }
    });

    if (profilePool.length === 0) {
        if (imgEl) imgEl.src = ""; // Hoặc ảnh placeholder nếu có
        return;
    }

    // Nếu chỉ có 1 người, thêm một ảnh "Bóng đen" để tạo hiệu ứng chạy (v4.1.2)
    if (profilePool.length === 1) {
        profilePool.push("assets/user_silhouette.png"); 
    }

    let idx = 0;
    if (pipPanel) pipPanel.classList.add('roulette-active');

    clearInterval(rouletteInterval);
    rouletteInterval = setInterval(() => {
        if (!isProcessing || isRegistering) {
            clearInterval(rouletteInterval);
            if (pipPanel) pipPanel.classList.remove('roulette-active');
            return;
        }
        
        // Chỉ quay khi chưa tìm thấy mục tiêu (chưa có lớp matching)
        if (!scanScreen.classList.contains('matching')) {
            imgEl.src = profilePool[idx];
            idx = (idx + 1) % profilePool.length;
        } else {
            if (pipPanel) pipPanel.classList.remove('roulette-active');
            clearInterval(rouletteInterval);
        }
    }, 100);
}

function updateUIStatus(msg) {
    if (scanStatusMsg) scanStatusMsg.innerText = msg;
}

function triggerNextFrame(delay = 80) {
    if (!isProcessing || !pythonReady) return;
    setTimeout(() => {
        if (isProcessing && !pythonProcessing) sendFrameToPython();
    }, delay);
}

function sendFrameToPython() {
    if (!video.videoWidth) return;
    pythonProcessing = true;
    
    const targetWidth = 480;
    const scale = targetWidth / video.videoWidth;
    const targetHeight = video.videoHeight * scale;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = targetWidth; tempCanvas.height = targetHeight;
    const tctx = tempCanvas.getContext('2d');
    tctx.translate(tempCanvas.width, 0); tctx.scale(-1, 1);
    tctx.drawImage(video, 0, 0, targetWidth, targetHeight);
    
    ipcRenderer.send('process-image', {
        mode: isRegistering ? 'register' : 'detect',
        image_data: tempCanvas.toDataURL('image/jpeg', 0.6),
        faceName: currentRegisteringName,
        user_data_path: USER_DATA_PATH
    });
}

ipcRenderer.on('python-result', (event, result) => {
    pythonProcessing = false;
    if (isProcessing) triggerNextFrame(30);

    // console.log("AI DEBUG RESULT:", result); // Bật để kiểm tra dữ liệu

    if (result.status === "READY") {
        updateUIStatus("AI ĐÃ SẴN SÀNG");
        pythonReady = true;
    }
    
    if (result.success) {
        if (result.features) drawFaceSketch(result);

        if (result.status === "sculpting") {
            scanProgress = result.progress || 0;
            progressBar.style.width = `${scanProgress}%`;
            completionText.innerText = `${scanProgress}%`;
            
            let statusPrefix = "";
            if (result.cleanroom_mode) statusPrefix = "[CHẾ ĐỘ PHÒNG SẠCH] ";
            else if (result.mask_detected) statusPrefix = "[CHẾ ĐỘ CHE KHUẤT] ";
            
            updateUIStatus(statusPrefix + (isRegistering ? `ĐANG PHÁC THẢO: ${scanProgress}%` : "ĐANG ĐỐI SOÁT..."));
        } else if (result.status === "verifying") {
            updateUIStatus(result.detail || "ĐANG XÁC THỰC BẢO MẬT...");
            if (progressBar) progressBar.style.width = (result.progress || 0) + '%';
            if (completionText) completionText.innerText = (result.progress || 0) + '%';
            
            // PROFILE VISION DISPLAY (v4.0 HUD)
            if (result.profile_img) {
                // Khóa vòng quay Roulette khi tìm thấy mục tiêu
                if (rouletteInterval) {
                    clearInterval(rouletteInterval);
                    rouletteInterval = null;
                }
                
                const imgEl = document.getElementById('profile-match-img');
                const badge = document.getElementById('match-name-badge');
                if (imgEl && result.profile_img) imgEl.src = `data:image/jpeg;base64,${result.profile_img}`;
                if (badge) {
                    badge.innerText = result.match ? result.match.toUpperCase() : "MASTER";
                    badge.classList.remove('searching-blink');
                }
                scanScreen.classList.add('matching');
            }

            const canvas = document.getElementById('sculptor-canvas');
            if (canvas) canvas.style.boxShadow = "0 0 20px rgba(0, 242, 255, 0.4)";
        } else if (result.status === "sculpt_complete") {
            showNotification("ĐĂNG KÝ THÀNH CÔNG", "Dữ liệu khuôn mặt đã được lưu trữ an toàn.");
            stopScan();
        } else if (result.status === "success" || result.status === "unknown") {
            if (result.status === "success") {
                isProcessing = false;
                stopCamera();
                const welcomeName = result.match ? result.match.toUpperCase() : "MASTER";
                const isStrict = result.security_level === "STRICT";
                
                updateUIStatus(`XIN CHÀO: ${welcomeName}!`);
                if (progressBar) progressBar.style.width = '100%';
                
                showNotification(
                    isStrict ? "XÁC THỰC BẢO MẬT CAO" : "XÁC THỰC THÀNH CÔNG", 
                    `Chào mừng trở lại, ${welcomeName}! ${isStrict ? 'Hệ thống đã nhận diện xuyên lớp phụ kiện.' : 'Hệ thống đã mở khóa.'}`
                );
                
                setTimeout(() => {
                    ipcRenderer.send('unlock-success');
                    closeModal('notification-modal');
                }, 1800);
            } else {
                updateUIStatus(result.occlusion ? "KẾT QUẢ KHÔNG ĐỦ TIN CẬY - VUI LÒNG THÁO MẶT NẠ" : "KHÔNG XÁC ĐỊNH - TỪ CHỐI");
                if (progressBar) progressBar.style.width = '0%';
                if (completionText) completionText.innerText = '0%';
                
                scanScreen.classList.remove('matching');
                const canvas = document.getElementById('sculptor-canvas');
                if (canvas) canvas.style.boxShadow = "0 0 25px rgba(255, 0, 0, 0.6)";
            }
        }
    } else {
        if (result.status === "duplicate_face") {
            showNotification("LỖI ĐĂNG KÝ", `Khuôn mặt này đã tồn tại dưới tên: ${result.match}`);
            stopScan();
        }
    }
});

// --- UI EVENT HANDLERS ---
function getFaces() {
    const jsonPath = path.join(USER_DATA_PATH, 'faces_v2.json');
    if (fs.existsSync(jsonPath)) {
        try { return JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch(e) { return []; }
    }
    return [];
}

document.getElementById('unlock-btn').addEventListener('click', () => {
    if (getFaces().length > 0) startScan('detect');
    else showNotification("CHƯA CÓ DỮ LIỆU", "Vui lòng 'Đăng Kí' khuôn mặt trước.");
});

document.getElementById('register-btn').addEventListener('click', () => {
    currentAuthAction = 'register';
    openModal('password-modal');
});

document.getElementById('settings-btn').addEventListener('click', () => {
    currentAuthAction = 'settings';
    openModal('password-modal');
});

document.getElementById('verify-pass-btn').addEventListener('click', () => {
    const pass = document.getElementById('admin-pass').value;
    const errorMsg = document.getElementById('error-msg');
    errorMsg.innerText = ""; 

    if (currentAuthAction === 'register') {
        if (pass === APP_CONFIG.secretPass) {
            closeModal('password-modal');
            openModal('naming-modal');
        } else { errorMsg.innerText = "Mật mã USER không chính xác!"; }
    } else {
        if (pass === APP_CONFIG.adminPass) {
            closeModal('password-modal');
            if (currentAuthAction === 'settings') loadAndShowFaceList();
            else if (currentAuthAction === 'exit') ipcRenderer.send('exit-app-verified');
        } else { errorMsg.innerText = "Mật mã ADMIN không chính xác!"; }
    }
});

document.getElementById('save-face-btn').addEventListener('click', () => {
    const name = document.getElementById('face-name-input').value.trim();
    if (!name) return;
    const existing = getFaces();
    if (existing.some(f => f.name.toLowerCase() === name.toLowerCase())) {
        document.getElementById('naming-error').innerText = "Tên này đã tồn tại!";
        return;
    }
    closeModal('naming-modal'); 
    startScan('register', name); 
});

function loadAndShowFaceList() {
    const list = document.getElementById('face-list');
    list.innerHTML = "";
    const faces = getFaces();
    faces.forEach(f => {
        const item = document.createElement('div');
        item.className = 'face-item';
        item.innerHTML = `<span>${f.name}</span><button class="delete-btn" onclick="askDeleteFace('${f.id}')">Xóa</button>`;
        list.appendChild(item);
    });
    openModal('management-modal');
}

function saveAdvancedSettings() {
    const newAdmin = document.getElementById('new-admin-pass').value;
    const newSecret = document.getElementById('new-secret-pass').value;
    const updates = {};
    if (newAdmin) updates.adminPass = newAdmin;
    if (newSecret) updates.secretPass = newSecret;
    if (Object.keys(updates).length > 0) {
        ipcRenderer.send('update-config', updates);
        APP_CONFIG = { ...APP_CONFIG, ...updates };
        document.getElementById('settings-msg').innerText = "Đã cập nhật mật khẩu!";
    }
}

window.askDeleteFace = (id) => {
    window.pendingDeleteId = id;
    const face = getFaces().find(f => f.id === id);
    document.getElementById('confirm-modal-msg').innerText = `Bạn có chắc muốn xóa khuôn mặt "${face ? face.name : 'này'}"?`;
    openModal('confirmation-modal');
};

function executeDeleteFace(id) {
    const jsonPath = path.join(USER_DATA_PATH, 'faces_v2.json');
    let faces = getFaces().filter(f => f.id !== id);
    fs.writeFileSync(jsonPath, JSON.stringify(faces, null, 4));
    loadAndShowFaceList();
}

function openModal(id) { 
    const m = document.getElementById(id); 
    if (!m) return;
    m.classList.add('active'); 
    const inputs = m.querySelectorAll('input');
    // XÓA TRẮNG TOÀN BỘ Ô NHẬP LIỆU (v3.1.0)
    inputs.forEach(i => { i.value = ''; }); 
    if (inputs.length > 0) inputs[0].focus();
}

function closeModal(id) { 
    const m = document.getElementById(id); m?.classList.remove('active'); 
}

function showNotification(title, msg) {
    document.getElementById('notification-msg').innerText = msg;
    openModal('notification-modal');
}

function loadSettings() { ipcRenderer.send('get-user-data-path'); }
ipcRenderer.on('user-data-path', (event, p, config) => { 
    USER_DATA_PATH = p; if (config) APP_CONFIG = config; 
});

// KHÔI PHỤC IPC PHÍM TẮT (v2.3.2.2)
ipcRenderer.on('request-exit-pass', () => {
    stopScan(); // DỪNG QUÉT KHI YÊU CẦU THOÁT (v2.3.4.9)
    currentAuthAction = 'exit';
    document.getElementById('modal-title').innerText = "XÁC NHẬN THOÁT";
    openModal('password-modal');
});

ipcRenderer.on('app-locked', () => { 
    isLocked = true; 
    stopScan(); // DỌN DẸP TOÀN BỘ TRẠNG THÁI QUÉT (v2.3.4.8)
    if (progressBar) progressBar.style.width = '0%';
    if (completionText) completionText.innerText = '0%';
    updateUIStatus("HỆ THỐNG ĐÃ KHÓA");
    lockScreen.classList.add('active'); 
    scanScreen.classList.remove('active');
});
ipcRenderer.on('app-unlocked', () => { isLocked = false; lockScreen.classList.remove('active'); });

// --- AUTO UPDATE UI HANDLERS v2.6.0 ---
let updateUrl = "";

ipcRenderer.on('update-available', (event, info) => {
    stopScan(); // DỪNG QUÉT CAMERA KHI PHÁT HIỆN CẬP NHẬT (v3.1.0)
    updateUrl = info.downloadUrl;
    document.getElementById('update-version-text').innerText = `⚡ Phát hiện bản mới: v${info.version}`;
    document.getElementById('update-notes-text').innerText = info.releaseNotes;
    
    // Reset UI
    document.getElementById('update-progress-container').style.display = 'none';
    document.getElementById('update-footer').style.display = 'flex';
    document.getElementById('update-progress-bar').style.width = '0%';
    
    openModal('update-modal');
});

ipcRenderer.on('update-not-available', (event, msg) => {
    stopScan(); // DỌN DẸP KHI KIỂM TRA XONG (v3.1.0)
    showNotification("HỆ THỐNG MỚI NHẤT", msg);
});

ipcRenderer.on('update-error', (event, err) => {
    stopScan();
    showNotification("LỖI CẬP NHẬT", "Gặp sự cố: " + err);
    closeModal('update-modal');
});

ipcRenderer.on('update-progress', (event, percent) => {
    document.getElementById('update-progress-container').style.display = 'block';
    document.getElementById('update-footer').style.display = 'none';
    document.getElementById('update-progress-bar').style.width = percent + '%';
    document.getElementById('update-status-text').innerText = `Đang tải: ${percent}%`;
});

document.getElementById('update-yes-btn').addEventListener('click', () => {
    if (updateUrl) {
        ipcRenderer.send('start-update', { downloadUrl: updateUrl });
    }
});

document.getElementById('update-no-btn').addEventListener('click', () => {
    closeModal('update-modal');
});
