import os
import asyncio
from typing import Callable, Awaitable
from vr_exporter import process_vr_export

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
        # Run the CPU-heavy export in a separate thread so we don't block the asyncio event loop
        manifest = await asyncio.to_thread(process_vr_export, job_id, ply_path, output_dir)
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
