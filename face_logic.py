import sys
import os
import json
import base64
import face_recognition
import numpy as np
import cv2
from PIL import Image
import io
import uuid
from datetime import datetime

# Initialize OpenCV Face Detector as fallback for masks
face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

# Load registered face data
def load_registered_faces(user_data_path):
    try:
        reg_path = os.path.join(user_data_path, 'registered_face.json')
        if os.path.exists(reg_path):
            with open(reg_path, 'r') as f:
                data = json.load(f)
                # Ensure it's in the new list format
                if isinstance(data, dict) and 'encoding' in data:
                    # Migrate old format to new format
                    old_face = [{"id": "legacy", "name": "Bản cũ", "encoding": data['encoding'], "date": "N/A"}]
                    return old_face
                return data if isinstance(data, list) else []
        return []
    except Exception as e:
        print(f"DEBUG: Error loading faces: {e}")
        return []

def save_registered_faces(faces_list, user_data_path):
    try:
        reg_path = os.path.join(user_data_path, 'registered_face.json')
        os.makedirs(os.path.dirname(reg_path), exist_ok=True)
        with open(reg_path, 'w') as f:
            json.dump(faces_list, f)
        return True
    except Exception as e:
        print(f"DEBUG: Error saving faces: {e}")
        return False

def process_image(image_data, mode, input_json):
    # mode: 'register', 'validate_registration', 'detect', 'list', 'delete'
    try:
        user_data_path = input_json.get('user_data_path', '.')

        # Handle List and Delete modes immediately without image processing
        if mode == 'list':
            faces_list = load_registered_faces(user_data_path)
            clean_list = [{"id": f['id'], "name": f['name'], "date": f.get('date', 'N/A')} for f in faces_list]
            return {"success": True, "faces": clean_list}

        if mode == 'delete':
            target_id = input_json.get('face_id')
            faces_list = load_registered_faces(user_data_path)
            new_list = [f for f in faces_list if str(f['id']) != str(target_id)]
            if len(new_list) < len(faces_list):
                save_registered_faces(new_list, user_data_path)
                return {"success": True, "message": "Deleted successfully"}
            else:
                return {"success": False, "error": "ID not found"}

        # Image processing for 'register' and 'detect' modes
        if image_data.startswith('data:image'):
            image_data = image_data.split(',')[1]
        
        img_bytes = base64.b64decode(image_data)
        image = Image.open(io.BytesIO(img_bytes))
        rgb_image = np.array(image.convert('RGB'))

        # --- Low-light Enhancement (CLAHE) ---
        # Convert to LAB to brighten without losing color accuracy
        lab = cv2.cvtColor(rgb_image, cv2.COLOR_RGB2LAB)
        l, a, b = cv2.split(lab)
        
        # Apply CLAHE to L-channel
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8,8))
        cl = clahe.apply(l)
        
        # Merge back and convert to RGB
        limg = cv2.merge((cl,a,b))
        rgb_image = cv2.cvtColor(limg, cv2.COLOR_LAB2RGB)
        # -------------------------------------

        # Find face locations and encodings
        # Step 1: Try high-quality dlib HOG (default upsample=1 for speed)
        face_locations = face_recognition.face_locations(rgb_image, number_of_times_to_upsample=1)
        
        # Step 2: If dlib fails (occlusion/mask), fallback to OpenCV Haar Cascade
        if not face_locations:
            gray = cv2.cvtColor(rgb_image, cv2.COLOR_RGB2GRAY)
            faces = face_cascade.detectMultiScale(gray, 1.1, 4)
            if len(faces) > 0:
                # Convert (x, y, w, h) to (top, right, bottom, left) for face_recognition
                (x, y, w, h) = faces[0]
                face_locations = [(int(y), int(x + w), int(y + h), int(x))]

        if not face_locations:
            return {"success": False, "error": "No face detected"}

        # Use num_jitters=1 for near-instant speed on CPU
        encodings = face_recognition.face_encodings(rgb_image, face_locations, num_jitters=1)
        if not encodings:
            return {"success": False, "error": "Could not encode face"}

        encoding = encodings[0]
        user_data_path = input_json.get('user_data_path', '.')

        if mode == 'register':
            face_name = input_json.get('face_name', 'Chưa đặt tên')
            face_id = input_json.get('face_id', str(uuid.uuid4().hex[:8]))
            
            faces_list = load_registered_faces(user_data_path)
            
            # Check if this exact face already exists in the list
            for f in faces_list:
                existing_enc = np.array(f['encoding'])
                matches = face_recognition.compare_faces([existing_enc], encoding, tolerance=0.5)
                if matches[0]:
                    return {"success": False, "exists": True, "error": f"Khuôn mặt này đã được đăng ký với tên: {f['name']}"}

            # Append new face
            new_face = {
                "id": face_id,
                "name": face_name,
                "encoding": encoding.tolist(),
                "date": datetime.now().strftime("%d/%m/%Y %H:%M")
            }
            faces_list.append(new_face)
            
            if save_registered_faces(faces_list, user_data_path):
                return {"success": True, "message": "Registered successfully", "name": face_name}
            else:
                return {"success": False, "error": "Failed to save face data"}

        elif mode == 'validate_registration':
            # Just check if face exists and is unique
            faces_list = load_registered_faces(user_data_path)
            for f in faces_list:
                existing_enc = np.array(f['encoding'])
                matches = face_recognition.compare_faces([existing_enc], encoding, tolerance=0.5)
                if matches[0]:
                    return {"success": False, "exists": True, "error": f"Khuôn mặt này đã được đăng ký với tên: {f['name']}"}
            
            return {"success": True, "message": "Face validated"}

        elif mode == 'detect':
            faces_list = load_registered_faces(user_data_path)
            if not faces_list:
                return {"success": False, "error": "No registered faces found"}

            known_encodings = [np.array(f['encoding']) for f in faces_list]
            
            # Compare faces - Tolerance 0.6 is good for balance
            matches = face_recognition.compare_faces(known_encodings, encoding, tolerance=0.6)
            
            if any(matches):
                match_index = matches.index(True)
                matched_name = faces_list[match_index]['name']
                distance = face_recognition.face_distance([known_encodings[match_index]], encoding)[0]
                return {"success": True, "match": True, "name": matched_name, "distance": float(distance)}
            else:
                return {"success": True, "match": False}

    except Exception as e:
        return {"success": False, "error": str(e)}

if __name__ == "__main__":
    # Expect JSON input from stdin
    # { "mode": "...", "image_data": "..." }
    for line in sys.stdin:
        try:
            input_data = json.loads(line)
            # Pass the entire input_data to process_image to get user_data_path
            result = process_image(input_data['image_data'], input_data['mode'], input_data)
            print(json.dumps(result))
            sys.stdout.flush()
        except Exception as e:
            print(json.dumps({"success": False, "error": str(e)}))
            sys.stdout.flush()
