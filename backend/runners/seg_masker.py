import os
import sys
import asyncio
from typing import Callable, Awaitable
import torch
import cv2
import numpy as np
from ultralytics import YOLO, settings
from segment_anything_hq import sam_model_registry, SamPredictor

# Tell Ultralytics to look for auxiliary files (like MobileCLIP) in the checkpoints folder
settings.update({'weights_dir': '/teamspace/studios/this_studio/Virtual-Investigation-Tool/dev/checkpoints'})

async def run_masker(images_dir: str, masks_dir: str, custom_objects: list[str], push_ws: Callable[[dict], Awaitable[None]], step_id: int) -> list[str]:
    """
    Runs YOLOE-26 + SAM-HQ mask generation on all images.
    custom_objects: list of target objects. If empty, uses prompt-free auto-discovery.
    Returns list of detected class names (folder names under masks_dir).
    """
    os.makedirs(masks_dir, exist_ok=True)
    
    device = "cuda" if torch.cuda.is_available() else "cpu"
    await push_ws({"type": "log", "step": step_id, "progress": 0, "text": f"Loading models on {device}..."})
    
    # 1. Load Models in thread
    def _load_models():
        if custom_objects:
            y_model = YOLO('/teamspace/studios/this_studio/Virtual-Investigation-Tool/dev/checkpoints/yoloe-26x-seg.pt')
            y_model.set_classes(custom_objects)
        else:
            y_model = YOLO('/teamspace/studios/this_studio/Virtual-Investigation-Tool/dev/checkpoints/yoloe-26x-seg-pf.pt')
        
        s_model = sam_model_registry["vit_h"](checkpoint="/teamspace/studios/this_studio/Virtual-Investigation-Tool/dev/checkpoints/sam_hq_vit_h.pth").to(device)
        s_pred = SamPredictor(s_model)
        return y_model, s_pred

    try:
        if custom_objects:
            await push_ws({"type": "log", "step": step_id, "progress": 2, "text": f"Loading YOLOE-26 Text-Prompt architecture... custom_objects: {custom_objects}"})
        else:
            await push_ws({"type": "log", "step": step_id, "progress": 2, "text": "Loading YOLOE-26 Prompt-Free auto-discovery architecture..."})
        
        await push_ws({"type": "log", "step": step_id, "progress": 5, "text": "Loading SAM HQ contour refiner..."})
        yoloe_model, predictor = await asyncio.to_thread(_load_models)
    except Exception as e:
        await push_ws({"type": "log", "step": step_id, "progress": 0, "text": f"Error loading models: {e}"})
        raise e
        
    image_files = sorted([f for f in os.listdir(images_dir) if f.lower().endswith(('.png', '.jpg', '.jpeg'))])
    total_images = len(image_files)
    
    if total_images == 0:
        await push_ws({"type": "log", "step": step_id, "progress": 100, "text": "No images found for masking."})
        return []
        
    detected_classes = set()

    def _process_image(filename):
        img_path = os.path.join(images_dir, filename)
        image = cv2.imread(img_path)
        if image is None:
            return []
            
        found = []
        image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        predictor.set_image(image_rgb)
        
        yoloe_results = yoloe_model.predict(image, verbose=False, device=device)
        result = yoloe_results[0]
            
        if result.boxes is not None and len(result.boxes) > 0:
            yoloe_boxes = result.boxes.xyxy.cpu().numpy()
            yoloe_classes = result.boxes.cls.cpu().numpy()
            yoloe_names = result.names
            
            for box_idx, box in enumerate(yoloe_boxes):
                label_name = yoloe_names[int(yoloe_classes[box_idx])]
                clean_label = "".join(x for x in label_name if x.isalnum() or x in "_-").replace(" ", "_")
                found.append(clean_label)
                
                class_dir = os.path.join(masks_dir, clean_label)
                os.makedirs(class_dir, exist_ok=True)
                
                masks, _, _ = predictor.predict(box=np.array(box)[None, :], multimask_output=False)
                mask_array = (masks[0] * 255).astype(np.uint8)
                
                mask_filename = f"{os.path.splitext(filename)[0]}_{box_idx}.png"
                cv2.imwrite(os.path.join(class_dir, mask_filename), mask_array)
        return found

    for idx, filename in enumerate(image_files):
        try:
            found = await asyncio.to_thread(_process_image, filename)
            detected_classes.update(found)
        except Exception as e:
            await push_ws({"type": "log", "step": step_id, "progress": int(5 + (idx/total_images)*90), "text": f"Error masking {filename}: {e}"})

        # Yield more frequently to the event loop and push logs!
        if (idx + 1) % 5 == 0 or (idx + 1) == total_images:
            progress = int(5 + ((idx + 1) / total_images) * 90)
            await push_ws({"type": "log", "step": step_id, "progress": progress, "text": f"Masked {idx + 1}/{total_images} images."})

    await push_ws({"type": "log", "step": step_id, "progress": 100, "text": f"Masking complete. Found {len(detected_classes)} object classes."})
    return list(detected_classes)
