import os
import json
import glob
from typing import Callable, Awaitable
from runners.seg_normalize import run_normalize
from runners.seg_masker import run_masker
from runners.seg_masker_vcam import run_masker_vcam
from runners.seg_carver import run_carver

async def run_segmentation(job_id: str, job_dir: str, config: dict, push_ws: Callable[[dict], Awaitable[None]]):
    """
    Phase 4: Segmentation pipeline.
    Sub-step 1: normalize images
    Sub-step 2: generate masks (YOLOE-26 + SAM-HQ)
    Sub-step 3: carve labels into Gaussians
    """
    step_id = 4
    
    seg_dir = os.path.join(job_dir, "segmentation")
    os.makedirs(seg_dir, exist_ok=True)
    
    # 1. Resolve paths
    images_dir = os.path.join(job_dir, "images")
    
    # Check if we are in full pipeline (3dgs dir exists) or advanced mode Phase 4 entry
    dgs_dir = os.path.join(job_dir, "3dgs")
    if os.path.exists(dgs_dir):
        cameras_json = os.path.join(dgs_dir, "cameras.json")
        # Find highest iteration ply
        point_cloud_dir = os.path.join(dgs_dir, "point_cloud")
        iters = []
        if os.path.exists(point_cloud_dir):
            for d in os.listdir(point_cloud_dir):
                if d.startswith("iteration_"):
                    try:
                        iters.append(int(d.split("_")[1]))
                    except:
                        pass
        if iters:
            highest_iter = max(iters)
            ply_path = os.path.join(point_cloud_dir, f"iteration_{highest_iter}", "point_cloud.ply")
        else:
            ply_path = os.path.join(job_dir, "point_cloud.ply") # Fallback
    else:
        # Advanced mode
        cameras_json = os.path.join(job_dir, "cameras.json")
        ply_path = os.path.join(job_dir, "point_cloud.ply")
        
    # 2. Config reading
    seg_mode = config.get("seg_mode", "auto")
    seg_objects_str = config.get("seg_custom_objects", "")
    vote_ratio = float(config.get("seg_vote_ratio", 0.45))
    
    if seg_mode == "auto" and not os.path.exists(cameras_json):
        error_msg = f"cameras.json not found at {cameras_json}"
        await push_ws({"type": "log", "step": step_id, "progress": 100, "text": f"ERROR: {error_msg}"})
        raise FileNotFoundError(error_msg)
        
    if not os.path.exists(ply_path):
        error_msg = f"point_cloud.ply not found at {ply_path}"
        await push_ws({"type": "log", "step": step_id, "progress": 100, "text": f"ERROR: {error_msg}"})
        raise FileNotFoundError(error_msg)
    
    custom_objects = [obj.strip() for obj in seg_objects_str.split(",") if obj.strip()]

    # Wrap push_ws to scale progress per sub-step
    async def push_norm(msg):
        if msg.get("type") == "log" and "progress" in msg:
            msg = msg.copy()
            msg["progress"] = int(msg["progress"] * 0.1)  # 0-10%
        await push_ws(msg)
        
    async def push_mask(msg):
        if msg.get("type") == "log" and "progress" in msg:
            msg = msg.copy()
            msg["progress"] = 10 + int(msg["progress"] * 0.4)  # 10-50%
        await push_ws(msg)
        
    async def push_carve(msg):
        if msg.get("type") == "log" and "progress" in msg:
            msg = msg.copy()
            msg["progress"] = 50 + int(msg["progress"] * 0.5)  # 50-100%
        await push_ws(msg)

    # 3. Execution
    if seg_mode == "auto":
        # 3a. Normalize
        normalized_images_dir = await run_normalize(images_dir, cameras_json, push_norm, step_id)
        
        # 3b. Masker
        masks_dir = os.path.join(seg_dir, "masks")
        detected_classes = await run_masker(normalized_images_dir, masks_dir, custom_objects, push_mask, step_id)
        
        if not detected_classes:
            await push_ws({"type": "log", "step": step_id, "progress": 100, "text": "No classes detected. Segmentation complete."})
            return {"status": "no_classes"}
            
        # 3c. Carver
        output_ply = os.path.join(seg_dir, "labelled_point_cloud.ply")
        carver_result = await run_carver(ply_path, cameras_json, masks_dir, output_ply, vote_ratio, push_carve, step_id)
        
        # Save label map
        label_map_path = os.path.join(seg_dir, "label_map.json")
        with open(label_map_path, "w") as f:
            json.dump(carver_result["label_map"], f, indent=4)
            
        return {
            "labelled_ply": carver_result["labelled_ply"],
            "label_map": carver_result["label_map"],
            "stats": carver_result["stats"],
            "masks_dir": masks_dir
        }
    elif seg_mode == "vcam":
        vcam_dir = os.path.join(job_dir, "segmentation", "vcam_input")
        vcam_images_dir = os.path.join(vcam_dir, "images")
        vcam_cameras_json = os.path.join(vcam_dir, "cameras.json")
        
        if not os.path.exists(vcam_images_dir) or not os.path.exists(vcam_cameras_json):
            error_msg = f"Virtual camera inputs not found in {vcam_dir}. Please submit virtual cameras from the renderer."
            await push_ws({"type": "log", "step": step_id, "progress": 100, "text": f"ERROR: {error_msg}"})
            raise FileNotFoundError(error_msg)
            
        # 3b. Masker (using virtual images in object subdirectories)
        masks_dir = os.path.join(seg_dir, "masks")
        detected_classes = await run_masker_vcam(vcam_images_dir, masks_dir, push_mask, step_id)
        
        if not detected_classes:
            await push_ws({"type": "log", "step": step_id, "progress": 100, "text": "No classes detected in virtual cameras. Segmentation complete."})
            return {"status": "no_classes"}
            
        # 3c. Carver (using virtual cameras.json and masks, against the ORIGINAL point_cloud)
        output_ply = os.path.join(seg_dir, "labelled_point_cloud.ply")
        carver_result = await run_carver(ply_path, vcam_cameras_json, masks_dir, output_ply, vote_ratio, push_carve, step_id)
        
        # Save label map
        label_map_path = os.path.join(seg_dir, "label_map.json")
        with open(label_map_path, "w") as f:
            json.dump(carver_result["label_map"], f, indent=4)
            
        return {
            "labelled_ply": carver_result["labelled_ply"],
            "label_map": carver_result["label_map"],
            "stats": carver_result["stats"],
            "masks_dir": masks_dir
        }
    else:
        await push_ws({"type": "log", "step": step_id, "progress": 100, "text": f"Unknown seg_mode: {seg_mode}"})
        return {"status": "skipped"}
