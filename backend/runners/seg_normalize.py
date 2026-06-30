import os
import json
import asyncio
import cv2
import shutil
from typing import Callable, Awaitable
from runners.normalize_images import build_camera_lookup

async def run_normalize(images_dir: str, cameras_json: str, push_ws: Callable[[dict], Awaitable[None]], step_id: int) -> str:
    """
    Normalizes image orientations to match COLMAP's expected dimensions.
    Reads camera params from cameras_json, rotates any mismatched images.
    Returns path to the normalized images directory (images_normalized/).
    """
    output_dir = os.path.join(os.path.dirname(images_dir), "images_normalized")
    os.makedirs(output_dir, exist_ok=True)
    
    await push_ws({"type": "log", "step": step_id, "progress": 0, "text": "Starting image normalization..."})

    try:
        with open(cameras_json, 'r') as f:
            cameras = json.load(f)
    except Exception as e:
        await push_ws({"type": "log", "step": step_id, "progress": 0, "text": f"Error loading cameras.json: {e}"})
        raise e

    camera_lookup = build_camera_lookup(cameras)
    
    image_files = sorted([f for f in os.listdir(images_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
    total_images = len(image_files)
    
    if total_images == 0:
        await push_ws({"type": "log", "step": step_id, "progress": 100, "text": "No images found to normalize."})
        return output_dir

    rotated_count = 0
    copied_count = 0
    
    def _process_image(idx, filename):
        nonlocal rotated_count, copied_count
        stem = os.path.splitext(filename)[0].lower()
        cam = camera_lookup.get(stem)
        
        img_path = os.path.join(images_dir, filename)
        out_path = os.path.join(output_dir, filename)
        
        if cam is None:
            shutil.copy2(img_path, out_path)
            copied_count += 1
            return
            
        img = cv2.imread(img_path)
        if img is None:
            return
            
        h, w = img.shape[:2]
        expected_w = cam["width"]
        expected_h = cam["height"]
        
        if (h > w and expected_w > expected_h) or (w > h and expected_h > expected_w):
            img_rotated = cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
            cv2.imwrite(out_path, img_rotated)
            rotated_count += 1
        else:
            shutil.copy2(img_path, out_path)
            copied_count += 1

    for idx, filename in enumerate(image_files):
        try:
            # Run blocking I/O in thread
            await asyncio.to_thread(_process_image, idx, filename)
        except Exception as e:
            await push_ws({"type": "log", "step": step_id, "progress": int((idx/total_images)*100), "text": f"Error processing {filename}: {e}"})
            
        if (idx + 1) % 10 == 0 or (idx + 1) == total_images:
            progress = int(((idx + 1) / total_images) * 100)
            await push_ws({"type": "log", "step": step_id, "progress": progress, "text": f"Normalized {idx + 1}/{total_images} images."})
            
    await push_ws({"type": "log", "step": step_id, "progress": 100, "text": f"Normalization complete. Rotated {rotated_count} images. Copied {copied_count} unrotated images."})
    return output_dir
