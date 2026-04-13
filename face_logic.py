import sys
import os
import json
import base64
import uuid
from datetime import datetime

# --- PING INSTANTLY FOR UI (Startup Speed Optimization) ---
# Tín hiệu giả lập bật AI sẽ bắn thẳng vào Nodejs trước khi các tệp lớn được nhập vào.
print(json.dumps({"status": "LOADING_MODELS"}))
sys.stdout.flush()

# --- HEAVY IMPORTS (Lazy Loaded) ---
import numpy as np
import cv2
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
import face_recognition

# Initialize OpenCV Face Detector as fallback for extreme occlusions
face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
angle_buffer = {"history": [], "max_len": 7}

try:
    if getattr(sys, 'frozen', False):
        # Running from EXE (COLLECT mode)
        current_dir = os.path.dirname(sys.executable)
        # resourcesPath = current_dir/../../
        model_path = os.path.abspath(os.path.join(current_dir, '..', '..', 'models', 'face_landmarker.task'))
    else:
        current_dir = os.path.dirname(os.path.abspath(__file__))
        model_path = os.path.join(current_dir, 'models', 'face_landmarker.task')

    # Fallback for some packaging styles where models is a sibling to the executable folder
    if not os.path.exists(model_path):
        model_path = os.path.join(current_dir, '..', 'models', 'face_landmarker.task')
        
    if not os.path.exists(model_path):
        print(json.dumps({"success": False, "error": f"Model not found at: {model_path}"}))
        sys.exit(1)

    base_options = python.BaseOptions(model_asset_path=model_path)
    options = vision.FaceLandmarkerOptions(
        base_options=base_options,
        output_face_blendshapes=True,
        output_facial_transformation_matrixes=True,
        num_faces=1)
    
    detector = vision.FaceLandmarker.create_from_options(options)
    print(json.dumps({"status": "READY", "mode": "Ultimate Pro Secure Edition"}))
except Exception as e:
    print(json.dumps({"success": False, "error": f"Failed to init: {str(e)}"}))
sys.stdout.flush()

def adjust_gamma(image, gamma=1.0):
    invGamma = 1.0 / gamma
    table = np.array([((i / 255.0) ** invGamma) * 255 for i in np.arange(0, 256)]).astype("uint8")
    return cv2.LUT(image, table)

def preprocess_lighting(img):
    """Enhances image for backlight, glare, and low light using CLAHE + Gamma Correction."""
    try:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        mean_brightness = np.mean(gray)
        if mean_brightness < 70:
            img = adjust_gamma(img, gamma=1.6) # Tăng sáng cực đại
        elif mean_brightness > 200:
            img = adjust_gamma(img, gamma=0.6) # Ép sáng khi bị lóa
            
        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        cl = clahe.apply(l)
        limg = cv2.merge((cl, a, b))
        final = cv2.cvtColor(limg, cv2.COLOR_LAB2BGR)
        return final
    except: return img

