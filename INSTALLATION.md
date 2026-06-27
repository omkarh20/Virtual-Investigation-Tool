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

**Option 1: Conda (Recommended)**
If you are using a conda environment (like `cloudspace` on Lightning Studio), installing via conda-forge is the cleanest way to get a pre-compiled version with CUDA support:
```bash
conda install -c conda-forge colmap
```

**Option 2: APT (Ubuntu / Debian)**
Alternatively, you can install it via the system package manager:
```bash
sudo apt-get update
sudo apt-get install -y colmap
```

### Verification
To verify the installation was successful, run:
```bash
colmap help
```
If this prints the COLMAP help menu, you are ready to run Phase 2.
