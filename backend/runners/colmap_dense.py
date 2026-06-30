import os
import asyncio
from typing import Callable, Awaitable
from .colmap_sparse import run_process

async def run_colmap_dense(job_id: str, job_dir: str, config: dict, push_ws: Callable[[dict], Awaitable[None]]):
    """
    Runs the 3 steps of COLMAP dense reconstruction:
    image_undistorter -> patch_match_stereo -> stereo_fusion
    """
    colmap_dir = os.path.join(job_dir, "colmap")
    image_path = os.path.join(job_dir, "images")
    sparse_dir = os.path.join(colmap_dir, "sparse", "0")
    dense_dir = os.path.join(colmap_dir, "dense")
    
    os.makedirs(dense_dir, exist_ok=True)
    
    use_gpu = "1" if config.get("colmap_use_gpu", True) else "0"
    max_image_size = str(config.get("colmap_dense_max_image_size", 2000))
    
    step_id = 2  # Phase 2 (was Phase 3)

    # 1. Image Undistorter
    await push_ws({"type": "log", "step": step_id, "progress": 10, "text": "Starting image undistortion..."})
    cmd_undistort = [
        "colmap", "image_undistorter",
        "--image_path", image_path,
        "--input_path", sparse_dir,
        "--output_path", dense_dir,
        "--output_type", "COLMAP",
        "--max_image_size", max_image_size
    ]
    await run_process(cmd_undistort, push_ws, step_id, "Undistorter")

    # 2. Patch Match Stereo
    await push_ws({"type": "log", "step": step_id, "progress": 40, "text": "Starting patch match stereo (this may take a while)..."})
    cmd_patch = [
        "colmap", "patch_match_stereo",
        "--workspace_path", dense_dir,
        "--workspace_format", "COLMAP",
        "--PatchMatchStereo.geom_consistency", "true",
        "--PatchMatchStereo.gpu_index", "-1" if use_gpu == "1" else ""
    ]
    if use_gpu == "0":
         cmd_patch = [x for x in cmd_patch if x != "--PatchMatchStereo.gpu_index" and x != ""]

    await run_process(cmd_patch, push_ws, step_id, "PatchMatch")

    # 3. Stereo Fusion
    await push_ws({"type": "log", "step": step_id, "progress": 80, "text": "Starting stereo fusion..."})
    fused_ply_path = os.path.join(dense_dir, "fused.ply")
    cmd_fuse = [
        "colmap", "stereo_fusion",
        "--workspace_path", dense_dir,
        "--workspace_format", "COLMAP",
        "--input_type", "geometric",
        "--output_path", fused_ply_path
    ]
    await run_process(cmd_fuse, push_ws, step_id, "Fusion")

    await push_ws({"type": "log", "step": step_id, "progress": 100, "text": f"Dense reconstruction complete. Saved to {fused_ply_path}"})
    return {"dense_ply": fused_ply_path}
