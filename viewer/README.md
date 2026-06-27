# VIT (Virtual Investigation Tool) Viewer

A professional-grade interactive 3D scene viewer and segmentation pipeline control panel for digitized crime scene analysis. This application leverages Three.js, `@sparkjsdev/spark` (for 3D Gaussian Splat rendering), and connects to a FastAPI backend to orchestrate frame extraction, COLMAP reconstruction, and 3DGS training.

---

## Table of Contents
- [Project Architecture](#project-architecture)
- [Key Features](#key-features)
- [File & Code Registry](#file--code-registry)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [How It Works](#how-it-works)
  - [1. Reconstruction Pipeline UI](#1-reconstruction-pipeline-ui)
  - [2. Interactive 3D Splat Viewer](#2-interactive-3d-splat-viewer)
  - [3. Virtual Camera System](#3-virtual-camera-system)

---

## Project Architecture

The **VIT Viewer** is a client-side Single Page Application (SPA) structured with standard modular JavaScript and configured with Vite as the bundler.

```mermaid
graph TD
    A[index.html] --> B[main.js]
    B --> C[router.js]
    B --> D[HomePage.js]
    B --> E[PipelinePage.js]
    B --> F[SceneBuilder.js]
    B --> G[VirtualCameraManager.js]
    B --> H[FPSControls.js]
    
    E <--> |WebSockets & REST| I[FastAPI Backend :8000]
    F --> |Loads Splats| J[@sparkjsdev/spark]
```

---

## Key Features

1. **Dashboard & Project Management**: Lists previous/ongoing investigation jobs and permits launching new ones.
2. **Reconstruction Pipeline Configuration**:
   - Supports inputs via video files, local image ZIP folders, or direct directory uploading.
   - Adjusts pipeline configurations (camera models, frame rates, reconstruction quality, 3DGS iterations, and GPU enabling).
   - Real-time step-by-step progress tracking and server log streaming via WebSockets.
3. **Interactive 3D Segmentation & Manipulation**:
   - Renders 3D Gaussian Splats with high-performance WebGL.
   - Provides an object interaction mode for selecting, moving, and rotating distinct segments with 3D transform gizmos.
4. **Virtual Camera Track Export**:
   - Places Points of Interest (POIs) in 3D space.
   - Generates camera viewpoints around POIs using Fibonacci sphere distributions.
   - Previews camera frustums live and exports high-resolution image views and cameras.json metadata for downstream processing.

---

## File & Code Registry

Here is the index of key files and classes in the application:

### Configuration & Entry Points
* [index.html](file:///d:/Virtual-Investigation-Tool/viewer/index.html): The main HTML document containing the page layouts and global UI overlay elements.
* [package.json](file:///d:/Virtual-Investigation-Tool/viewer/package.json): Lists npm dependencies (`three`, `@sparkjsdev/spark`, `cannon-es`, `jszip`) and dev tools.
* [src/main.js](file:///d:/Virtual-Investigation-Tool/viewer/src/main.js): Entry module. Initializes global controls, hooks up pages, and lazily instantiates Three.js when the viewer page is requested.
* [src/style.css](file:///d:/Virtual-Investigation-Tool/viewer/src/style.css): Contains the design system, incorporating premium dark mode styles, glassmorphism panel properties, custom step progress indicators, and transitions.

### Client-Side Router
* [src/router.js](file:///d:/Virtual-Investigation-Tool/viewer/src/router.js): A lightweight, client-side hash router supporting routes:
  - `#/`: Home Dashboard
  - `#/pipeline/:id`: Pipeline Progress Page
  - `#/renderer`: Interactive 3D Viewer

### Controllers & Modules
* [src/HomePage.js](file:///d:/Virtual-Investigation-Tool/viewer/src/HomePage.js): Implements home/dashboard interactions, requesting current status of active and finished jobs from the backend.
* [src/PipelinePage.js](file:///d:/Virtual-Investigation-Tool/viewer/src/PipelinePage.js): Manages pipeline creation, file uploads, WebSocket listeners, step-by-step progress bars, and download links for intermediate pipeline assets.
* [src/ManifestLoader.js](file:///d:/Virtual-Investigation-Tool/viewer/src/ManifestLoader.js) | Class: [ManifestLoader](file:///d:/Virtual-Investigation-Tool/viewer/src/ManifestLoader.js#L3): Standardizes manifest retrieval, downloading active scene structures, segment attributes (centroids, bounding boxes, movable statuses), or falling back to local simulation data.
* [src/SceneBuilder.js](file:///d:/Virtual-Investigation-Tool/viewer/src/SceneBuilder.js) | Class: [SceneBuilder](file:///d:/Virtual-Investigation-Tool/viewer/src/SceneBuilder.js#L5): Constructs the 3D scene. Creates collision/selection hitboxes, handles raycasting selection, links transform controls, and applies delta changes to splat meshes.
* [src/VirtualCameraManager.js](file:///d:/Virtual-Investigation-Tool/viewer/src/VirtualCameraManager.js) | Class: [VirtualCameraManager](file:///d:/Virtual-Investigation-Tool/viewer/src/VirtualCameraManager.js#L4): Computes Fibonacci distributions around markers, handles offscreen WebGL rendering, manages WebWorker splat sorting delays, and exports camera matrices to the client.
* [src/FPSControls.js](file:///d:/Virtual-Investigation-Tool/viewer/src/FPSControls.js) | Class: [FPSControls](file:///d:/Virtual-Investigation-Tool/viewer/src/FPSControls.js#L10): Customized pointer-locked/drag navigation controls allowing users to navigate splat fields seamlessly via WASD + Right-click drag.

---

## Prerequisites

Before running the viewer, ensure you have the following installed:
* **Node.js** (v18.0.0 or higher recommended)
* A modern web browser supporting WebGL2

---

## Getting Started

### 1. Install Dependencies
Run the installation command inside the `viewer/` directory:
```bash
npm install
```

### 2. Start the Development Server
Launch the Vite local development server:
```bash
npm run dev
```
By default, the application will boot and be accessible at:
👉 **[http://localhost:5173/](http://localhost:5173/)**

### 3. Build for Production
Verify typescript compilation and build the production bundle:
```bash
npm run build
```
This compiles assets and packages the app into the `dist/` directory.

---

## How It Works

### 1. Reconstruction Pipeline UI
Within [src/PipelinePage.js](file:///d:/Virtual-Investigation-Tool/viewer/src/PipelinePage.js), users select their data source (video, ZIP, folder) and configure parameters.
* Clicking **Run Pipeline** triggers a POST to the backend's `/run-pipeline` endpoint.
* If a directory input is selected, [src/PipelinePage.js](file:///d:/Virtual-Investigation-Tool/viewer/src/PipelinePage.js) uses **JSZip** to compress images on the fly before uploading.
* A WebSocket connects to `${ws://localhost:8000}/progress/{job_id}` to receive real-time JSON packets updating status rows and progress bars.

### 2. Interactive 3D Splat Viewer
Inside [src/SceneBuilder.js](file:///d:/Virtual-Investigation-Tool/viewer/src/SceneBuilder.js):
* Bounding boxes from the manifest are used to instantiate transparent 3D wireframe boxes ([THREE.BoxGeometry](file:///d:/Virtual-Investigation-Tool/viewer/node_modules/three/src/geometries/BoxGeometry.js)).
* When **Interaction Mode** is active, users can click on an object. A raycast registers against the bounding boxes.
* Once selected, Three's `TransformControls` attach to the hitbox. Moving or rotating the box applies corresponding delta transformations to the Gaussian Splat mesh, taking pivot offsets into account.

### 3. Virtual Camera System
Inside [src/VirtualCameraManager.js](file:///d:/Virtual-Investigation-Tool/viewer/src/VirtualCameraManager.js):
* Clicking on the ground places red sphere markers (POIs).
* A camera path is dynamically generated using Fibonacci distributions.
* An offscreen render canvas uses a white background to isolate splats. The manager yields execution for 100ms per frame, giving the WebWorker splat sorter time to sort depths from the new camera position before the final render is read using `readRenderTargetPixels`.
* Camera positions and orientation matrices are converted from Three.js coordinate space to OpenCV space and exported in a `cameras.json` file.
