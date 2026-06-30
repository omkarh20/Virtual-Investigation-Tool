import os
import json
import asyncio
import sys
import glob
import cv2
import numpy as np
from typing import Callable, Awaitable
from runners.multi_class_carver_fixed import PLYReader, PLYWriter, build_camera_lookup, match_mask_to_camera

async def run_carver(ply_path: str, cameras_json: str, masks_dir: str, output_path: str, vote_ratio: float, push_ws: Callable[[dict], Awaitable[None]], step_id: int) -> dict:
    """
    Multi-class mask reprojection with conflict resolution.
    """
    await push_ws({"type": "log", "step": step_id, "progress": 0, "text": "Starting multi-class carver..."})
    
    try:
        with open(cameras_json, 'r') as f:
            cameras = json.load(f)
    except Exception as e:
        await push_ws({"type": "log", "step": step_id, "progress": 0, "text": f"Error loading cameras.json: {e}"})
        raise e

    camera_lookup = build_camera_lookup(cameras)
    
    await push_ws({"type": "log", "step": step_id, "progress": 5, "text": f"Loading point cloud from {ply_path}..."})
    try:
        splat = PLYReader(ply_path)
    except Exception as e:
        await push_ws({"type": "log", "step": step_id, "progress": 5, "text": f"Error loading point cloud: {e}"})
        raise e

    class_folders = [d for d in os.listdir(masks_dir) if os.path.isdir(os.path.join(masks_dir, d))]
    if not class_folders:
        await push_ws({"type": "log", "step": step_id, "progress": 100, "text": "No classes found to project."})
        return {"labelled_ply": None, "label_map": {}, "stats": {}}

    class_folders.sort()
    
    # 0 is background, classes start from 1
    class_map = {idx + 1: cls_name for idx, cls_name in enumerate(class_folders)}
    label_map = {"0": "background"}
    for k, v in class_map.items():
        label_map[str(k)] = v

    num_classes = len(class_folders)
    await push_ws({"type": "log", "step": step_id, "progress": 10, "text": f"Found {num_classes} classes to carve. This may take a while."})
    
    # Run heavy carving logic in thread to not block event loop
    def _run_carve():
        vertex_data = splat.data["vertex"]
        n_points = len(vertex_data["x"])
        points_3d = np.vstack([vertex_data["x"], vertex_data["y"], vertex_data["z"]]).T
        
        final_labels = np.zeros(n_points, dtype=np.uint32)
        highest_vote_ratios = np.zeros(n_points, dtype=np.float32)
        class_stats = {}

        for class_id, folder_name in enumerate(class_folders, start=1):
            class_dir = os.path.join(masks_dir, folder_name)
            
            mask_files = []
            for ext in ["*.png", "*.jpg", "*.jpeg", "*.bmp"]:
                mask_files.extend(glob.glob(os.path.join(class_dir, ext)))
            
            if not mask_files:
                continue
                
            vote_counts = np.zeros(n_points, dtype=np.uint16)
            views_used = 0

            for view_num, mask_path in enumerate(mask_files, start=1):
                cam = match_mask_to_camera(camera_lookup, mask_path)
                if cam is None:
                    continue

                width = cam["width"]
                height = cam["height"]
                fx = cam["fx"]
                fy = cam["fy"]

                mask_cv = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)
                if mask_cv is None:
                    continue

                h, w = mask_cv.shape
                if (h > w and width > height) or (w > h and height > width):
                    mask_cv = cv2.rotate(mask_cv, cv2.ROTATE_90_COUNTERCLOCKWISE)
                    h, w = mask_cv.shape

                if w != width or h != height:
                    mask_cv = cv2.resize(mask_cv, (width, height), interpolation=cv2.INTER_NEAREST)
                
                _, boolean_mask = cv2.threshold(mask_cv, 127, 255, cv2.THRESH_BINARY)
                boolean_mask = boolean_mask > 0

                R_c2w = np.array(cam["rotation"])
                R_w2c = R_c2w.T
                C = np.array(cam["position"])

                shifted_points = points_3d - C
                cam_points = np.dot(R_w2c, shifted_points.T)

                z = cam_points[2, :]
                valid_depth = z > 0.01

                z_safe = np.where(z == 0, 1e-6, z)
                u = (cam_points[0, :] / z_safe) * fx + (width / 2.0)
                v = (cam_points[1, :] / z_safe) * fy + (height / 2.0)

                u_int = np.round(u).astype(int)
                v_int = np.round(v).astype(int)

                valid_proj = valid_depth & (u_int >= 0) & (u_int < width) & (v_int >= 0) & (v_int < height)

                in_mask = np.zeros(n_points, dtype=bool)
                valid_indices = np.where(valid_proj)[0]
                if len(valid_indices) > 0:
                    mask_hits = boolean_mask[v_int[valid_indices], u_int[valid_indices]]
                    in_mask[valid_indices[mask_hits]] = True

                vote_counts += in_mask.astype(np.uint16)
                views_used += 1
            
            if views_used == 0:
                continue

            point_ratios = vote_counts.astype(np.float32) / views_used
            passed_threshold = point_ratios >= vote_ratio
            beat_current_best = point_ratios > highest_vote_ratios
            
            to_update = passed_threshold & beat_current_best
            
            highest_vote_ratios[to_update] = point_ratios[to_update]
            final_labels[to_update] = class_id
            
            class_stats[folder_name] = np.sum(final_labels == class_id)
            
        bg_count = np.sum(final_labels == 0)
        class_stats["background"] = int(bg_count)
        for folder_name in class_folders:
            if folder_name not in class_stats:
                class_stats[folder_name] = 0
            else:
                class_stats[folder_name] = int(class_stats[folder_name])

        vertex_data["label"] = final_labels.tolist()
        prop_names = [prop[0] for prop in splat.elements["vertex"]["properties"]]
        if "label" not in prop_names:
            splat.elements["vertex"]["properties"].append(("label", "uint"))
            
        return class_stats, splat
        
    try:
        class_stats, modified_splat = await asyncio.to_thread(_run_carve)
    except Exception as e:
        await push_ws({"type": "log", "step": step_id, "progress": 10, "text": f"Error during carving: {e}"})
        raise e
        
    await push_ws({"type": "log", "step": step_id, "progress": 90, "text": "Writing labelled point cloud..."})

    try:
        # Write to output_path using PLYWriter
        writer = PLYWriter(output_path, modified_splat.elements, modified_splat.data)
        writer.write(is_binary=True, is_little_endian=("little_endian" in modified_splat.format))
    except Exception as e:
        await push_ws({"type": "log", "step": step_id, "progress": 90, "text": f"Error writing output PLY: {e}"})
        raise e

    await push_ws({"type": "log", "step": step_id, "progress": 100, "text": f"Carving complete. Labelled PLY saved to {output_path}."})

    return {
        "labelled_ply": output_path,
        "label_map": label_map,
        "stats": class_stats
    }