def load_registered_faces(user_data_path):
    try:
        reg_path = os.path.join(user_data_path, 'registered_face.json')
        if os.path.exists(reg_path):
            with open(reg_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                return data if isinstance(data, list) else []
        return []
    except Exception: return []

def save_registered_faces(user_data_path, faces):
    try:
        if not os.path.exists(user_data_path): os.makedirs(user_data_path, exist_ok=True)
        reg_path = os.path.join(user_data_path, 'registered_face.json')
        with open(reg_path, 'w', encoding='utf-8') as f:
            json.dump(faces, f, ensure_ascii=False)
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Save failed: {str(e)}"}))

def get_ultra_pose(face_landmarker_result):
    global angle_buffer
    if not face_landmarker_result.facial_transformation_matrixes:
        return "center", (0, 0, 0)
    matrix = face_landmarker_result.facial_transformation_matrixes[0]
    sy = np.sqrt(matrix[0, 0] * matrix[0, 0] + matrix[1, 0] * matrix[1, 0])
    singular = sy < 1e-6
    if not singular:
        x = np.arctan2(matrix[2, 1], matrix[2, 2])
        y = np.arctan2(-matrix[2, 0], sy)
        z = np.arctan2(matrix[1, 0], matrix[0, 0])
    else:
        x = np.arctan2(-matrix[1, 2], matrix[1, 1])
        y = np.arctan2(-matrix[2, 0], sy)
        z = 0
    cur_x, cur_y, cur_z = np.degrees(x), np.degrees(y), np.degrees(z)
    angle_buffer["history"].append((cur_x, cur_y, cur_z))
    if len(angle_buffer["history"]) > angle_buffer["max_len"]: angle_buffer["history"].pop(0)
    avg_x = sum(a[0] for a in angle_buffer["history"]) / len(angle_buffer["history"])
    avg_y = sum(a[1] for a in angle_buffer["history"]) / len(angle_buffer["history"])
    
    # ULTIMATE CONFIG: Golden Ratio Threshold (4.5 degrees)
    direction = "center"
    if avg_y < -4.5: direction = "left"
    elif avg_y > 4.5: direction = "right"
    elif avg_x < -4.5: direction = "up"
    elif avg_x > 4.5: direction = "down"
    return direction, (avg_x, avg_y)

def calculate_3d_ratio(landmarks):
    lm = landmarks
    eye_dist = np.sqrt((lm[33].x - lm[362].x)**2 + (lm[33].y - lm[362].y)**2 + (lm[33].z - lm[362].z)**2)
    eye_to_nose = np.sqrt((lm[33].x - lm[1].x)**2 + (lm[33].y - lm[1].y)**2 + (lm[33].z - lm[1].z)**2)
    if eye_to_nose == 0: return 1.0
    return float(eye_dist / eye_to_nose)

def get_face_locations_from_mesh(landmarks, img_w, img_h):
    x_coords = [lm.x * img_w for lm in landmarks]
    y_coords = [lm.y * img_h for lm in landmarks]
    p_x = (max(x_coords) - min(x_coords)) * 0.15
    p_y = (max(y_coords) - min(y_coords)) * 0.2
    top = int(max(0, min(y_coords) - p_y))
    bottom = int(min(img_h, max(y_coords) + p_y))
    left = int(max(0, min(x_coords) - p_x))
    right = int(min(img_w, max(x_coords) + p_x))
    return [(top, right, bottom, left)]

def process_image():
    for line in sys.stdin:
        try:
            input_data = json.loads(line)
            mode = input_data.get('mode', 'detect')
            image_b64 = input_data.get('image_data')
            face_name = input_data.get('faceName', 'User')
            user_data_path = input_data.get('user_data_path', '.')

            if mode in ['list', 'delete']:
                if mode == 'list': print(json.dumps({"faces": load_registered_faces(user_data_path)}))
                else:
                    reg = load_registered_faces(user_data_path)
                    save_registered_faces(user_data_path, [f for f in reg if f['id'] != input_data.get('face_id')])
                    print(json.dumps({"message": "Deleted successfully"}))
                sys.stdout.flush(); continue

            if not image_b64: continue
            if image_b64.startswith('data:image'): image_b64 = image_b64.split(',')[1]
            img = cv2.imdecode(np.frombuffer(base64.b64decode(image_b64), np.uint8), cv2.IMREAD_COLOR)
            if img is None: continue
            img = preprocess_lighting(img)

            h, w = img.shape[:2]
            rgb_img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_img)
            
            detection_result = detector.detect(mp_image)
            is_masked_mode = False

            if not detection_result.face_landmarks:
                # --- EXTREME FALLBACK: Mask & Hood Analysis ---
                locations = face_recognition.face_locations(rgb_img, model="hog", number_of_times_to_upsample=1)
                if not locations:
                    gray = cv2.cvtColor(rgb_img, cv2.COLOR_RGB2GRAY)
                    faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(60,60))
                    if len(faces) > 0:
                        (x, y, fw, fh) = faces[0]
                        locations = [(int(y), int(x + fw), int(y + fh), int(x))]
                
                if not locations:
                    print(json.dumps({"success": False, "status": "no_face"})); sys.stdout.flush(); continue

                # Trigger Masked Workflow
                is_masked_mode = True
                direction = "center_masked"
                face_locations = locations
                current_3d_ratio = 1.0 # Bỏ qua Depth 3D
            else:
                direction, (ax, ay) = get_ultra_pose(detection_result)
                face_locations = get_face_locations_from_mesh(detection_result.face_landmarks[0], w, h)
                current_3d_ratio = calculate_3d_ratio(detection_result.face_landmarks[0])
            
            registered_faces = load_registered_faces(user_data_path)

            if mode == 'register':
                encodings = face_recognition.face_encodings(rgb_img, face_locations)
                if not encodings:
                    print(json.dumps({"success": False, "status": "no_face", "message": "Giữ mặt ổn định..."}))
                    sys.stdout.flush(); continue
                
                current_encoding = encodings[0]
                # ANTI-DUPLICATE CHECK
                for other_user in registered_faces:
                    if other_user['name'] != face_name:
                        for ang, enc in other_user.get("angles", {}).items():
                            dist = face_recognition.face_distance([np.array(enc)], current_encoding)[0]
                            duplicate_threshold = 0.48 if is_masked_mode else 0.43
                            if dist < duplicate_threshold:
                                print(json.dumps({"success": False, "status": "duplicate", "match_name": other_user['name']}))
                                sys.stdout.flush(); break
                        else: continue
                        break
                else:
                    # Proceed with registration
                    user = next((f for f in registered_faces if f['name'] == face_name), None)
                    if not user:
                        user = {"id": uuid.uuid4().hex[:8], "name": face_name, "date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "angles": {}, "ratios": {}}
                        registered_faces.append(user)
                    
                    if input_data.get('reset_angles', False): user["angles"] = {}; user["ratios"] = {}
                    
                    is_new_angle = direction not in user["angles"]
                    user["angles"][direction] = current_encoding.tolist()
                    user.setdefault("ratios", {})[direction] = current_3d_ratio
                    save_registered_faces(user_data_path, registered_faces)
                    print(json.dumps({"success": True, "status": "registered" if is_new_angle else "already_captured", "direction": direction, "all_angles": list(user["angles"].keys())}))
                    sys.stdout.flush()
                continue

            else:
                # UNLOCK MODE
                encodings = face_recognition.face_encodings(rgb_img, face_locations)
                if encodings:
                    current_encoding = encodings[0].tolist()
                    best_match, min_dist = None, 1.0
                    base_threshold = 0.48 if is_masked_mode else 0.43

                    for f in registered_faces:
                        for ang, enc in f.get("angles", {}).items():
                            dist = face_recognition.face_distance([np.array(enc)], np.array(current_encoding))[0]
                            
                            ratio_diff = 0.0
                            if not is_masked_mode and ang != "center_masked":
                                reg_ratio = f.get("ratios", {}).get(ang, 1.0)
                                ratio_diff = abs(current_3d_ratio - reg_ratio)
                            
                            if dist < min_dist and ratio_diff < 0.06:
                                min_dist = dist
                                best_match = f['name']
                    
                    if best_match and min_dist < base_threshold:
                        print(json.dumps({"success": True, "match": best_match, "direction": direction, "masked": is_masked_mode}))
                    else: 
                        print(json.dumps({"success": False, "status": "no_match", "message": "Phân tích trích xuất: Cần chính xác hơn..."}))
                else: print(json.dumps({"success": False, "status": "no_face"}))

        except Exception as e:
            print(json.dumps({"success": False, "error": f"Pro Engine Error: {str(e)}"}))
        sys.stdout.flush()

if __name__ == "__main__":
    process_image()
