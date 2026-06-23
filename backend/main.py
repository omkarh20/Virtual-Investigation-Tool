"""
VIT Backend — Stubbed FastAPI Server

This is a barebones server for UI development.
No real COLMAP, 3DGS, or segmentation runs here — all pipeline stages
are faked with asyncio sleeps that stream progress over WebSocket.

Run with:
    uvicorn main:app --reload --port 8000
"""

import asyncio
import os
import shutil
import uuid
from typing import Any

from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="VIT Backend", version="0.1.0-stub")

# ── CORS — allow the SuperSplat dev server and Vite Viewer ───────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173", "http://127.0.0.1:5173"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── In-memory job store ─────────────────────────────────────────────────────
# job_id -> { "status": str, "input_path": str, "config": dict }
jobs: dict[str, dict[str, Any]] = {}

# job_id -> asyncio.Queue of progress messages for the WebSocket
progress_queues: dict[str, asyncio.Queue] = {}

JOBS_DIR = os.environ.get("JOBS_DIR", "./jobs")


# ── Helpers ─────────────────────────────────────────────────────────────────

def make_job_dir(job_id: str) -> str:
    path = os.path.join(JOBS_DIR, job_id, "input")
    os.makedirs(path, exist_ok=True)
    return path


async def push(job_id: str, msg: dict) -> None:
    """Push a progress message to the WebSocket queue for this job."""
    q = progress_queues.get(job_id)
    if q:
        await q.put(msg)


async def fake_pipeline(job_id: str, config: dict) -> None:
    """
    Simulates the 4-stage pipeline by sleeping and emitting progress events.
    Replace this with real subprocess calls in the future.
    """
    steps = [
        ("Extracting frames",    1, 4),
        ("Running COLMAP SfM",   2, 4),
        ("Training 3DGS model",  3, 4),
        ("Segmenting model",     4, 4),
    ]

    jobs[job_id]["status"] = "running"

    for label, step_num, total_steps in steps:
        # Signal start of this step
        await push(job_id, {
            "type": "step_start",
            "step": step_num,
            "total": total_steps,
            "label": label,
            "progress": round((step_num - 1) / total_steps * 100),
        })

        # Simulate sub-step logs
        for i in range(5):
            await asyncio.sleep(0.6)
            pct = round(((step_num - 1) + (i + 1) / 5) / total_steps * 100)
            await push(job_id, {
                "type": "log",
                "step": step_num,
                "progress": pct,
                "text": f"[Step {step_num}/{total_steps}] {label} — tick {i + 1}/5",
            })

    # Done
    jobs[job_id]["status"] = "done"
    await push(job_id, {
        "type": "done",
        "progress": 100,
        "text": "Pipeline complete.",
        "result_url": f"/result/{job_id}",
    })

    # Sentinel — tells the WS handler to close
    await push(job_id, None)


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.post("/upload")
async def upload(file: UploadFile = File(...)) -> JSONResponse:
    """
    Accept a video or image upload, save it to disk, and return a job_id.
    """
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
    }
    progress_queues[job_id] = asyncio.Queue()

    return JSONResponse({"job_id": job_id, "filename": file.filename})


@app.post("/run-pipeline")
async def run_pipeline(body: dict) -> JSONResponse:
    """
    Start the pipeline for a given job_id.
    Body: {
      "job_id": "...",
      "config": {
        "case_id": str,
        "investigator": str,
        "scene_description": str,
        "frame_rate": str,          # "1" | "2" | "5" | "all"
        "blur_threshold": int,       # 0-100
        "colmap_quality": str,       # "low" | "medium" | "high"
        "colmap_matcher": str,       # "exhaustive" | "sequential" | "spatial"
        "colmap_camera_model": str,  # "PINHOLE" | "OPENCV" | "SIMPLE_RADIAL"
        "colmap_use_gpu": bool,
        "gs_iterations": int,
        "gs_max_resolution": int,    # 1024 | 2048 | 4096 | 0 (uncapped)
        "gs_densification_interval": int,
        "seg_vote_ratio": float
      }
    }
    """
    job_id = body.get("job_id")

    if not job_id or job_id not in jobs:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)

    if jobs[job_id]["status"] == "running":
        return JSONResponse({"error": "Pipeline already running"}, status_code=409)

    config = body.get("config", {})
    jobs[job_id]["config"] = config

    # Log the full config so we can verify all fields arrive correctly
    print(f"[VIT] Starting pipeline for job {job_id}")
    print(f"[VIT] Config received:")
    for key, value in config.items():
        print(f"  {key}: {value!r}")

    # Ensure queue exists (in case WS connects before this call)
    if job_id not in progress_queues:
        progress_queues[job_id] = asyncio.Queue()

    # Kick off the fake pipeline in the background
    asyncio.create_task(fake_pipeline(job_id, config))

    return JSONResponse({"status": "started", "job_id": job_id})


