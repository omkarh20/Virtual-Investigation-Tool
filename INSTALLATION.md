# Installation Guide

## 1. Backend Setup (Core API)

The backend is built with Python and FastAPI. It handles the processing jobs and serves the API. 
*(Note: This section covers the basic API setup. 3DGS and COLMAP will be covered later).*

### Prerequisites
1. **Python 3.10**: Make sure you have selected **Python 3.10** in your Lightning Studio environment settings.
2. **FFmpeg**: Required for the frame extraction pipeline. You must install it on your system:
   * **Lightning Studio / Ubuntu**: Run `sudo apt-get update && sudo apt-get install -y ffmpeg`
   * **Mac**: Run `brew install ffmpeg`
   * **Windows**: Download from the official site or use `winget install ffmpeg`

### Installation Steps

The setup process differs slightly depending on whether you are using Lightning AI Studio or your local machine.

#### Option A: Lightning Studio Users
Lightning Studio already provides a default, pre-configured Python environment (named `cloudspace`).
1. Make sure **Python 3.10** is selected in your Studio's Environment settings.
2. Open a new terminal and run:
```bash
cd backend
pip install -r requirements.txt
```

#### Option B: Local Machine Users
For local setups, we recommend creating a virtual environment (using `venv` or `conda` with Python 3.10) to isolate your dependencies.
1. Open your terminal in the root directory (`Virtual-Investigation-Tool`).
2. Create and activate a virtual environment (e.g., using `venv`):
```bash
python -m venv venv
# On Windows: venv\Scripts\activate
# On Mac/Linux: source venv/bin/activate
```
3. Navigate to the backend directory and install the requirements:
```bash
cd backend
pip install -r requirements.txt
```

### What is being installed?
The `requirements.txt` installs the following key components:
* **`fastapi` & `uvicorn[standard]`**: The core web framework and server to run the API.
* **`python-multipart`**: Required for handling file uploads (e.g., uploading your dataset of images).
* **`numpy`, `plyfile`, `trimesh`, `opencv-python`**: Essential libraries for image processing and manipulating 3D point cloud data.
* **`torch`, `ultralytics`, `segment-anything-hq`, `timm`, `CLIP`**: Machine learning libraries for running the semantic segmentation pipeline (YOLO & SAM HQ).

### Running the Server
Once installed, you can start the development server by running:

```bash
uvicorn main:app --reload
```
The server should start running at `http://localhost:8000`.

---

## 2. Viewer Setup (Frontend UI)

The viewer is a web application built with Node.js and Vite that allows you to interact with the 3D models and manage pipeline jobs.

### Prerequisites
Make sure you have **Node.js** (v18 or higher) installed on your system.
*(Note: Lightning AI Studio usually comes with Node.js pre-installed in the default environment).*

### Installation Steps

1. Open a new terminal.
2. Navigate to the `viewer` directory.
3. Install the required Node packages using `npm`:

```bash
cd viewer
npm install
```

### Running the Viewer
Once installed, you can start the development server by running:

```bash
npm run dev
```
The application will boot and be accessible at `http://localhost:5173/`.

---

## 3. COLMAP Setup (Sparse & Dense Reconstruction)

COLMAP is required for Phase 2 and Phase 3 of the pipeline. The backend invokes the `colmap` command directly from your system PATH, so it must be installed as a system executable.

### Installation Steps

The pipeline requires **CUDA support** to run on the GPU. You must use the Conda installation method to get the CUDA-enabled version. Do **not** use `apt-get` unless you intend to run exclusively on the CPU.

**Option 1: Lightning Studio / Conda (Required for GPU/CUDA)**
Lightning.ai environments (`cloudspace`) have Conda pre-installed. Run the following to install the CUDA-enabled version of COLMAP:
```bash
conda install -c conda-forge colmap
```
*(Note: If you previously installed COLMAP via apt-get, you should remove it first to avoid conflicts: `sudo apt-get remove colmap`)*

**Option 2: APT (CPU Only - Not Recommended)**
If you only have a CPU, you can install the non-CUDA version via the system package manager. (You must set `colmap_use_gpu: false` in the pipeline config if you do this, otherwise COLMAP will crash):
```bash
sudo apt-get update
sudo apt-get install -y colmap
```

### Verification
To verify the installation and check for CUDA support, run:
```bash
colmap help
```
Check the first line of the output. If you installed it correctly via Conda, it should say `... with CUDA`. If it says `without CUDA`, you will need to disable GPU mode in the pipeline settings.

---

## 4. Machine Learning Checkpoints (Segmentation)

For the advanced semantic segmentation scripts (like `dev/reprojection/masker3.py`), you need to download specific model checkpoints into the `dev/checkpoints` directory.

### Setup Steps
1. Navigate to the project root and create the checkpoints directory:
```bash
mkdir -p dev/checkpoints
cd dev/checkpoints
```

2. Download the SAM HQ checkpoint:
```bash
wget https://huggingface.co/lkeab/hq-sam/resolve/main/sam_hq_vit_h.pth
```

3. Download the YOLOE-26 Checkpoints:
You can trigger the Ultralytics package to download the YOLO checkpoints automatically by creating and running a quick python script inside that same folder:
```bash
cat << 'EOF' > download_yolo.py
from ultralytics import YOLO
YOLO('yoloe-26x-seg.pt')
YOLO('yoloe-26x-seg-pf.pt')
EOF
python download_yolo.py
rm download_yolo.py
```
*(Make sure to run these commands from inside the `dev/checkpoints` folder so the `.pt` files are saved exactly there).*

4. Install GroundingDINO and Downgrade Transformers:
GroundingDINO should be installed using the community `groundingdino-py` package to avoid PyTorch C++ compilation errors. Furthermore, the `transformers` library must be downgraded to version 4.39.3, as newer versions (>=4.40) remove a function (`get_head_mask` from `BertModel`) that GroundingDINO depends on.
```bash
pip install groundingdino-py
pip install transformers==4.39.3
```

5. Download GroundingDINO Checkpoint & Config:
Still in the `dev/checkpoints` directory, download the SwinT config and model weights:
```bash
wget -O GroundingDINO_SwinT_OGC.py https://raw.githubusercontent.com/IDEA-Research/GroundingDINO/main/groundingdino/config/GroundingDINO_SwinT_OGC.py 
wget -nc -O groundingdino_swint_ogc.pth https://github.com/IDEA-Research/GroundingDINO/releases/download/v0.1.0-alpha/groundingdino_swint_ogc.pth
```
