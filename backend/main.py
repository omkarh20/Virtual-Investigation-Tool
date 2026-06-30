import asyncio
import os
import shutil
import uuid
import glob
import zipfile
import json
import re
from typing import Any

from runners.colmap_sparse import run_colmap_pipeline
from runners.colmap_dense import run_colmap_dense
from runners.train_3dgs import run_3dgs_training
from vr_exporter import process_vr_export

from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect, Form
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

PHASES = [
    {"id": 1, "label": "COLMAP",              "runner": run_colmap_pipeline},
    {"id": 2, "label": "COLMAP Dense",        "runner": run_colmap_dense, "optional": True},
    {"id": 3, "label": "3DGS Training",       "runner": run_3dgs_training},
    {"id": 4, "label": "Segmentation",        "runner": run_segmentation},
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
            
            if should_pause:
                next_pid = pid + 1
                if next_pid == 2 and not enable_dense:
                    next_pid = 3
                
                # Compute next label even for is_end so user can always continue
                if next_pid <= len(PHASES):
                    next_label = PHASES[next_pid - 1]["label"]
                    next_phase_out = next_pid
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

    # If starting at phase 3 (3DGS) or 4 (Segmentation), we need to extract the uploaded zip
    if start_phase in (3, 4):
        input_file = jobs[job_id]["input_path"]
        job_dir = os.path.join(JOBS_DIR, job_id)
        if input_file.endswith(".zip"):
            try:
                with zipfile.ZipFile(input_file, 'r') as zip_ref:
                    zip_ref.extractall(job_dir)
            except Exception as e:
                return JSONResponse({"error": f"Failed to extract zip for phase {start_phase}: {e}"}, status_code=400)

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
        # Return labelled PLY
        ply_path = os.path.join(job_dir, "segmentation", "labelled_point_cloud.ply")
        if not os.path.exists(ply_path):
            return JSONResponse({"error": "No labelled .ply found"}, status_code=404)
        return FileResponse(ply_path, media_type="application/octet-stream", filename="labelled_point_cloud.ply")
        
    return JSONResponse({"error": "Download not supported for this phase"}, status_code=400)

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
