import os
import shutil
import asyncio
import re
from typing import Callable, Awaitable

async def run_3dgs_training(job_id: str, job_dir: str, config: dict, push_ws: Callable[[dict], Awaitable[None]]):
    """
    Prepares the workspace and runs the 3DGS training script.
    """
    colmap_sparse_dir = os.path.join(job_dir, "colmap", "sparse")
    target_sparse_dir = os.path.join(job_dir, "sparse")
    
    step_id = 4  # Phase 4
    
    # 1. Prepare directory structure for 3DGS
    # 3DGS expects <source>/images and <source>/sparse/0
    if not os.path.exists(target_sparse_dir):
        await push_ws({"type": "log", "step": step_id, "progress": 5, "text": "Copying sparse model for 3DGS..."})
        if not os.path.exists(colmap_sparse_dir):
            raise FileNotFoundError("COLMAP sparse directory not found. Did you run Phase 2?")
        shutil.copytree(colmap_sparse_dir, target_sparse_dir, dirs_exist_ok=True)
        
    out_dir = os.path.join(job_dir, "3dgs")
    os.makedirs(out_dir, exist_ok=True)

    # 2. Read config
    iterations = str(config.get("gs_iterations", 30000))
    resolution = str(config.get("gs_max_resolution", 0))
    
    # Locate train.py
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    project_root = os.path.dirname(backend_dir)
    train_script = os.path.join(project_root, "external", "gaussian-splatting", "train.py")
    
    if not os.path.exists(train_script):
        # Allow failing gracefully if the external repo isn't cloned yet
        error_msg = "⚠️ 3DGS train.py not found in external/gaussian-splatting. Make sure submodules are cloned."
        await push_ws({"type": "log", "step": step_id, "progress": 100, "text": error_msg})
        raise FileNotFoundError(error_msg)

    cmd = [
        "python", train_script,
        "-s", job_dir,
        "-m", out_dir,
        "--iterations", iterations
    ]
    if resolution != "0":
        cmd.extend(["-r", resolution])

    await push_ws({"type": "log", "step": step_id, "progress": 10, "text": "Starting 3DGS training..."})

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT
        )
    except FileNotFoundError:
        error_msg = "⚠️ 'python' is not installed or not on PATH."
        await push_ws({"type": "log", "step": step_id, "progress": 100, "text": error_msg})
        raise RuntimeError(error_msg)

    # 3. Parse output for progress
    iter_regex = re.compile(r"\[ITER\s+(\d+)\]\s+Loss:\s+([0-9\.]+)")
    total_iters = int(iterations)
    
    while True:
        line = await process.stdout.readline()
        if not line:
            break
        text = line.decode().strip()
        if text:
            # Try to match progress [ITER 1000] Loss: 0.123
            match = iter_regex.search(text)
            if match:
                current_iter = int(match.group(1))
                loss = match.group(2)
                
                # Calculate progress from 10% to 95%
                pct = 10 + int(85 * (current_iter / total_iters))
                await push_ws({
                    "type": "log", 
                    "step": step_id, 
                    "progress": pct, 
                    "text": f"Training Iteration {current_iter}/{total_iters} | Loss: {loss}"
                })
            elif "Saving" in text or "Loading" in text or "Exception" in text:
                await push_ws({"type": "log", "step": step_id, "progress": 50, "text": f"[3DGS] {text}"})

    await process.wait()
    if process.returncode != 0:
        error_msg = f"3DGS training failed with exit code {process.returncode}"
        await push_ws({"type": "log", "step": step_id, "progress": 100, "text": f"ERROR: {error_msg}"})
        raise RuntimeError(error_msg)

    # Output path
    final_ply = os.path.join(out_dir, "point_cloud", f"iteration_{iterations}", "point_cloud.ply")
    await push_ws({"type": "log", "step": step_id, "progress": 100, "text": f"3DGS training complete. Saved to {final_ply}"})
    
    return {"point_cloud": final_ply}
