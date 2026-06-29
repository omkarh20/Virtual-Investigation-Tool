# Virtual Investigation Tool — Full Project Plan

## 1. What This Project Is

The Virtual Investigation Tool (VIT) is a forensic analysis system that digitizes real-world crime scenes into interactive, semantically-segmented 3D environments. An investigator can walk through the scene in VR, select individual objects (a weapon, a piece of furniture, a bloodstain), pick them up, move them, and examine them from any angle.

The system has two major components:

1. **Backend Pipeline** — Python server that orchestrates heavy GPU processing (reconstruction + segmentation)
2. **Frontend Application** — A unified Three.js + SparkJS web app (`viewer/src/`) that serves as both the desktop Editor (for pipeline management and virtual camera placement) and the VR Viewer (for immersive investigation).

---

## 2. Current State of the Project

The project is currently in the **Integration and Polish** phase. The core modules have been built, but they need to be wired together, polished, and tested end-to-end.

### What is Completed (But Needs Polish/Integration)
- **Backend Runners:** The COLMAP, 3DGS, and VR Exporter runners are written (`backend/runners/`).
- **Frontend App:** The unified Three.js + SparkJS + Cannon-es web app is built (`viewer/src/`). It handles the Pipeline Wizard, virtual camera generation, POI markers, label-aware selection, and the VR session.
- **Segmentation Core:** The math and masking logic are completely solved and working locally in `dev/reprojection/` (`masker3.py`, `multi_class_carver_fixed.py`, `normalize_images.py`).

### What is Left to Do (The Roadmap)
1. **3DGS Integration:** The 3DGS runners are written, but we still need to handle proper installation, integration, and end-to-end testing.
2. **Segmentation Integration:** We need to take `normalize_images.py`, `masker3.py`, and `multi_class_carver.py` and hook them up to the actual backend pipeline (Phase 5).
3. **Physics Polish:** The Cannon-es collision and physics logic in the VR Viewer is currently a bit wonky and needs fine-tuning.
4. **VR Polish:** The VR experience is glitchy and needs bug fixes and polishing.
5. **UI Redesign:** A complete visual overhaul of the UI is needed to make it look premium (functionality works, just needs aesthetics).
6. **Paper Results:** Run the finalized end-to-end pipeline on several 3DGS datasets to generate solid results for the research paper.

---

## 3. The Complete Data Flow

This is the end-to-end journey of data through the system, from raw video to VR investigation.

```text
                           PHASE 1: RECONSTRUCTION
                           (Backend, GPU-intensive)

    Raw Video/Images
         │
         ▼
    ┌──────────────────┐
    │ Frame Extraction │  ffmpeg extracts frames from video at configured FPS
    └────────┬─────────┘
             ▼
    ┌──────────────────┐
    │ COLMAP SfM       │  Structure-from-Motion: finds camera poses
    └────────┬─────────┘
             ▼
    ┌──────────────────┐
    │ 3DGS Training    │  Trains Gaussian Splat model from COLMAP output
    └────────┬─────────┘
             │
             ▼

                           PHASE 2: SEGMENTATION
                           (Editor + Backend, interactive)

    ┌──────────────────┐
    │ Load in Editor   │  User loads point_cloud.ply into the Editor
    └────────┬─────────┘
             ▼
    ┌──────────────────┐
    │ Place POI Markers│  User clicks on objects of interest in 3D
    └────────┬─────────┘
             ▼
    ┌──────────────────┐
    │ Generate Virtual │  System creates 100 cameras (global + POI)
    │ Cameras          │  Renders images + exports cameras.json
    └────────┬─────────┘
             ▼
    ┌──────────────────┐
    │ Normalize Images │  (If using raw photos) align EXIF aspect ratios
    │ 2D Segmentation  │  Run SAM/YOLO/DINO on images to get binary masks
    └────────┬─────────┘
             ▼
    ┌──────────────────┐
    │ 3D Label Baking  │  Project masks to 3D and apply label to Gaussians
    └────────┬─────────┘
             │
             ▼

                           PHASE 3: VR INVESTIGATION
                           (VR Viewer, new app)

    ┌──────────────────┐
    │ Segment Splitting│  Group by label, export .spz files + collision .glb
    └────────┬─────────┘
             ▼
    ┌──────────────────┐
    │ VR Viewer        │  Three.js app with SparkJS + Cannon-es for interaction
    └──────────────────┘
```

---

## 4. How the Two Apps Connect

```text
┌─────────────────────────────────────────────────────────────────────┐
│                         BACKEND (FastAPI)                           │
│                         localhost:8000                              │
│                                                                     │
│  POST /upload              ← Frontend sends video/images            │
│  POST /run-pipeline        ← Frontend triggers COLMAP + 3DGS        │
│  WS   /progress/{job_id}   → Frontend receives live progress        │
│  GET  /result/{job_id}     → Frontend downloads labeled .ply        │
│                                                                     │
│  POST /export-vr           ← Frontend triggers segment export       │
│  GET  /vr-assets/manifest  → Frontend fetches segment manifest      │
│  GET  /vr-assets/{file}    → Frontend fetches .spz + .glb files     │
└────────┬──────────────────────────────────┬─────────────────────────┘
         │                                  │
         │ REST + WebSocket                 │ HTTP (static file serving)
         │                                  │
┌────────▼──────────────────────────────────▼────────┐
│  FRONTEND APPLICATION (Three.js + SparkJS)         │
│  localhost:3000                                    │
│                                                    │
│  Desktop Mode:               VR Mode:              │
│  - Pipeline Wizard           - Scene: SplatMesh    │
│  - Virtual Cameras           - Physics: Cannon-es  │
│  - Splat Editing             - Input: WebXR        │
│  - "Enter VR" button         - Interaction         │
└────────────────────────────────────────────────────┘
```
