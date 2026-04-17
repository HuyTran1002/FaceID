import sys
import os
import json
import base64
import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
import face_recognition
import uuid
from datetime import datetime
import random
import time
import atexit

# --- AI CONFIG v3.1.0 (PRECISION OPTICS & HYBRID CYBER-SCAN) ---
def log_status(status, detail=""):
    print(json.dumps({"status": status, "detail": detail}), flush=True)

log_status("SCULPTOR_SHELL_INIT", "Precision Optics Core v3.1.0 Starting...")

# State v2.8.0
scan_state = {
    "is_active": False, 
    "encodings": [], 
    "angles": [],
    "verify_buffer": [], # Lưu trữ kết quả khớp liên tiếp (v2.8.0)
    "last_match": None,    # Lưu tên người dùng khớp gần nhất
    "best_reg_frame": None, # Ảnh nhìn thẳng nhất để làm profile
    "best_reg_pitch": 999.0, # Độ nghiêng thấp nhất tìm thấy
    "miss_counter": 0        # Bộ đếm sai số linh hoạt (v4.2.0)
}
last_biodata_update = 0
current_biodata = {"bpm": 72, "depth": 0.5, "focus": 0.95, "skin": "#00f2ff"}

def get_stabilized_img(img):
    # Bộ lọc chuẩn hóa ánh sáng song phương (v2.8.0)
    # Giảm nhiễu lóa sáng trên kính nhưng giữ lại chi tiết viền mắt
    return cv2.bilateralFilter(img, 5, 50, 50)

def calculate_pitch_cleanroom(landmarks, w, h):
    bridge = landmarks[6].y * h
    inner_eyes_y = (landmarks[133].y + landmarks[362].y) / 2 * h
    diff = bridge - inner_eyes_y
    return diff * 5

def get_skin_color(img, landmarks, w, h):
    try:
        p1 = (int(landmarks[123].x * w), int(landmarks[123].y * h))
        c1 = img[p1[1], p1[0]]
        return '#{:02x}{:02x}{:02x}'.format(c1[2], c1[1], c1[0])
    except: return "#00f2ff"

def get_accessory_contours_v2(img, landmarks, w, h):
    try:
        # ROI khuôn mặt
        ys = [lm.y * h for lm in landmarks]; xs = [lm.x * w for lm in landmarks]
        y1, y2, x1, x2 = max(0, int(min(ys)) - 20), min(h, int(max(ys)) + 20), max(0, int(min(xs)) - 20), min(w, int(max(xs)) + 20)
        roi = img[y1:y2, x1:x2]
        if roi.size == 0: return []
        
        # --- PRECISION FILTERING v2.5.1 ---
        # 1. Bilateral Filter để làm mịn da nhưng giữ cạnh kính
        filtered = cv2.bilateralFilter(roi, 9, 75, 75)
        gray = cv2.cvtColor(filtered, cv2.COLOR_BGR2GRAY)
        
        # 2. Canny với ngưỡng động hoặc fix (giảm nhiễu)
        edges = cv2.Canny(gray, 100, 200)
        
        # 3. Nối các đường cạnh bị đứt khúc (Dilate)
        kernel = np.ones((2,2), np.uint8)
        edges = cv2.dilate(edges, kernel, iterations=1)
        edges = cv2.erode(edges, kernel, iterations=1)
        
        # Tìm contour
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        simplified = []
        for cnt in contours:
            # Chỉ lấy gọng kính hoặc vật thể đủ lớn và dài
            length = cv2.arcLength(cnt, False)
            if length > 60: # Tăng ngưỡng lọc nhiễu da (v2.5.1)
                # Làm mượt đường nét bằng xấp xỉ đa giác
                epsilon = 0.005 * length
                approx = cv2.approxPolyDP(cnt, epsilon, False)
                pts = [[(p[0][0] + x1) / w, (p[0][1] + y1) / h] for p in approx]
                simplified.append(pts)
        return simplified[:10]
    except: return []

