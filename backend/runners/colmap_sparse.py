import os
import asyncio
from typing import Callable, Awaitable

async def run_process(cmd: list, push_ws: Callable[[dict], Awaitable[None]], step: int, label: str):
    """Helper to run a subprocess and stream its output to the websocket."""
    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT
        )
    except FileNotFoundError:
        # The executable (e.g., 'colmap') was not found on PATH
        error_msg = f"⚠️ '{cmd[0]}' is not installed or not on PATH. The pipeline will work when run on a machine with {cmd[0]} installed."
        await push_ws({"type": "log", "step": step, "progress": 100, "text": error_msg})
        raise RuntimeError(error_msg)

    while True:
        line = await process.stdout.readline()
        if not line:
            break
        text = line.decode().strip()
        if text:
            await push_ws({"type": "log", "step": step, "progress": 50, "text": f"[{label}] {text}"})

    await process.wait()
    if process.returncode != 0:
        error_msg = f"Command {' '.join(cmd)} failed with exit code {process.returncode}"
        await push_ws({"type": "log", "step": step, "progress": 100, "text": f"ERROR: {error_msg}"})
        raise RuntimeError(error_msg)

async def run_colmap_sparse(job_id: str, job_dir: str, config: dict, push_ws: Callable[[dict], Awaitable[None]]):
    """
    Runs the 3 steps of COLMAP sparse reconstruction:
    feature_extractor -> matcher -> mapper
    """
    colmap_dir = os.path.join(job_dir, "colmap")
    database_path = os.path.join(colmap_dir, "database.db")
    image_path = os.path.join(job_dir, "images")
    sparse_dir = os.path.join(colmap_dir, "sparse", "0")
    
    os.makedirs(colmap_dir, exist_ok=True)
    os.makedirs(sparse_dir, exist_ok=True)
    
    # Read config with defaults
    camera_model = config.get("colmap_camera_model", "OPENCV")
    matcher_type = config.get("colmap_matcher", "exhaustive")
    use_gpu = "1" if config.get("colmap_use_gpu", True) else "0"
    
    step_id = 2  # Phase 2

    # 1. Feature Extractor
    await push_ws({"type": "log", "step": step_id, "progress": 10, "text": "Starting feature extraction..."})
    cmd_extract = [
        "colmap", "feature_extractor",
        "--database_path", database_path,
        "--image_path", image_path,
        "--ImageReader.camera_model", camera_model,
        "--FeatureExtraction.use_gpu", use_gpu
    ]
    await run_process(cmd_extract, push_ws, step_id, "Extractor")

    # 2. Matcher
    await push_ws({"type": "log", "step": step_id, "progress": 40, "text": f"Starting {matcher_type} matching..."})
    cmd_match = [
        "colmap", f"{matcher_type}_matcher",
        "--database_path", database_path,
        "--FeatureMatching.use_gpu", use_gpu
    ]
    await run_process(cmd_match, push_ws, step_id, "Matcher")

    # 3. Mapper
    await push_ws({"type": "log", "step": step_id, "progress": 70, "text": "Starting sparse mapping..."})
    cmd_mapper = [
        "colmap", "mapper",
        "--database_path", database_path,
        "--image_path", image_path,
        "--output_path", sparse_dir
    ]
    await run_process(cmd_mapper, push_ws, step_id, "Mapper")

    await push_ws({"type": "log", "step": step_id, "progress": 100, "text": "Sparse reconstruction complete."})
    return {"sparse_dir": sparse_dir}
