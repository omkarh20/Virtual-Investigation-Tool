import os
import asyncio
import json
import numpy as np
from typing import Callable, Awaitable
from vr_exporter import process_vr_export
from runners.align_utils import compute_pca_alignment, apply_transform

async def run_vr_export(job_id: str, job_dir: str, config: dict, push_ws: Callable[[dict], Awaitable[None]]):
    """
    Phase 5: VR Export pipeline.
    Splits the segmented point cloud and generates collision convex hulls.
    """
    step_id = 5
    
    # Locate the input PLY file.
    # It might be in segmentation/ (from Phase 4) or directly in job_dir (if advanced upload)
    seg_dir = os.path.join(job_dir, "segmentation")
    ply_path = os.path.join(seg_dir, "labelled_point_cloud.ply")
    
    if not os.path.exists(ply_path):
        # Check if there is any .ply file in job_dir (uploaded via zip/dir)
        ply_files = [f for f in os.listdir(job_dir) if f.lower().endswith(".ply")]
        if not ply_files:
            raise FileNotFoundError("No labelled .ply file found to export.")
        ply_path = os.path.join(job_dir, ply_files[0])
        
    output_dir = os.path.join(job_dir, "vr-assets")
    
    await push_ws({
        "type": "log", 
        "step": step_id, 
        "progress": 10, 
        "text": f"Starting VR Export for {os.path.basename(ply_path)}..."
    })

    try:
        aligned_ply_path = os.path.join(os.path.dirname(ply_path), "aligned_point_cloud.ply")
        
        matrix = None
        # If the user manually aligned it in Phase 4 or Phase 5, job["aligned"] will be True
        # and the points in ply_path are ALREADY transformed.
        is_aligned = config.get("aligned", False)
        
        if is_aligned:
            await push_ws({"type": "log", "step": step_id, "progress": 20, "text": "Model was manually aligned by user. Skipping auto-alignment."})
            # Just copy the ply to aligned_ply_path
            import shutil
            shutil.copy(ply_path, aligned_ply_path)
        else:
            await push_ws({"type": "log", "step": step_id, "progress": 20, "text": "Computing auto-alignment matrix (PCA)..."})
            matrix = compute_pca_alignment(ply_path)
            await push_ws({"type": "log", "step": step_id, "progress": 30, "text": "Applying alignment transformation to point cloud..."})
            apply_transform(ply_path, aligned_ply_path, matrix)
            
        # Run the CPU-heavy export using the aligned point cloud
        manifest = await asyncio.to_thread(process_vr_export, job_id, aligned_ply_path, output_dir)
    except Exception as e:
        await push_ws({
            "type": "log", 
            "step": step_id, 
            "progress": 10, 
            "text": f"Error during VR export: {e}"
        })
        raise e

    await push_ws({
        "type": "log", 
        "step": step_id, 
        "progress": 100, 
        "text": f"VR Export complete. Generated {len(manifest['segments'])} segments."
    })
    
    return manifest
