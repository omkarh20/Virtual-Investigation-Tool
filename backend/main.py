import asyncio
import os
import shutil
import uuid
import glob
import zipfile
import json
import re
import warnings
from typing import Any
from pydantic import BaseModel

# Suppress harmless model registry overwrite warnings from segment_anything_hq
warnings.filterwarnings("ignore", category=UserWarning, module="segment_anything_hq")

import warnings
warnings.filterwarnings("ignore", category=UserWarning, module=".*tiny_vit_sam.*")
warnings.filterwarnings("ignore", category=UserWarning, module="segment_anything.*")

from runners.colmap_sparse import run_colmap_pipeline
from runners.colmap_dense import run_colmap_dense
from runners.train_3dgs import run_3dgs_training
from vr_exporter import process_vr_export
from runners.mesh_pipeline import run_unsegmented_mesh_pipeline, run_mesh_segmentation_pipeline

from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect, Form, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

from ultralytics import YOLO
import cv2
import numpy as np

import sys
import torch
from PIL import Image
import io

# groundingdino is installed via pip

from groundingdino.util.inference import load_model as load_dino_model, predict as dino_predict
import groundingdino.datasets.transforms as T

app = FastAPI(title="VIT Backend", version="0.1.0-modular")

active_tasks = set()

@app.on_event("shutdown")
async def shutdown_event():
    for task in active_tasks:
        task.cancel()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173", "http://127.0.0.1:5173"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

jobs: dict[str, dict[str, Any]] = {}
progress_queues: dict[str, asyncio.Queue] = {}
job_tasks: dict[str, asyncio.Task] = {}  # active task per job_id
JOBS_DIR = os.environ.get("JOBS_DIR", "./jobs")
os.makedirs(JOBS_DIR, exist_ok=True)

def save_job_metadata(job_id: str):
    if job_id in jobs:
        job_dir = os.path.join(JOBS_DIR, job_id)
        os.makedirs(job_dir, exist_ok=True)
        meta_path = os.path.join(job_dir, "metadata.json")
        try:
            with open(meta_path, "w") as f:
                json.dump(jobs[job_id], f, indent=4)
        except Exception as e:
            print(f"Failed to save metadata for {job_id}: {e}")

def load_all_metadata():
    if not os.path.exists(JOBS_DIR):
        return
    for item in os.listdir(JOBS_DIR):
        job_dir = os.path.join(JOBS_DIR, item)
        if os.path.isdir(job_dir):
            meta_path = os.path.join(job_dir, "metadata.json")
            if os.path.exists(meta_path):
                try:
                    with open(meta_path, "r") as f:
                        jobs[item] = json.load(f)
                except Exception as e:
                    print(f"Failed to load metadata for {item}: {e}")

load_all_metadata()

def make_job_dir(job_id: str) -> str:
    path = os.path.join(JOBS_DIR, job_id, "input")
    os.makedirs(path, exist_ok=True)
    return path

async def push(job_id: str, msg: dict) -> None:
    q = progress_queues.get(job_id)
    if q:
        await q.put(msg)
    if msg is not None:
        log_path = os.path.join(JOBS_DIR, job_id, "logs.jsonl")
        try:
            with open(log_path, "a") as f:
                f.write(json.dumps(msg) + "\n")
        except Exception as e:
            pass

from runners.run_segmentation import run_segmentation
from runners.run_vr_export import run_vr_export

PHASES = [
    {"id": 1, "label": "Preparing Images",   "runner": process_inputs},
    {"id": 2, "label": "COLMAP",              "runner": run_colmap_sparse},
    {"id": 3, "label": "COLMAP Dense",        "runner": run_colmap_dense, "optional": True},
    {"id": 4, "label": "3DGS Training",       "runner": run_3dgs_training},
    {"id": 5, "label": "Segmentation & Meshing", "runner": run_mesh_segmentation_pipeline},
    {"id": 6, "label": "VR Export",           "runner": run_vr_export},
]