# --- PATH RESOLUTION v2.7.0 (PACKAGING READY) ---
def get_model_path():
    # 1. Kiểm tra nếu đang chạy trong bản đóng gói EXE (PyInstaller)
    if getattr(sys, 'frozen', False):
        base_path = os.path.dirname(sys.executable)
        # Ưu tiên tìm trong resources/models (Cấu hình chuẩn v2.8.7)
        # EXE: resources/python_core/face_logic/face_logic.exe
        candidates = [
            os.path.join(base_path, '..', '..', 'models', 'face_landmarker.task'),
            os.path.join(base_path, 'models', 'face_landmarker.task'),
            os.path.join(os.path.dirname(base_path), 'models', 'face_landmarker.task'),
            os.path.join(os.getcwd(), 'models', 'face_landmarker.task'),
            os.path.join(os.getcwd(), 'resources', 'models', 'face_landmarker.task')
        ]
        for c in candidates:
            if os.path.exists(c): return os.path.abspath(c)
        
        return os.path.join(base_path, 'models', 'face_landmarker.task')
    
    # 2. Chế độ Development (chạy trực tiếp script)
    return os.path.join(os.path.dirname(__file__), 'models', 'face_landmarker.task')

# Setup Detector (v2.9.0 Traceable)
try:
    log_status("TRACE", "Searching for model path...")
    model_path = get_model_path()
    log_status("TRACE", f"Model path identified: {model_path}")
    
    if not os.path.exists(model_path):
        log_status("ERROR", f"Model file NOT FOUND at: {model_path}")
        sys.exit(1)

    log_status("TRACE", "Initializing MediaPipe Options (CPU Mode)...")
    # Sử dụng CPU để đảm bảo tương thích mọi phần cứng trong bản đóng gói (v2.9.0)
    base_options = python.BaseOptions(
        model_asset_path=model_path, 
        delegate=python.BaseOptions.Delegate.CPU
    )
    options = vision.FaceLandmarkerOptions(
        base_options=base_options, 
        output_face_blendshapes=True, 
        running_mode=vision.RunningMode.IMAGE, 
        num_faces=1
    )
    
    detector = vision.FaceLandmarker.create_from_options(options)
    atexit.register(lambda: detector.close()) # ĐẢM BẢO GIẢI PHÓNG TÀI NGUYÊN KHI THOÁT (v3.1.0)
    log_status("TRACE", "Detector Created Successfully.")
    
    log_status("READY", "Precision Engine Ready (v5.2).")
except Exception as e:
    log_status("ERROR", f"Initialization Failed: {str(e)}")
    sys.exit(1)

# Cache dữ liệu khuôn mặt (v3.0.0 - SMART SYNC)
registered_faces_cache = None
last_cache_mtime = 0

def get_faces(user_data_path):
    global registered_faces_cache, last_cache_mtime
    json_path = os.path.join(user_data_path, 'faces_v2.json')
    
    if not os.path.exists(json_path):
        registered_faces_cache = []
        return []
        
    try:
        current_mtime = os.path.getmtime(json_path)
        # Nếu mtime đã thay đổi (hoặc chưa bao giờ đọc), thì phải đọc lại từ đĩa
        if registered_faces_cache is None or current_mtime > last_cache_mtime:
            with open(json_path, 'r', encoding='utf-8') as f:
                registered_faces_cache = json.load(f)
                last_cache_mtime = current_mtime
        return registered_faces_cache
    except Exception:
        return []

def save_registered_faces(user_data_path, faces):
    global registered_faces_cache
    registered_faces_cache = faces # Cập nhật cache ngay lập tức
    json_path = os.path.join(user_data_path, 'faces_v2.json')
    with open(json_path, 'w', encoding='utf-8') as f: 
        json.dump(faces, f, indent=4, ensure_ascii=False)

