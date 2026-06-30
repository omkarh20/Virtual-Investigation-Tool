import os
import shutil
import asyncio
import re
from typing import Callable, Awaitable

async def run_generic_process(cmd: list, push_ws: Callable[[dict], Awaitable[None]], step: int, label: str):
    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT
        )
    except FileNotFoundError:
        error_msg = f"⚠️ '{cmd[0]}' is not installed or not on PATH."
        await push_ws({"type": "log", "step": step, "progress": 100, "text": error_msg})
        raise RuntimeError(error_msg)

    while True:
        line = await process.stdout.readline()
        if not line:
            break
        text = line.decode().strip()
        if text:
            await push_ws({"type": "log", "step": step, "progress": 5, "text": f"[{label}] {text}"})

    await process.wait()
    if process.returncode != 0:
        error_msg = f"Command {' '.join(cmd)} failed with exit code {process.returncode}"
        await push_ws({"type": "log", "step": step, "progress": 100, "text": f"ERROR: {error_msg}"})
        raise RuntimeError(error_msg)


async def run_3dgs_training(job_id: str, job_dir: str, config: dict, push_ws: Callable[[dict], Awaitable[None]]):
    """
    Prepares the workspace and runs the 3DGS training script.
    """
    step_id = 3  # Phase 3 (was Phase 4)
    
    # 1. Determine source_path (must be undistorted)
    dense_dir = os.path.join(job_dir, "dense")
    undistorted_dir = os.path.join(job_dir, "undistorted")
    colmap_sparse_dir = os.path.join(job_dir, "colmap", "sparse", "0")
    
    if os.path.exists(dense_dir) and os.path.exists(os.path.join(dense_dir, "sparse")):
        source_path = dense_dir
        await push_ws({"type": "log", "step": step_id, "progress": 5, "text": "Using dense reconstruction outputs for 3DGS..."})
    else:
        camera_model = config.get("colmap_camera_model", "OPENCV")
        if camera_model not in ["PINHOLE", "SIMPLE_PINHOLE"]:
            source_path = undistorted_dir
            if not os.path.exists(undistorted_dir):
                os.makedirs(undistorted_dir, exist_ok=True)
                await push_ws({"type": "log", "step": step_id, "progress": 5, "text": "Undistorting images for 3DGS..."})
                cmd_undistort = [
                    "colmap", "image_undistorter",
                    "--image_path", os.path.join(job_dir, "images"),
                    "--input_path", colmap_sparse_dir,
                    "--output_path", undistorted_dir,
                    "--output_type", "COLMAP"
                ]
                await run_generic_process(cmd_undistort, push_ws, step_id, "Undistorter")
        else:
            source_path = job_dir
            target_sparse_dir = os.path.join(job_dir, "sparse")
            if not os.path.exists(target_sparse_dir):
                await push_ws({"type": "log", "step": step_id, "progress": 5, "text": "Copying sparse model for 3DGS..."})
                if not os.path.exists(os.path.join(job_dir, "colmap", "sparse")):
                    raise FileNotFoundError("COLMAP sparse directory not found. Did you run Phase 1?")
                shutil.copytree(os.path.join(job_dir, "colmap", "sparse"), target_sparse_dir, dirs_exist_ok=True)
                
    # 3DGS requires the sparse model to be inside sparse/0/
    sparse_zero_dir = os.path.join(source_path, "sparse", "0")
    if not os.path.exists(sparse_zero_dir):
        os.makedirs(sparse_zero_dir, exist_ok=True)
        sparse_parent = os.path.join(source_path, "sparse")
        for f in os.listdir(sparse_parent):
            if f == '0':
                continue
            src_f = os.path.join(sparse_parent, f)
            dst_f = os.path.join(sparse_zero_dir, f)
            shutil.copy2(src_f, dst_f)
        
    out_dir = os.path.join(job_dir, "3dgs")
    os.makedirs(out_dir, exist_ok=True)

    # 2. Read config
    iterations = str(config.get("gs_iterations", 30000))
    resolution = str(config.get("gs_max_resolution", 0))
    sh_degree = str(config.get("gs_sh_degree", 3))
    white_bg = config.get("gs_white_background", False)
    save_iters_str = config.get("gs_save_iterations", "").strip()
    check_iters_str = config.get("gs_check_iterations", "").strip()
    start_checkpoint = config.get("gs_start_checkpoint", "").strip()
    
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
        "-s", source_path,
        "-m", out_dir,
        "--iterations", iterations,
        "--sh_degree", sh_degree
    ]
    if resolution != "0":
        cmd.extend(["-r", resolution])
    if white_bg:
        cmd.append("--white_background")
        
    if save_iters_str:
        save_list = [x for x in save_iters_str.replace(",", " ").split() if x]
        if save_list:
            cmd.extend(["--save_iterations"] + save_list)
            
    if check_iters_str:
        check_list = [x for x in check_iters_str.replace(",", " ").split() if x]
        if check_list:
            cmd.extend(["--checkpoint_iterations"] + check_list)
            
    if start_checkpoint:
        if os.path.exists(start_checkpoint):
            cmd.extend(["--start_checkpoint", start_checkpoint])
        else:
            await push_ws({"type": "log", "step": step_id, "progress": 10, "text": f"⚠️ Checkpoint not found at {start_checkpoint}. Proceeding without it."})

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