async def run_pipeline_orchestrator(job_id: str, end_phase: int = None):
    job = jobs[job_id]
    job["status"] = "running"
    save_job_metadata(job_id)
    config = job["config"]
    enable_dense = config.get("colmap_dense_enable", False)
    
    start_idx = job["current_phase"]
    if start_idx == 0:
        start_idx = 1
        
    for phase in PHASES:
        pid = phase["id"]
        if pid < start_idx:
            continue
            
        if pid in job["completed_phases"]:
            continue
            
        if phase.get("optional") and pid == 2 and not enable_dense:
            job["completed_phases"].append(pid)
            continue
            
        job["current_phase"] = pid
        
        await push(job_id, {
            "type": "step_start",
            "step": pid,
            "total": len(PHASES),
            "label": phase["label"],
            "progress": 0
        })
        
        try:
            if phase.get("simulated"):
                for i in range(5):
                    await asyncio.sleep(0.6)
                    pct = int((i + 1) / 5 * 100)
                    await push(job_id, {
                        "type": "log",
                        "step": pid,
                        "progress": pct,
                        "text": f"Simulating {phase['label']} (Phase {i + 1}/5)..."
                    })
                result = {"simulated": True}
            else:
                job_dir = os.path.join(JOBS_DIR, job_id)
                
                # If entering Phase 4 in VCam mode, ensure VCam inputs exist. Otherwise pause and wait for them.
                if pid == 4 and config.get("seg_mode") == "vcam":
                    vcam_dir = os.path.join(job_dir, "segmentation", "vcam_input")
                    if not os.path.exists(vcam_dir):
                        job["status"] = "paused"
                        save_job_metadata(job_id)
                        await push(job_id, {
                            "type": "phase_paused",
                            "next_phase": 4,
                            "next_label": "Segmentation (Virtual Camera)"
                        })
                        return
                        
                runner_func = phase["runner"]
                result = await runner_func(job_id, job_dir, config, lambda msg: push(job_id, msg))
                
            job["completed_phases"].append(pid)
            if "phase_results" not in job:
                job["phase_results"] = {}
            job["phase_results"][str(pid)] = result
            save_job_metadata(job_id)
            
            await push(job_id, {
                "type": "phase_complete",
                "phase": pid,
                "label": phase["label"],
                "summary": str(result)
            })
            
            # Check if we should pause here
            is_end = end_phase is not None and pid == end_phase
            should_pause = is_end or (job["run_mode"] == "step" and pid < len(PHASES))
            
            if pid == 3 and config.get("seg_mode") == "vcam":
                should_pause = True
            
            if pid == 4 and config.get("vr_manual_align"):
                should_pause = True
            
            if should_pause:
                next_pid = pid + 1
                if next_pid == 2 and not enable_dense:
                    next_pid = 3
                
                # Compute next label even for is_end so user can always continue
                if next_pid <= len(PHASES):
                    next_label = PHASES[next_pid - 1]["label"]
                    next_phase_out = next_pid
                    if pid == 3 and config.get("seg_mode") == "vcam":
                        next_label = "Segmentation (Virtual Camera)"
                    elif pid == 4 and config.get("vr_manual_align"):
                        next_label = "VR Export (Align in Renderer)"
                else:
                    next_label = None
                    next_phase_out = None

                job["status"] = "paused"
                save_job_metadata(job_id)
                await push(job_id, {
                    "type": "phase_paused",
                    "next_phase": next_phase_out,
                    "next_label": next_label
                })
                return
                
        except asyncio.CancelledError:
            # Clean up partial output for the cancelled phase
            cleanup_dirs = {
                1: [os.path.join(JOBS_DIR, job_id, "images"), os.path.join(JOBS_DIR, job_id, "colmap")],
                2: [os.path.join(JOBS_DIR, job_id, "dense")],
                3: [os.path.join(JOBS_DIR, job_id, "3dgs")],
                4: [os.path.join(JOBS_DIR, job_id, "segmentation")],
                5: [os.path.join(JOBS_DIR, job_id, "vr-assets")],
            }
            for d in cleanup_dirs.get(pid, []):
                if os.path.exists(d):
                    shutil.rmtree(d, ignore_errors=True)
            job["status"] = "cancelled"
            job["current_phase"] = pid  # remember where we stopped
            save_job_metadata(job_id)
            await push(job_id, {"type": "cancelled", "phase": pid, "label": phase["label"]})
            await push(job_id, None)
            job_tasks.pop(job_id, None)
            return
        except Exception as e:
            # Clean up partial output for the failed phase
            cleanup_dirs = {
                1: [os.path.join(JOBS_DIR, job_id, "images"), os.path.join(JOBS_DIR, job_id, "colmap")],
                2: [os.path.join(JOBS_DIR, job_id, "dense")],
                3: [os.path.join(JOBS_DIR, job_id, "3dgs")],
                4: [os.path.join(JOBS_DIR, job_id, "segmentation")],
                5: [os.path.join(JOBS_DIR, job_id, "vr-assets")],
            }
            for d in cleanup_dirs.get(pid, []):
                if os.path.exists(d):
                    shutil.rmtree(d, ignore_errors=True)
                    
            await push(job_id, {"type": "log", "step": pid, "progress": 100, "text": f"Error: {e}"})
            job["status"] = "failed"
            job["current_phase"] = pid
            save_job_metadata(job_id)
            await push(job_id, {"type": "failed", "phase": pid, "label": phase["label"], "error": str(e)})
            await push(job_id, None)
            job_tasks.pop(job_id, None)
            return

    job["status"] = "done"
    save_job_metadata(job_id)
    await push(job_id, {
        "type": "done",
        "progress": 100,
        "text": "Pipeline complete!",
        "result_url": f"/result/{job_id}",
    })
    await push(job_id, None)


@app.post("/upload")
async def upload(file: UploadFile = File(...), project_name: str = Form(None)) -> JSONResponse:
    base_uuid = str(uuid.uuid4())[:8]
    if project_name:
        safe_name = re.sub(r'[^a-zA-Z0-9_\-]', '_', project_name).strip('_')
        job_id = f"{safe_name}_{base_uuid}"
    else:
        job_id = base_uuid

    input_dir = make_job_dir(job_id)
    dest = os.path.join(input_dir, file.filename)

    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)

    jobs[job_id] = {
        "status": "uploaded",
        "project_name": project_name,
        "filename": file.filename,
        "input_path": dest,
        "config": {},
        "current_phase": 0,
        "completed_phases": [],
        "run_mode": "step",
        "phase_results": {}
    }
    save_job_metadata(job_id)
    progress_queues[job_id] = asyncio.Queue()

    return JSONResponse({"job_id": job_id, "filename": file.filename})


@app.post("/run-pipeline")
async def run_pipeline(body: dict) -> JSONResponse:
    job_id = body.get("job_id")
    if not job_id or job_id not in jobs:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)

    if jobs[job_id]["status"] == "running":
        return JSONResponse({"error": "Pipeline already running"}, status_code=409)

    config = body.get("config", {})
    mode = body.get("mode", "step")
    start_phase = body.get("start_phase", 1)
    end_phase = body.get("end_phase", None)
    
    jobs[job_id]["config"] = config
    jobs[job_id]["run_mode"] = mode
    jobs[job_id]["current_phase"] = start_phase
    save_job_metadata(job_id)

    # If starting at phase 3 (3DGS) or 4 (Segmentation) or 5 (VR Export), we need to extract the uploaded zip
    if start_phase in (3, 4, 5):
        input_file = jobs[job_id]["input_path"]
        job_dir = os.path.join(JOBS_DIR, job_id)
        if input_file.endswith(".zip"):
            try:
                with zipfile.ZipFile(input_file, 'r') as zip_ref:
                    zip_ref.extractall(job_dir)
            except Exception as e:
                return JSONResponse({"error": f"Failed to extract zip for phase {start_phase}: {e}"}, status_code=400)
        elif input_file.endswith(".ply"):
            try:
                os.rename(input_file, os.path.join(job_dir, "point_cloud.ply"))
            except Exception as e:
                return JSONResponse({"error": f"Failed to move PLY file for phase {start_phase}: {e}"}, status_code=400)

    if job_id not in progress_queues:
        progress_queues[job_id] = asyncio.Queue()

    task = asyncio.create_task(run_pipeline_orchestrator(job_id, end_phase))
    active_tasks.add(task)
    task.add_done_callback(active_tasks.discard)
    job_tasks[job_id] = task
    task.add_done_callback(lambda t: job_tasks.pop(job_id, None))
    return JSONResponse({"status": "started", "job_id": job_id})