while True:
    line = sys.stdin.readline()
    if not line: break
    try:
        input_data = json.loads(line)
        mode, image_b64, face_name, user_data_path = input_data.get('mode'), input_data.get('image_data'), input_data.get('faceName', 'User'), input_data.get('user_data_path', '')
        if not image_b64: continue
        if mode == 'register' and not scan_state.get("is_active"):
            scan_state.update({"is_active": True, "encodings": [], "angles": [], "best_reg_frame": None, "best_reg_pitch": 999.0})
        if isinstance(image_b64, str) and ',' in image_b64: image_b64 = image_b64.split(',')[1]
        img_bytes = base64.b64decode(image_b64)
        nparr = np.frombuffer(img_bytes, np.uint8)
        raw_img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if raw_img is None: continue
        h, w, _ = raw_img.shape
        rgb_img = cv2.cvtColor(raw_img, cv2.COLOR_BGR2RGB)
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_img)
        res = detector.detect(mp_img)
        if not res.face_landmarks:
            print(json.dumps({"success": False, "status": "no_face"}), flush=True); continue
        landmarks = res.face_landmarks[0]
        blendshapes = res.face_blendshapes[0] if res.face_blendshapes else []
        pitch = calculate_pitch_cleanroom(landmarks, w, h)
        skin_hex = get_skin_color(raw_img, landmarks, w, h)
        acc_edges = get_accessory_contours_v2(raw_img, landmarks, w, h) # v2.5.1
        mouth_occluded = False
        if blendshapes:
            m_shapes = {s.category_name: s.score for s in blendshapes}
            # Logic hỗn hợp: Blendshapes + Khoảng cách môi (v4.2.0)
            lip_dist = abs(landmarks[13].y - landmarks[14].y)
            # Logic v4.2.5: Chống nhấp nháy + Phản hồi tức thì
            is_currently_occluded = (m_shapes.get('jawOpen', 0) < 0.10 and m_shapes.get('mouthClose', 0) > 0.90) or lip_dist < 0.002
            
            if is_currently_occluded:
                # Giới hạn counter tối đa là 10 để thoát trạng thái nhanh (0.3s)
                scan_state["occlusion_counter"] = min(10, scan_state.get("occlusion_counter", 0) + 1)
            else:
                scan_state["occlusion_counter"] = max(0, scan_state.get("occlusion_counter", 0) - 1)
            
            mouth_occluded = scan_state.get("occlusion_counter", 0) > 5
        sil_idx = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
        le_idx = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]; re_idx = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]
        li_idx = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 185]
        li_iris = [468, 469, 470, 471, 472]; ri_iris = [473, 474, 475, 476, 477]
        mesh_h = [123, 50, 6, 280, 352]; mesh_v = [10, 151, 9, 8, 168, 6, 197, 195, 5, 4, 1, 19, 94, 2, 164, 0, 11]
        now = time.time()
        if now - last_biodata_update > 2:
            current_biodata.update({"bpm": random.randint(68, 85), "focus": round(random.uniform(0.92, 0.99), 2), "skin": skin_hex})
            last_biodata_update = now
        features = {
            "silhouette": [[landmarks[i].x, landmarks[i].y] for i in sil_idx],
            "left_eye": [[landmarks[i].x, landmarks[i].y] for i in le_idx], "right_eye": [[landmarks[i].x, landmarks[i].y] for i in re_idx],
            "lips": [[landmarks[i].x, landmarks[i].y] for i in li_idx],
            "iris": {"left": [[landmarks[i].x, landmarks[i].y] for i in li_iris], "right": [[landmarks[i].x, landmarks[i].y] for i in ri_iris]},
            "mesh": {"horizontal": [[landmarks[i].x, landmarks[i].y] for i in mesh_h], "vertical": [[landmarks[i].x, landmarks[i].y] for i in mesh_v]},
            "bio": current_biodata,
            "occlusion": {"mouth": mouth_occluded}
        }
        ys_px = [lm.y * h for lm in landmarks]; xs_px = [lm.x * w for lm in landmarks]
        y1, y2, x1, x2 = max(0, int(min(ys_px)) - 20), min(h, int(max(ys_px)) + 20), max(0, int(min(xs_px)) - 20), min(w, int(max(xs_px)) + 20)
        
        # 3. CHỈNH SỬA VÙNG ROI (v2.8.0)
        roi = raw_img[y1:y2, x1:x2]
        if roi.size == 0: continue
        
        # Áp dụng bộ lọc khử lóa kính cho vùng mắt/mặt
        roi_stabilized = get_stabilized_img(roi)
        rgb_roi = cv2.cvtColor(roi_stabilized, cv2.COLOR_BGR2RGB)
        
        # Encoding trên vùng ROI đã được làm sạch
        encs = face_recognition.face_encodings(rgb_roi, [(0, rgb_roi.shape[1], rgb_roi.shape[0], 0)])
        
        if not encs:
            scan_state["verify_buffer"] = []
            print(json.dumps({"success": True, "status": "sculpting", "features": features, "pitch": pitch, "cleanroom_mode": mouth_occluded}), flush=True); continue
        cur_enc = encs[0]
        # --- DYNAMIC SECURITY LEVELS v4.2.1 ---
        # 0.42: Tiêu chuẩn (Rất an toàn)
        # 0.38: Chế độ che khuất (Cân bằng lại để dễ nhận diện hơn)
        current_threshold = 0.38 if mouth_occluded else 0.42

        if mode == 'detect':
            reg = get_faces(user_data_path)
            if not reg:
                print(json.dumps({"success": True, "status": "sculpting", "features": features, "pitch": pitch, "cleanroom_mode": mouth_occluded}), flush=True); continue
            known_encs = [np.array(f['model']) for f in reg]; names = [f['name'] for f in reg]
            
            dists = face_recognition.face_distance(known_encs, cur_enc)
            min_dist = min(dists) if len(dists) > 0 else 1.0
            
            if min_dist < current_threshold:
                match_idx = np.argmin(dists)
                user_obj = reg[match_idx]
                match_name = user_obj['name']

                # Lấy ảnh hồ sơ (Profile Vision v3.5.0)
                profile_b64 = ""
                if 'thumbnail' in user_obj:
                    profile_path = os.path.join(user_data_path, 'profiles', user_obj['thumbnail'])
                    if os.path.exists(profile_path):
                        with open(profile_path, "rb") as img_f:
                            profile_b64 = base64.b64encode(img_f.read()).decode('utf-8')

                if scan_state["last_match"] == match_name:
                    scan_state["verify_buffer"].append(min_dist)
                else:
                    scan_state["verify_buffer"] = [min_dist]
                    scan_state["last_match"] = match_name
                
                verify_count = len(scan_state["verify_buffer"])
                progress = int((verify_count / 10) * 100)
                
                if verify_count >= 10:
                    scan_state["verify_buffer"] = []
                    scan_state["miss_counter"] = 0
                    print(json.dumps({
                        "success": True, 
                        "status": "success", 
                        "match": match_name, 
                        "profile_img": profile_b64,
                        "features": features, 
                        "pitch": pitch,
                        "security_level": "STRICT" if mouth_occluded else "NORMAL"
                    }), flush=True)
                else:
                    scan_state["miss_counter"] = 0 # Reset miss counter khi có frame khớp
                    print(json.dumps({
                        "success": True, 
                        "status": "verifying", 
                        "match": match_name, 
                        "profile_img": profile_b64,
                        "progress": progress, 
                        "features": features, 
                        "pitch": pitch,
                        "detail": f"Đang xác thực bảo mật {('GẮT GAO' if mouth_occluded else 'TIÊU CHUẨN')} ({verify_count}/10)..."
                    }), flush=True)
            else:
                # --- TOLERANCE LOGIC v4.2.0 (PERSISTENCE) ---
                # Cho phép sai số lên đến 3 khung hình trước khi hủy bỏ buffer
                if len(scan_state["verify_buffer"]) > 0:
                    scan_state["miss_counter"] += 1
                    if scan_state["miss_counter"] > 3:
                        scan_state["verify_buffer"] = []
                        scan_state["miss_counter"] = 0
                        print(json.dumps({"success": True, "status": "unknown", "features": features, "pitch": pitch, "occlusion": mouth_occluded}), flush=True)
                    else:
                        # Vẫn gửi trạng thái đang xác định để không bị khựng UI
                        progress = int((len(scan_state["verify_buffer"]) / 10) * 100)
                        print(json.dumps({
                            "success": True, 
                            "status": "verifying", 
                            "match": scan_state["last_match"] or "MASTER", 
                            "progress": progress, 
                            "features": features, 
                            "pitch": pitch,
                            "detail": f"ĐANG ỔN ĐỊNH TÍN HIỆU ({len(scan_state['verify_buffer'])}/10)..."
                        }), flush=True)
                else:
                    print(json.dumps({"success": True, "status": "unknown", "features": features, "pitch": pitch, "occlusion": mouth_occluded}), flush=True)
        elif mode == 'register':
            # --- SOFTEN ANTI-COLLISION v4.2.0 ---
            reg = get_faces(user_data_path)
            if reg:
                known_encs = [np.array(f['model']) for f in reg]
                dists = face_recognition.face_distance(known_encs, cur_enc)
                # Chặn nếu quá giống < 0.30 hoặc cho phép nếu là biến thể mới 0.30 - 0.40
                if len(dists) > 0 and min(dists) < 0.30: 
                    match_idx = np.argmin(dists)
                    match_name = reg[match_idx]['name']
                    print(json.dumps({"success": False, "status": "duplicate_face", "match": match_name, "features": features}), flush=True)
                    continue

            scan_state["encodings"].append(cur_enc.tolist()); scan_state["angles"].append(pitch)
            
            # --- SMART SNAPSHOT TRACKING (v4.2.4) ---
            # Ưu tiên khung hình nhìn thẳng tuyệt đối (Pitch ≈ 0)
            curr_abs_pitch = abs(pitch)
            # Chỉ cập nhật nếu khung hình mới "thẳng" hơn đáng kể hoặc là khung hình đạt chuẩn "Perfect Straight" (< 3 độ)
            if curr_abs_pitch < scan_state["best_reg_pitch"]:
                # Nếu đã có một tấm ảnh cực tốt (< 2 độ) thì chỉ thay thế nếu tấm mới còn tốt hơn nữa
                if scan_state["best_reg_pitch"] < 2.0 and curr_abs_pitch > scan_state["best_reg_pitch"]:
                    pass 
                else:
                    scan_state["best_reg_pitch"] = curr_abs_pitch
                    scan_state["best_reg_frame"] = rgb_roi.copy()

            p_range = max(scan_state["angles"]) - min(scan_state["angles"])
            req_range = 10.0 if mouth_occluded else 15.0
            frame_count = len(scan_state["encodings"])
            min_frames = 50 
            
            prog_angle = min((p_range / req_range) * 100, 100)
            prog_count = min((frame_count / min_frames) * 100, 100)
            prog = int((prog_angle + prog_count) / 2)
            
            if prog >= 100 and frame_count >= min_frames:
                final_enc = np.mean(np.array(scan_state["encodings"]), axis=0)
                user_id = uuid.uuid4().hex[:8]
                
                # Lưu ảnh hồ sơ thật (Profile Vision v3.5.0)
                profile_dir = os.path.join(user_data_path, 'profiles')
                if not os.path.exists(profile_dir): os.makedirs(profile_dir)
                
                thumb_name = f"{user_id}.jpg"
                thumb_path = os.path.join(profile_dir, thumb_name)
                
                # Sử dụng ảnh "nhìn thẳng nhất" đã lưu trong bộ đệm (Smart Snapshot)
                target_img = scan_state["best_reg_frame"] if scan_state["best_reg_frame"] is not None else rgb_roi
                
                # Resize ảnh ROI để tiết kiệm dung lượng
                thumb_img = cv2.resize(target_img, (200, 200))
                thumb_img_bgr = cv2.cvtColor(thumb_img, cv2.COLOR_RGB2BGR)
                cv2.imwrite(thumb_path, thumb_img_bgr)

                user = {
                    "id": user_id, 
                    "name": face_name, 
                    "model": final_enc.tolist(), 
                    "thumbnail": thumb_name,
                    "date": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                }
                reg.append(user)
                save_registered_faces(user_data_path, reg)
                print(json.dumps({"success": True, "status": "sculpt_complete", "progress": 100, "pitch": pitch}), flush=True)
                scan_state["is_active"] = False
            else:
                print(json.dumps({"success": True, "status": "sculpting", "progress": prog, "features": features, "pitch": pitch, "cleanroom_mode": mouth_occluded}), flush=True)
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}), flush=True)
