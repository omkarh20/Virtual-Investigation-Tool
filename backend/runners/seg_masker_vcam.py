import os
import sys
import asyncio
from typing import Callable, Awaitable
import torch
import cv2
import numpy as np
from ultralytics import YOLO, settings
from segment_anything_hq import sam_model_registry, SamPredictor

settings.update({'weights_dir': '/teamspace/studios/this_studio/Virtual-Investigation-Tool/dev/checkpoints'})

async def run_masker_vcam(vcam_images_dir: str, masks_dir: str, push_ws: Callable[[dict], Awaitable[None]], step_id: int) -> list[str]:
    """
    Runs YOLOE-26 + SAM-HQ mask generation on VCam images.
    Expects vcam_images_dir to contain subdirectories (e.g. 'knife', 'bottle').
    The subdirectory name is used as the custom object prompt. 'auto' triggers prompt-free.
    """
    os.makedirs(masks_dir, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    
    # Identify subdirectories
    subdirs = [d for d in os.listdir(vcam_images_dir) if os.path.isdir(os.path.join(vcam_images_dir, d))]
    
    if not subdirs:
        await push_ws({"type": "log", "step": step_id, "progress": 100, "text": "No object folders found in vcam_images_dir."})
        return []
        
    await push_ws({"type": "log", "step": step_id, "progress": 0, "text": f"Found VCam objects: {subdirs}"})
    
    # Pre-load SAM-HQ once to save time
    def _load_sam():
        s_model = sam_model_registry["vit_h"](checkpoint="/teamspace/studios/this_studio/Virtual-Investigation-Tool/dev/checkpoints/sam_hq_vit_h.pth").to(device)
        return SamPredictor(s_model)
        
    try:
        await push_ws({"type": "log", "step": step_id, "progress": 2, "text": "Loading SAM HQ contour refiner..."})
        predictor = await asyncio.to_thread(_load_sam)
    except Exception as e:
        await push_ws({"type": "log", "step": step_id, "progress": 0, "text": f"Error loading SAM HQ: {e}"})
        raise e

    detected_classes = set()
    total_dirs = len(subdirs)

    for dir_idx, obj_name in enumerate(subdirs):
        img_folder = os.path.join(vcam_images_dir, obj_name)
        image_files = sorted([f for f in os.listdir(img_folder) if f.lower().endswith(('.png', '.jpg', '.jpeg'))])
        
        if not image_files:
            continue
            
        def _load_yolo():
            if obj_name.lower() == 'auto':
                return YOLO('/teamspace/studios/this_studio/Virtual-Investigation-Tool/dev/checkpoints/yoloe-26x-seg-pf.pt')
            else:
                y_model = YOLO('/teamspace/studios/this_studio/Virtual-Investigation-Tool/dev/checkpoints/yoloe-26x-seg.pt')
                y_model.set_classes([obj_name])
                return y_model
                
        await push_ws({"type": "log", "step": step_id, "progress": int(5 + (dir_idx/total_dirs)*90), "text": f"Loading YOLO for object: {obj_name}"})
        yoloe_model = await asyncio.to_thread(_load_yolo)
        
        def _process_image(filename):
            img_path = os.path.join(img_folder, filename)
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
                await push_ws({"type": "log", "step": step_id, "progress": int(5 + (dir_idx/total_dirs)*90), "text": f"Error masking {filename}: {e}"})

    return list(detected_classes)