@app.post("/cancel-pipeline")
async def cancel_pipeline(body: dict) -> JSONResponse:
    job_id = body.get("job_id")
    if not job_id or job_id not in jobs:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    task = job_tasks.get(job_id)
    if task and not task.done():
        task.cancel()
        return JSONResponse({"status": "cancelling", "job_id": job_id})
    return JSONResponse({"error": "No running task for this job"}, status_code=409)

@app.post("/continue-pipeline")
async def continue_pipeline(body: dict) -> JSONResponse:
    job_id = body.get("job_id")
    if not job_id or job_id not in jobs:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)

    if jobs[job_id]["status"] not in ("paused", "cancelled", "failed"):
        return JSONResponse({"error": f"Pipeline is not paused/cancelled (status: {jobs[job_id]['status']})"}, status_code=409)

    mode = body.get("mode", "step")
    config_update = body.get("config", {})
    jobs[job_id]["run_mode"] = mode
    if config_update:
        jobs[job_id]["config"].update(config_update)
    save_job_metadata(job_id)

    if job_id not in progress_queues:
        progress_queues[job_id] = asyncio.Queue()

    task = asyncio.create_task(run_pipeline_orchestrator(job_id))
    active_tasks.add(task)
    task.add_done_callback(active_tasks.discard)
    job_tasks[job_id] = task
    task.add_done_callback(lambda t: job_tasks.pop(job_id, None))
    return JSONResponse({"status": "resumed", "job_id": job_id})

