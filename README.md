# Virtual Investigation Tool

A professional-grade forensic analysis tool that combines 3D Gaussian Splatting (3DGS) with semantic segmentation to create interactive, digitized crime scenes.

## Repository Structure

* **`backend/`**: Python FastAPI server that runs COLMAP, 3DGS training, and segmentation.
* **`frontend/`**: The customized SuperSplat 3D viewer and Pipeline UI (Git Submodule).
* **`external/gaussian-splatting/`**: Official 3DGS training codebase (Git Submodule).

---

## Installation Guide for Teammates

### 1. Clone the Repository (Important!)
Because this repository uses Git Submodules for the frontend and the 3DGS trainer, you **must** use the `--recursive` flag when cloning.

```bash
git clone --recursive https://github.com/YOUR-USERNAME/Virtual-Investigation-Tool.git
cd Virtual-Investigation-Tool
```
*(If you already cloned it without the flag, run `git submodule update --init --recursive` to fetch the missing folders).*

### 2. System Prerequisites
You must have the following installed on your machine:
* **Node.js** (v18 or higher recommended)
* **Python** (3.10 or higher recommended)
* **COLMAP**: Download the executable and add it to your system PATH.

### 3. Frontend Setup
The frontend is a specialized fork of SuperSplat.

```bash
# Navigate to the frontend directory
cd frontend

# Install Node modules
npm install

# Start the development server
npm run develop
```
*The app will automatically open in your browser at `http://localhost:3000/`.*

### 4. Backend Setup
The backend orchestrates the heavy processing.

```bash
# Open a new terminal and navigate to the root directory
cd Virtual-Investigation-Tool

# Create and activate a Python virtual environment
python -m venv venv
venv\Scripts\activate  # On Windows
# source venv/bin/activate  # On Mac/Linux

# Install backend dependencies
cd backend
# pip install -r requirements.txt (Will be added soon)
```uvicorn main:app --reload --port 8000
