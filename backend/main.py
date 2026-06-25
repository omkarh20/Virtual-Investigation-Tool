import asyncio
import os
import shutil
import uuid
import glob
import zipfile
from typing import Any

from runners.preprocessor import process_inputs
from runners.colmap_sparse import run_colmap_sparse
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

gsa_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "Grounded-Segment-Anything"))
if gsa_path not in sys.path:
    sys.path.insert(0, gsa_path)
    sys.path.insert(0, os.path.join(gsa_path, "GroundingDINO"))

from groundingdino.util.inference import load_model as load_dino_model, predict as dino_predict
import groundingdino.datasets.transforms as T

app = FastAPI(title="VIT Backend", version="0.1.0-modular")

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
JOBS_DIR = os.environ.get("JOBS_DIR", "./jobs")

def make_job_dir(job_id: str) -> str:
    path = os.path.join(JOBS_DIR, job_id, "input")
    os.makedirs(path, exist_ok=True)
    return path

async def push(job_id: str, msg: dict) -> None:
    q = progress_queues.get(job_id)
    if q:
        await q.put(msg)

PHASES = [
    {"id": 1, "label": "Preparing Images",   "runner": process_inputs},
    {"id": 2, "label": "COLMAP Sparse",       "runner": run_colmap_sparse},
    {"id": 3, "label": "COLMAP Dense",        "runner": run_colmap_dense, "optional": True},
    {"id": 4, "label": "3DGS Training",       "runner": run_3dgs_training},
    {"id": 5, "label": "Segmentation",        "runner": "dummy", "simulated": True},
]

async def run_pipeline_orchestrator(job_id: str, end_phase: int = None):
    job = jobs[job_id]
    job["status"] = "running"
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
            
        if phase.get("optional") and pid == 3 and not enable_dense:
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
            elif pid == 1:
                input_dir = make_job_dir(job_id)
                images_dir = os.path.join(JOBS_DIR, job_id, "images")
                await process_inputs(job_id, input_dir, images_dir, config, lambda msg: push(job_id, msg))
                result = {"image_dir": images_dir}
            else:
                job_dir = os.path.join(JOBS_DIR, job_id)
                runner_func = phase["runner"]
                result = await runner_func(job_id, job_dir, config, lambda msg: push(job_id, msg))
                
            job["completed_phases"].append(pid)
            if "phase_results" not in job:
                job["phase_results"] = {}
            job["phase_results"][str(pid)] = result
            
            await push(job_id, {
                "type": "phase_complete",
                "phase": pid,
                "label": phase["label"],
                "summary": str(result)
            })
            
            # Check if we should stop here
            is_end = end_phase is not None and pid == end_phase
            
            if is_end or (job["run_mode"] == "step" and pid < len(PHASES)):
                next_pid = pid + 1
                if next_pid == 3 and not enable_dense:
                    next_pid = 4
                    
                if is_end:
                    job["status"] = "paused"
                    await push(job_id, {"type": "phase_paused", "next_phase": None, "next_label": None})
                    return
                elif next_pid <= len(PHASES):
                    next_label = PHASES[next_pid - 1]["label"]
                    job["status"] = "paused"
                    await push(job_id, {
                        "type": "phase_paused",
                        "next_phase": next_pid,
                        "next_label": next_label
                    })
                    return 
                
        except Exception as e:
            await push(job_id, {"type": "log", "step": pid, "progress": 100, "text": f"Error: {e}"})
            job["status"] = "failed"
            await push(job_id, None)
            return

    job["status"] = "done"
    await push(job_id, {
        "type": "done",
        "progress": 100,
        "text": "Pipeline complete!",
        "result_url": f"/result/{job_id}",
    })
    await push(job_id, None)


@app.post("/upload")
async def upload(file: UploadFile = File(...)) -> JSONResponse:
    job_id = str(uuid.uuid4())
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

    # If starting at phase 4 (3DGS), we need to extract the uploaded zip containing images & sparse
    if start_phase == 4:
        input_file = jobs[job_id]["input_path"]
        job_dir = os.path.join(JOBS_DIR, job_id)
        if input_file.endswith(".zip"):
            try:
                with zipfile.ZipFile(input_file, 'r') as zip_ref:
                    zip_ref.extractall(job_dir)
            except Exception as e:
                return JSONResponse({"error": f"Failed to extract zip for 3DGS: {e}"}, status_code=400)

    if job_id not in progress_queues:
        progress_queues[job_id] = asyncio.Queue()

    asyncio.create_task(run_pipeline_orchestrator(job_id, end_phase))
    return JSONResponse({"status": "started", "job_id": job_id})

@app.post("/continue-pipeline")
async def continue_pipeline(body: dict) -> JSONResponse:
    job_id = body.get("job_id")
    if not job_id or job_id not in jobs:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)

    if jobs[job_id]["status"] != "paused":
        return JSONResponse({"error": "Pipeline is not paused"}, status_code=409)

    mode = body.get("mode", "step")
    jobs[job_id]["run_mode"] = mode

    if job_id not in progress_queues:
        progress_queues[job_id] = asyncio.Queue()

    asyncio.create_task(run_pipeline_orchestrator(job_id))
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
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for d in ["images", "sparse"]:
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
        # Return .ply
        ply_files = glob.glob(os.path.join(job_dir, "output", "point_cloud", "iteration_*", "point_cloud.ply"))
        if not ply_files:
            return JSONResponse({"error": "No .ply found"}, status_code=404)
        ply_files.sort(key=os.path.getmtime, reverse=True)
        return FileResponse(ply_files[0], media_type="application/octet-stream", filename="model.ply")
        
    return JSONResponse({"error": "Download not supported for this phase"}, status_code=400)


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

_dino_model_instance = None

def get_dino_model():
    global _dino_model_instance
    if _dino_model_instance is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        dino_config = os.path.join(gsa_path, "GroundingDINO", "groundingdino", "config", "GroundingDINO_SwinT_OGC.py")
        dino_weights = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "checkpoints", "groundingdino_swint_ogc.pth"))
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