@app.post("/submit-edits")
async def submit_edits(body: dict) -> JSONResponse:
    job_id = body.get("job_id")
    matrix = body.get("transform_matrix")
    world_matrix = body.get("world_matrix")
    deletions = body.get("deletions", [])
    preview = body.get("preview", False)
    
    if not job_id or job_id not in jobs:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
        
    job_dir = os.path.join(JOBS_DIR, job_id)
    job = jobs[job_id]
    
    try:
        from runners.run_edits import apply_edits_to_ply
        
        # If we paused after Phase 3 (we are at Phase 4), we edit point_cloud.ply
        # If we paused after Phase 4 (we are at Phase 5), we edit labelled_point_cloud.ply
        if job["current_phase"] <= 3:
            ply_path = os.path.join(job_dir, "point_cloud.ply")
        else:
            ply_path = os.path.join(job_dir, "segmentation", "labelled_point_cloud.ply")
            
        if os.path.exists(ply_path):
            # Run ply operations in thread to not block event loop
            await asyncio.to_thread(apply_edits_to_ply, ply_path, matrix, deletions, world_matrix)
            
            # Record that this job has been manually aligned so Phase 5 doesn't auto-align
            if matrix:
                job["config"]["aligned"] = True
                save_job_metadata(job_id)
                
    except Exception as e:
        print(f"Error applying edits: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)
        
    if preview:
        return JSONResponse({"status": "preview_applied", "job_id": job_id})
        
    jobs[job_id]["status"] = "running"
    save_job_metadata(job_id)

    if job_id not in progress_queues:
        progress_queues[job_id] = asyncio.Queue()

    task = asyncio.create_task(run_pipeline_orchestrator(job_id))
    active_tasks.add(task)
    task.add_done_callback(active_tasks.discard)
    job_tasks[job_id] = task
    task.add_done_callback(lambda t: job_tasks.pop(job_id, None))
    return JSONResponse({"status": "resumed", "job_id": job_id})

@app.post("/export-local")
async def export_local(
    file: UploadFile = File(...),
    transform_matrix: str = Form(...),
    world_matrix: str = Form(None),
    deletions: str = Form(...)
):
    import tempfile
    from runners.run_edits import apply_edits_to_ply
    
    try:
        matrix = json.loads(transform_matrix)
        del_regions = json.loads(deletions)
        
        # Save uploaded file to a temporary location
        with tempfile.NamedTemporaryFile(delete=False, suffix=".ply") as tmp:
            tmp_path = tmp.name
            content = await file.read()
            tmp.write(content)
            
        # Apply edits
        w_matrix = json.loads(world_matrix) if world_matrix else None
        await asyncio.to_thread(apply_edits_to_ply, tmp_path, matrix, del_regions, w_matrix)
        
        # We can't delete the file immediately because FileResponse returns it asynchronously.
        # But we can use BackgroundTasks in FastAPI to delete it after sending, 
        # or we just rely on OS tempfile cleanup. We'll rely on temp folder here or starlette BackgroundTask.
        from starlette.background import BackgroundTask
        return FileResponse(
            path=tmp_path, 
            filename=f"edited_{file.filename}", 
            media_type="application/octet-stream",
            background=BackgroundTask(os.remove, tmp_path)
        )
    except Exception as e:
        print(f"Error in export_local: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)

@app.post("/submit-vcam")
async def submit_vcam(job_id: str = Form(...), file: UploadFile = File(...)):
    if job_id not in jobs:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
        
    job_dir = os.path.join(JOBS_DIR, job_id)
    vcam_dir = os.path.join(job_dir, "segmentation", "vcam_input")
    os.makedirs(vcam_dir, exist_ok=True)
    
    zip_path = os.path.join(vcam_dir, "virtual_cameras.zip")
    with open(zip_path, "wb") as f:
        shutil.copyfileobj(file.file, f)
        
    shutil.unpack_archive(zip_path, vcam_dir)
    os.remove(zip_path)
    
    # Resume the pipeline at Phase 4
    asyncio.create_task(run_pipeline_orchestrator(job_id, end_phase=4))
    
    return JSONResponse({"status": "resumed", "job_id": job_id})


@app.get("/download/{job_id}/splat")
async def download_splat(job_id: str):
    job_dir = os.path.join(JOBS_DIR, job_id)
    dgs_dir = os.path.join(job_dir, "3dgs")
    point_cloud_dir = os.path.join(dgs_dir, "point_cloud")
    ply_path = None
    if os.path.exists(point_cloud_dir):
        iters = []
        for d in os.listdir(point_cloud_dir):
            if d.startswith("iteration_"):
                try:
                    iters.append(int(d.split("_")[1]))
                except:
                    pass
        if iters:
            highest_iter = max(iters)
            ply_path = os.path.join(point_cloud_dir, f"iteration_{highest_iter}", "point_cloud.ply")
            
    if not ply_path or not os.path.exists(ply_path):
        ply_path = os.path.join(job_dir, "point_cloud.ply")
        if not os.path.exists(ply_path):
            return JSONResponse({"error": "No splat found"}, status_code=404)
            
    return FileResponse(ply_path, media_type="application/octet-stream", filename="point_cloud.ply")

@app.get("/download/{job_id}/segmentation-zip")
async def download_segmentation_zip(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
        
    job_dir = os.path.join(JOBS_DIR, job_id)
    seg_dir = os.path.join(job_dir, "segmentation")
    if not os.path.exists(seg_dir):
        return JSONResponse({"error": "No segmentation output found"}, status_code=404)
        
    zip_path = os.path.join(job_dir, "segmentation_results.zip")
    shutil.make_archive(zip_path[:-4], 'zip', seg_dir)
    return FileResponse(zip_path, media_type="application/zip", filename="segmentation_results.zip")

@app.get("/download/{job_id}/{phase_id}")
async def download_phase(job_id: str, phase_id: int):
    job = jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
        
    job_dir = os.path.join(JOBS_DIR, job_id)
    
    if phase_id == 1:
        images_dir = os.path.join(job_dir, "images")
        if not os.path.exists(images_dir):
            return JSONResponse({"error": "No images found"}, status_code=404)
        zip_path = os.path.join(job_dir, "phase1_images.zip")
        shutil.make_archive(zip_path[:-4], 'zip', images_dir)
        return FileResponse(zip_path, media_type="application/zip", filename="images.zip")
        
    elif phase_id in [2, 3]:
        zip_path = os.path.join(job_dir, f"phase{phase_id}_colmap.zip")
        dirs_to_zip = ["images", "colmap"]
        if phase_id == 3:
            dirs_to_zip.append("dense")
            
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for d in dirs_to_zip:
                d_path = os.path.join(job_dir, d)
                if os.path.exists(d_path):
                    for root, _, files in os.walk(d_path):
                        for file in files:
                            abs_path = os.path.join(root, file)
                            rel_path = os.path.relpath(abs_path, job_dir)
                            zipf.write(abs_path, rel_path)
        if not os.path.exists(zip_path):
            return JSONResponse({"error": "No COLMAP outputs found"}, status_code=404)
        return FileResponse(zip_path, media_type="application/zip", filename=f"colmap_phase{phase_id}.zip")
        
    elif phase_id == 4:
        # Return labelled PLY (from HEAD) or regular PLY (from mesh) depending on what exists
        ply_path = os.path.join(job_dir, "segmentation", "labelled_point_cloud.ply")
        if not os.path.exists(ply_path):
            ply_files = glob.glob(os.path.join(job_dir, "output", "point_cloud", "iteration_*", "point_cloud.ply"))
            if ply_files:
                ply_files.sort(key=os.path.getmtime, reverse=True)
                return FileResponse(ply_files[0], media_type="application/octet-stream", filename="model.ply")
            return JSONResponse({"error": "No .ply found"}, status_code=404)
        return FileResponse(ply_path, media_type="application/octet-stream", filename="labelled_point_cloud.ply")

    elif phase_id == 5:
        # Return segments zip
        assets_dir = os.path.join(job_dir, "mesh-pipeline-assets")
        if not os.path.exists(assets_dir):
            return JSONResponse({"error": "No mesh assets found"}, status_code=404)
        zip_path = os.path.join(job_dir, "phase5_meshing_assets.zip")
        shutil.make_archive(zip_path[:-4], 'zip', assets_dir)
        return FileResponse(zip_path, media_type="application/zip", filename="meshing_assets.zip")
        
    return JSONResponse({"error": "Download not supported for this phase"}, status_code=400)


@app.get("/jobs/{job_id}/export-engine")
async def export_engine(job_id: str):
    import shutil
    job_dir = os.path.join(JOBS_DIR, job_id)
    vr_assets_dir = os.path.join(job_dir, "vr-assets")
    manifest_path = os.path.join(vr_assets_dir, "manifest.json")
    
    if not os.path.exists(manifest_path):
        return JSONResponse({"error": "VR Assets manifest not found. Did you run Phase 5 successfully?"}, status_code=404)
        
    try:
        with open(manifest_path, "r") as f:
            manifest = json.load(f)
            
        export_dir = os.path.join(job_dir, "engine-export")
        os.makedirs(os.path.join(export_dir, "Assets", "Splats"), exist_ok=True)
        os.makedirs(os.path.join(export_dir, "Assets", "Colliders"), exist_ok=True)
        
        # Copy the files
        layout_segments = []
        
        # Room Background
        shutil.copy(
            os.path.join(vr_assets_dir, "background.ply"),
            os.path.join(export_dir, "Assets", "Splats", "background.ply")
        )
        master_mesh_src = os.path.join(job_dir, "mesh-pipeline-assets", "master_scene_mesh.obj")
        if os.path.exists(master_mesh_src):
            shutil.copy(master_mesh_src, os.path.join(export_dir, "Assets", "Colliders", "scene_collision.obj"))
        
        # Process manifest segments
        for seg in manifest.get("segments", []):
            label = seg["label"]
            file_name = seg["file"]
            collision_file = seg["collision"]
            
            base_name = os.path.splitext(file_name)[0]
            
            layout_seg = {
                "name": label,
                "splat_file": f"Assets/Splats/{file_name}",
                "collider_file": f"Assets/Colliders/{base_name}.obj",
                "position": seg.get("centroid", [0, 0, 0]),
                "rotation": [0, 0, 0, 1],
                "scale": [1, 1, 1],
                "movable": seg.get("movable", False)
            }
            layout_segments.append(layout_seg)
            
            # Copy PLY file
            shplat_src = os.path.join(vr_assets_dir, file_name)
            if os.path.exists(shplat_src):
                shutil.copy(shplat_src, os.path.join(export_dir, "Assets", "Splats", file_name))
                
            # Copy OBJ mesh file (source is mesh-pipeline-assets/segments/obj_name_mesh.obj)
            if label != "background":
                obj_src = os.path.join(job_dir, "mesh-pipeline-assets", "segments", f"{label}_mesh.obj")
                if os.path.exists(obj_src):
                    shutil.copy(obj_src, os.path.join(export_dir, "Assets", "Colliders", f"{label}.obj"))
                    
        # Write scene_layout.json
        layout = {
            "scene_id": job_id,
            "segments": layout_segments
        }
        with open(os.path.join(export_dir, "scene_layout.json"), "w") as f:
            json.dump(layout, f, indent=2)
            
        # Write Unity importer script
        unity_script = """#if UNITY_EDITOR
using UnityEngine;
using UnityEditor;
using System.IO;
using System.Collections.Generic;

public class SplatSceneImporter : EditorWindow
{
    private string jsonPath = "Assets/scene_layout.json";

    [MenuItem("Tools/VIT Splat Scene Importer")]
    public static void ShowWindow()
    {
        GetWindow<SplatSceneImporter>("Splat Importer");
    }

    private void OnGUI()
    {
        GUILayout.Label("Import VIT Engine Assets", EditorStyles.boldLabel);
        jsonPath = EditorGUILayout.TextField("Scene Layout JSON Path", jsonPath);

        if (GUILayout.Button("Import Scene"))
        {
            ImportScene();
        }
    }

    private void ImportScene()
    {
        if (!File.Exists(jsonPath))
        {
            EditorUtility.DisplayDialog("Error", "JSON file not found at: " + jsonPath, "OK");
            return;
        }

        string jsonText = File.ReadAllText(jsonPath);
        SceneData sceneData = JsonUtility.FromJson<SceneData>(jsonText);

        GameObject root = new GameObject("SplatScene_" + sceneData.scene_id);

        foreach (var seg in sceneData.segments)
        {
            GameObject segObj = new GameObject(seg.name);
            segObj.transform.parent = root.transform;

            segObj.transform.position = new Vector3(seg.position[0], seg.position[1], seg.position[2]);
            segObj.transform.rotation = new Quaternion(seg.rotation[0], seg.rotation[1], seg.rotation[2], seg.rotation[3]);
            segObj.transform.localScale = new Vector3(seg.scale[0], seg.scale[1], seg.scale[2]);

            if (!string.IsNullOrEmpty(seg.collider_file))
            {
                Mesh loadedMesh = AssetDatabase.LoadAssetAtPath<Mesh>(seg.collider_file);
                if (loadedMesh == null)
                {
                    string fileName = Path.GetFileName(seg.collider_file);
                    string[] guids = AssetDatabase.FindAssets(Path.GetFileNameWithoutExtension(fileName));
                    if (guids.Length > 0)
                    {
                        string path = AssetDatabase.GUIDToAssetPath(guids[0]);
                        loadedMesh = AssetDatabase.LoadAssetAtPath<Mesh>(path);
                    }
                }

                if (loadedMesh != null)
                {
                    MeshCollider collider = segObj.AddComponent<MeshCollider>();
                    collider.sharedMesh = loadedMesh;
                    collider.convex = seg.movable;
                    
                    MeshFilter filter = segObj.AddComponent<MeshFilter>();
                    filter.sharedMesh = loadedMesh;
                    MeshRenderer renderer = segObj.AddComponent<MeshRenderer>();
                    renderer.sharedMaterial = AssetDatabase.GetBuiltinExtraResource<Material>("Default-Material.mat");
                    renderer.enabled = false;
                }
            }

            Debug.Log($"Imported segment '{seg.name}'. Visual Splat PLY: {seg.splat_file}");
        }

        EditorUtility.DisplayDialog("Success", "Scene imported successfully!", "OK");
    }

    [System.Serializable]
    public class SceneData
    {
        public string scene_id;
        public List<SegmentData> segments;
    }

    [System.Serializable]
    public class SegmentData
    {
        public string name;
        public string splat_file;
        public string collider_file;
        public float[] position;
        public float[] rotation;
        public float[] scale;
        public bool movable;
    }
}
#endif
"""
        with open(os.path.join(export_dir, "splats_importer_unity.cs"), "w") as f:
            f.write(unity_script)
            
        # Write README.md
        readme = f"""# VIT Game Engine Export Package

This package contains segmented Gaussian Splat visual assets and reconstructed low-poly meshes designed for Unity and Unreal Engine.

## Package Contents
* `Assets/Splats/` - Contains the isolated `.ply` Gaussian Splat files for each room segment and background.
* `Assets/Colliders/` - Contains the simplified `.obj` collision meshes reconstructed via Poisson Surface Reconstruction.
* `scene_layout.json` - Positional layout data mapping each segment's centroid, rotation, and file paths.
* `splats_importer_unity.cs` - Unity Editor automation script.

---

## 1. Unity Integration Guide

### Requirements
Ensure you have a Gaussian Splat rendering plugin installed in your project, such as:
* [Keijiro Takahashi's PicoSplat](https://github.com/keijiro/PicoSplat) or standard Splat package.

### How to Import
1. Copy the `Assets/` directory contents directly into your Unity project's `Assets` folder.
2. Put `splats_importer_unity.cs` inside any folder named `Editor` (e.g. `Assets/Editor/SplatSceneImporter.cs`).
3. In Unity, select **Tools > VIT Splat Scene Importer** from the top menu bar.
4. Keep the JSON path as `Assets/scene_layout.json` and click **Import Scene**.
5. The script will automatically instantiate GameObjects for all segments, apply the `.obj` meshes to `MeshCollider` components, and disable their `MeshRenderer` so they act as invisible colliders.
6. Attach a Splat renderer/Visual Component pointing to the corresponding `.ply` file in `Assets/Splats/` for each segment GameObject.

---

## 2. Unreal Engine Integration Guide

### Requirements
Ensure you have a 3DGS plugin installed, such as:
* [Luma Unreal Engine Plugin](https://lumalabs.ai/luma-web-ue) or equivalent splat-rendering plugins.

### How to Import
1. Import all `.obj` files in `Assets/Colliders/` into the Unreal Content Browser as **Static Meshes**.
   * In the Import settings, check **Generate Lightmap UVs** and **Enable Collision**.
   * For complex room walls, set **Collision Complexity** to **Use Complex Collision as Simple** inside the Static Mesh Editor.
2. Drag the static meshes into the level and set their positions based on the centroids in `scene_layout.json`.
3. In the Details panel, uncheck **Visible** (or check **Hidden in Game**) for the static meshes so they act as invisible collision geometry.
4. Import the visual `.ply` files using your 3DGS plugin and place them at the exact same location coordinates as the collision proxies to render the visuals.
"""
        with open(os.path.join(export_dir, "README.md"), "w") as f:
            f.write(readme)
            
        zip_path = os.path.join(job_dir, "engine_export.zip")
        shutil.make_archive(zip_path[:-4], 'zip', export_dir)
        
        shutil.rmtree(export_dir, ignore_errors=True)
        
        return FileResponse(zip_path, media_type="application/zip", filename=f"VIT_Engine_Export_{job_id[:8]}.zip")
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, status_code=500)


@app.websocket("/progress/{job_id}")
async def progress_ws(websocket: WebSocket, job_id: str) -> None:
    await websocket.accept()

    if job_id not in progress_queues:
        progress_queues[job_id] = asyncio.Queue()

    q = progress_queues[job_id]

    try:
        while True:
            msg = await q.get()
            if msg is None:
                await websocket.close()
                break
            await websocket.send_json(msg)
    except WebSocketDisconnect:
        pass
    finally:
        progress_queues.pop(job_id, None)

@app.get("/jobs/{job_id}")
async def get_job_status(job_id: str) -> JSONResponse:
    job = jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    return JSONResponse({
        "job_id": job_id, 
        "status": job["status"],
        "current_phase": job["current_phase"],
        "completed_phases": job["completed_phases"]
    })

@app.get("/jobs/{job_id}/logs")
async def get_job_logs(job_id: str) -> JSONResponse:
    log_path = os.path.join(JOBS_DIR, job_id, "logs.jsonl")
    logs = []
    if os.path.exists(log_path):
        try:
            with open(log_path, "r") as f:
                for line in f:
                    if line.strip():
                        logs.append(json.loads(line))
        except Exception:
            pass
    return JSONResponse(logs)

@app.get("/result/{job_id}")
async def get_result(job_id: str) -> JSONResponse:
    job = jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    if job["status"] != "done":
        return JSONResponse({"error": "Pipeline not finished yet", "status": job["status"]}, status_code=202)
    return JSONResponse({
        "status": "done",
        "job_id": job_id,
        "result_url": None,
        "message": "Stub — no real .ply file generated yet.",
    })

@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok", "version": "0.1.0-modular"})

@app.get("/jobs")
async def list_jobs() -> JSONResponse:
    return JSONResponse([
        {"job_id": jid, "status": j["status"], "filename": j.get("filename", "")}
        for jid, j in jobs.items()
    ])

@app.delete("/jobs/{job_id}")
async def delete_job(job_id: str) -> JSONResponse:
    if job_id not in jobs:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    del jobs[job_id]
    job_dir = os.path.join(JOBS_DIR, job_id)
    if os.path.exists(job_dir):
        shutil.rmtree(job_dir)
    return JSONResponse({"status": "deleted", "job_id": job_id})

@app.post("/export-vr")
async def export_vr(body: dict) -> JSONResponse:
    job_id = body.get("job_id")
    if not job_id or job_id not in jobs:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)

    input_dir = make_job_dir(job_id)
    filename = jobs[job_id].get("filename")
    if not filename:
        return JSONResponse({"error": "No file uploaded for this job"}, status_code=400)
        
    input_ply_path = os.path.join(input_dir, filename)
    if not os.path.exists(input_ply_path):
        return JSONResponse({"error": "Input .ply file not found"}, status_code=404)

    output_dir = os.path.join(JOBS_DIR, job_id, "vr-assets")
    
    try:
        manifest = process_vr_export(job_id, input_ply_path, output_dir)
        return JSONResponse({
            "status": "success", 
            "manifest_url": f"http://localhost:8000/jobs/{job_id}/vr-assets/manifest.json",
            "manifest": manifest
        })
    except Exception as e:
        print(f"[Error] VR Export failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)

@app.post("/run-mesh-pipeline")
async def run_mesh_pipeline(body: dict) -> JSONResponse:
    job_id = body.get("job_id")
    if not job_id or job_id not in jobs:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)

    job_dir = os.path.join(JOBS_DIR, job_id)
    ply_files = glob.glob(os.path.join(job_dir, "output", "point_cloud", "iteration_*", "point_cloud.ply"))
    if not ply_files:
        filename = jobs[job_id].get("filename", "")
        ply_path = os.path.join(job_dir, "input", filename)
        if not os.path.exists(ply_path) or not ply_path.endswith(".ply"):
            return JSONResponse({"error": "No trained 3DGS point cloud (.ply) or input .ply found for this job"}, status_code=404)
    else:
        ply_files.sort(key=os.path.getmtime, reverse=True)
        ply_path = ply_files[0]

    output_dir = os.path.join(job_dir, "mesh-pipeline-assets")
    os.makedirs(output_dir, exist_ok=True)

    targets = body.get("targets", None)
    
    # Run in a background executor thread to avoid blocking FastAPI
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            None, 
            run_unsegmented_mesh_pipeline, 
            ply_path, 
            output_dir, 
            targets
        )
        return JSONResponse({
            "status": "success",
            "message": "Mesh pipeline executed successfully!",
            "result": result
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse({"status": "failed", "error": str(e)}, status_code=500)


@app.post("/mesh-ply")
async def mesh_ply(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    if not file.filename.endswith(".ply"):
        return JSONResponse({"error": "Only .ply files are supported"}, status_code=400)
        
    import uuid
    job_id = "ply_" + str(uuid.uuid4())[:8]
    job_dir_root = os.path.join(JOBS_DIR, job_id)
    
    input_dir = os.path.join(job_dir_root, "input")
    os.makedirs(input_dir, exist_ok=True)
    file_path = os.path.join(input_dir, file.filename)
    
    content = await file.read()
    with open(file_path, "wb") as f:
        f.write(content)
        
    jobs[job_id] = {
        "job_id": job_id,
        "status": "running",
        "current_phase": 5,
        "completed_phases": [],
        "filename": file.filename,
        "config": {"filename": file.filename}
    }
    save_job_metadata(job_id)
    
    if job_id not in progress_queues:
        progress_queues[job_id] = asyncio.Queue()
        
    async def run_pipeline_bg():
        try:
            async def push_ws_callback(msg):
                await push(job_id, msg)
                
            await run_mesh_segmentation_pipeline(job_id, job_dir_root, {"filename": file.filename, "only_mesh": True}, push_ws_callback)
            
            jobs[job_id]["status"] = "done"
            jobs[job_id]["completed_phases"] = [5]
            save_job_metadata(job_id)
            
            await push(job_id, {
                "type": "step_end", 
                "step": 5, 
                "progress": 100, 
                "text": "complete", 
                "manifest_url": f"http://localhost:8000/jobs/{job_id}/vr-assets/manifest.json"
            })
            await push(job_id, None)
        except Exception as e:
            import traceback
            traceback.print_exc()
            await push(job_id, {"type": "log", "step": 5, "progress": 100, "text": f"Error during processing: {str(e)}"})
            await push(job_id, None)
            
    background_tasks.add_task(run_pipeline_bg)
    
    return JSONResponse({
        "status": "processing",
        "job_id": job_id
    })


class CropRequest(BaseModel):
    job_id: str
    box_center: list[float]
    box_rotation: list[float]
    box_scale: list[float]
    crop_inside: bool = True

@app.post("/crop-ply")
async def crop_ply(req: CropRequest):
    try:
        job_id = req.job_id
        job_dir = os.path.join(JOBS_DIR, job_id)
        if not os.path.exists(job_dir):
            return JSONResponse({"status": "failed", "error": "Job not found"}, status_code=404)
            
        vr_assets_dir = os.path.join(job_dir, "vr-assets")
        ply_path = os.path.join(vr_assets_dir, "background.ply")
        if not os.path.exists(ply_path):
            # Fallback to older job path
            ply_path = os.path.join(job_dir, "input/vr-assets/background.ply")
            vr_assets_dir = os.path.join(job_dir, "input/vr-assets")
            if not os.path.exists(ply_path):
                return JSONResponse({"status": "failed", "error": "background.ply not found"}, status_code=404)

        from plyfile import PlyData, PlyElement
        plydata = PlyData.read(ply_path)
        vertex = plydata['vertex']
        
        # Unpack positions if compressed
        if 'packed_position' in vertex.data.dtype.names:
            packed_positions = np.array(vertex['packed_position'])
            chunk = plydata['chunk']
            chunk_min_x = np.array(chunk['min_x'])
            chunk_max_x = np.array(chunk['max_x'])
            chunk_min_y = np.array(chunk['min_y'])
            chunk_max_y = np.array(chunk['max_y'])
            chunk_min_z = np.array(chunk['min_z'])
            chunk_max_z = np.array(chunk['max_z'])
            
            chunk_idx = np.clip(np.arange(len(packed_positions)) // 256, 0, len(chunk_min_x) - 1)
            
            min_x = chunk_min_x[chunk_idx]
            max_x = chunk_max_x[chunk_idx]
            min_y = chunk_min_y[chunk_idx]
            max_y = chunk_max_y[chunk_idx]
            min_z = chunk_min_z[chunk_idx]
            max_z = chunk_max_z[chunk_idx]
            
            x_norm = (packed_positions >> 21) & 0x7FF
            y_norm = (packed_positions >> 11) & 0x3FF
            z_norm = packed_positions & 0x7FF
            
            vx = x_norm / 2047.0 * (max_x - min_x) + min_x
            vy = y_norm / 1023.0 * (max_y - min_y) + min_y
            vz = z_norm / 2047.0 * (max_z - min_z) + min_z
        else:
            vx = np.array(vertex['x'])
            vy = np.array(vertex['y'])
            vz = np.array(vertex['z'])

        # Convert to Three.js coordinates (Y and Z inverted)
        pts_three = np.vstack([vx, -vy, -vz]).T

        # Get box center and scale
        C = np.array(req.box_center)
        S = np.array(req.box_scale)
        
        # Quaternion to rotation matrix
        qx, qy, qz, qw = req.box_rotation
        R = np.array([
            [1 - 2*qy*qy - 2*qz*qz,     2*qx*qy - 2*qz*qw,       2*qx*qz + 2*qy*qw],
            [2*qx*qy + 2*qz*qw,         1 - 2*qx*qx - 2*qz*qz,   2*qy*qz - 2*qx*qw],
            [2*qx*qz - 2*qy*qw,         2*qy*qz + 2*qx*qw,       1 - 2*qx*qx - 2*qy*qy]
        ])
        
        # Local space: p_local = (p_three - C) @ R
        pts_local = (pts_three - C) @ R
        
        # Check if inside bounds
        inside = (np.abs(pts_local[:, 0]) <= S[0] / 2.0) & \
                 (np.abs(pts_local[:, 1]) <= S[1] / 2.0) & \
                 (np.abs(pts_local[:, 2]) <= S[2] / 2.0)

        mask = ~inside if req.crop_inside else inside
        
        filtered_vertex = vertex.data[mask]
        
        new_elements = []
        for elem in plydata.elements:
            if elem.name == 'vertex':
                new_elements.append(PlyElement.describe(filtered_vertex, 'vertex'))
            else:
                new_elements.append(elem)

        # Write to vr-assets/background.ply
        PlyData(new_elements, text=plydata.text, byte_order=plydata.byte_order).write(ply_path)
        
        # Also write to input folder if it exists
        input_ply_path = os.path.join(job_dir, "input/input/3dgs_compressed.ply")
        if os.path.exists(input_ply_path):
            PlyData(new_elements, text=plydata.text, byte_order=plydata.byte_order).write(input_ply_path)

        # Re-run Poisson mesh reconstruction to update room collision GLB
        from runners.mesh_pipeline import extract_mesh
        import trimesh
        
        master_mesh_path = os.path.join(job_dir, "input/mesh-pipeline-assets/master_scene_mesh.obj")
        extract_mesh(input_ply_path if os.path.exists(input_ply_path) else ply_path, master_mesh_path)
        
        scene_mesh = trimesh.load(master_mesh_path)
        if isinstance(scene_mesh, trimesh.Scene):
            scene_mesh = scene_mesh.to_mesh()
        
        scene_glb_path = os.path.join(vr_assets_dir, "scene_collision.glb")
        scene_mesh.export(scene_glb_path)
        
        return {"status": "success", "retained_points": int(np.sum(mask))}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse({"status": "failed", "error": str(e)}, status_code=500)


def get_directory_tree(path: str) -> dict:
    tree = {"name": os.path.basename(path), "type": "directory", "children": []}
    try:
        for item in sorted(os.listdir(path)):
            item_path = os.path.join(path, item)
            if os.path.isdir(item_path):
                tree["children"].append(get_directory_tree(item_path))
            else:
                size = os.path.getsize(item_path)
                tree["children"].append({"name": item, "type": "file", "size": size})
    except Exception as e:
        pass
    return tree

@app.get("/jobs/{job_id}/tree")
async def get_job_tree(job_id: str) -> JSONResponse:
    job = jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    
    job_dir = os.path.join(JOBS_DIR, job_id)
    if not os.path.exists(job_dir):
        return JSONResponse({"error": "Job directory not found"}, status_code=404)
        
    tree = get_directory_tree(job_dir)
    return JSONResponse(tree)

_dino_model_instance = None

def get_dino_model():
    global _dino_model_instance
    if _dino_model_instance is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        dino_config = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "dev", "checkpoints", "GroundingDINO_SwinT_OGC.py"))
        dino_weights = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "dev", "checkpoints", "groundingdino_swint_ogc.pth"))
        _dino_model_instance = load_dino_model(dino_config, dino_weights).to(device)
    return _dino_model_instance