@app.websocket("/progress/{job_id}")
async def progress_ws(websocket: WebSocket, job_id: str) -> None:
    """
    Stream pipeline progress events to the browser.
    Each message is a JSON object. A None sentinel closes the socket.
    """
    await websocket.accept()

    if job_id not in progress_queues:
        progress_queues[job_id] = asyncio.Queue()

    q = progress_queues[job_id]

    try:
        while True:
            msg = await q.get()
            if msg is None:
                # Pipeline finished — close cleanly
                await websocket.close()
                break
            await websocket.send_json(msg)
    except WebSocketDisconnect:
        pass
    finally:
        # Clean up queue when client disconnects
        progress_queues.pop(job_id, None)


@app.get("/result/{job_id}")
async def get_result(job_id: str) -> JSONResponse:
    """
    Return the result path for a completed job.
    In this stub, we just return a status — no real .ply file yet.
    """
    job = jobs.get(job_id)

    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)

    if job["status"] != "done":
        return JSONResponse({"error": "Pipeline not finished yet", "status": job["status"]}, status_code=202)

    # Future: return the actual .ply file URL
    return JSONResponse({
        "status": "done",
        "job_id": job_id,
        "result_url": None,  # Will point to the .ply file once the real pipeline runs
        "message": "Stub — no real .ply file generated yet.",
    })


@app.get("/jobs/{job_id}")
async def get_job_status(job_id: str) -> JSONResponse:
    """Get the current status of a job."""
    job = jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)
    return JSONResponse({"job_id": job_id, "status": job["status"]})


@app.get("/health")
async def health() -> JSONResponse:
    """Simple health check."""
    return JSONResponse({"status": "ok", "version": "0.1.0-stub"})


@app.get("/jobs")
async def list_jobs() -> JSONResponse:
    """Return a list of all in-memory jobs. Placeholder for future DB-backed project listing."""
    return JSONResponse([
        {"job_id": jid, "status": j["status"], "filename": j.get("filename", "")}
        for jid, j in jobs.items()
    ])

# ── VR Export Phase 3 ────────────────────────────────────────────────────────
from vr_exporter import process_vr_export

@app.post("/export-vr")
async def export_vr(body: dict) -> JSONResponse:
    """
    Triggers Phase 3: Split the PLY file, generate collision meshes, and create manifest.
    """
    job_id = body.get("job_id")
    if not job_id or job_id not in jobs:
        return JSONResponse({"error": "Unknown job_id"}, status_code=404)

    input_dir = make_job_dir(job_id)
    # The uploaded file name was saved in jobs dict
    filename = jobs[job_id].get("filename")
    if not filename:
        return JSONResponse({"error": "No file uploaded for this job"}, status_code=400)
        
    input_ply_path = os.path.join(input_dir, filename)
    
    if not os.path.exists(input_ply_path):
        return JSONResponse({"error": "Input .ply file not found"}, status_code=404)

    output_dir = os.path.join(JOBS_DIR, job_id, "vr-assets")
    
    try:
        # Run the exporter script
        manifest = process_vr_export(job_id, input_ply_path, output_dir)
        return JSONResponse({
            "status": "success", 
            "manifest_url": f"http://localhost:8000/jobs/{job_id}/vr-assets/manifest.json",
            "manifest": manifest
        })
    except Exception as e:
        print(f"[Error] VR Export failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)

# Mount the jobs directory so the Viewer can fetch the vr-assets
os.makedirs(JOBS_DIR, exist_ok=True)
app.mount("/jobs", StaticFiles(directory=JOBS_DIR), name="jobs")