@app.post("/segment-view")
async def segment_view(file: UploadFile = File(...), prompt: str = Form(None)):
    try:
        content = await file.read()
        
        # Save the captured view image to dev/virtual_camera/outputs/
        output_dir = os.path.join(os.path.dirname(__file__), "..", "dev", "virtual_camera", "outputs")
        os.makedirs(output_dir, exist_ok=True)
        import time
        timestamp = int(time.time())
        save_path = os.path.join(output_dir, f"segment_view_{timestamp}.png")
        with open(save_path, "wb") as f:
            f.write(content)
        
        transform = T.Compose([
            T.RandomResize([800], max_size=1333),
            T.ToTensor(),
            T.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ])
        image_source = Image.open(io.BytesIO(content)).convert("RGB")
        image_transformed, _ = transform(image_source, None)
        
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = get_dino_model()
        
        dino_prompt = (prompt if prompt else "object") + " ."
        
        boxes, logits, phrases = dino_predict(
            model=model, 
            image=image_transformed, 
            caption=dino_prompt,
            box_threshold=0.3, 
            text_threshold=0.25, 
            device=device
        )
        
        detections = []
        if len(boxes) > 0:
            W, H = image_source.size
            boxes_xyxy = boxes * torch.Tensor([W, H, W, H])
            boxes_xyxy[:, :2] -= boxes_xyxy[:, 2:] / 2
            boxes_xyxy[:, 2:] += boxes_xyxy[:, :2]
            
            for box, logit, phrase in zip(boxes_xyxy, logits, phrases):
                x1, y1, x2, y2 = box.tolist()
                detections.append({
                    "class": phrase,
                    "confidence": float(logit),
                    "bbox": [x1, y1, x2, y2],
                    "width": x2 - x1,
                    "height": y2 - y1,
                    "center_x": (x1 + x2) / 2,
                    "center_y": (y1 + y2) / 2
                })
        
        # Sort by size or proximity to center
        img_center_x, img_center_y = image_source.size[0] / 2, image_source.size[1] / 2
        
        for d in detections:
            dist = np.sqrt((d["center_x"] - img_center_x)**2 + (d["center_y"] - img_center_y)**2)
            d["score"] = (d["width"] * d["height"]) / (dist + 1)
            
        detections.sort(key=lambda x: x["score"], reverse=True)
        
        return JSONResponse({"status": "success", "detections": detections})
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[Error] Segmentation failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)

os.makedirs(JOBS_DIR, exist_ok=True)
app.mount("/jobs", StaticFiles(directory=JOBS_DIR), name="jobs")
# Triggering reload for GroundingDINO transformers fix again
