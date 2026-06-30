#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "==========================================="
echo "1. Creating Conda Environment (vtool)"
echo "==========================================="
# Create environment if it doesn't exist
conda create -n vtool python=3.10 -y

echo "==========================================="
echo "2. Installing PyTorch (CUDA 12.4 version)"
echo "==========================================="
# Install the specific CUDA 12.4 version of PyTorch first, 
# so the requirements.txt doesn't auto-download the newer incompatible version
conda run -n vtool pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124 --upgrade --force-reinstall

echo "==========================================="
echo "3. Installing Backend Dependencies"
echo "==========================================="
cd backend
conda run -n vtool pip install -r requirements.txt
cd ..

echo "==========================================="
echo "4. Installing COLMAP (CUDA enabled)"
echo "==========================================="
conda install -n vtool -c conda-forge colmap -y

echo "==========================================="
echo "5. Downloading ML Checkpoints"
echo "==========================================="
mkdir -p dev/checkpoints
cd dev/checkpoints

if [ ! -f "sam_hq_vit_h.pth" ]; then
    echo "Downloading SAM HQ..."
    wget https://huggingface.co/lkeab/hq-sam/resolve/main/sam_hq_vit_h.pth
fi

if [ ! -f "GroundingDINO_SwinT_OGC.py" ]; then
    echo "Downloading GroundingDINO Config..."
    wget -O GroundingDINO_SwinT_OGC.py https://raw.githubusercontent.com/IDEA-Research/GroundingDINO/main/groundingdino/config/GroundingDINO_SwinT_OGC.py 
fi

if [ ! -f "groundingdino_swint_ogc.pth" ]; then
    echo "Downloading GroundingDINO Weights..."
    wget -nc -O groundingdino_swint_ogc.pth https://github.com/IDEA-Research/GroundingDINO/releases/download/v0.1.0-alpha/groundingdino_swint_ogc.pth
fi

echo "Installing GroundingDINO packages..."
conda run -n vtool pip install groundingdino-py
conda run -n vtool pip install transformers==4.39.3
cd ../..

echo "==========================================="
echo "6. Setting up 3DGS (Gaussian Splatting)"
echo "==========================================="
git submodule update --init --recursive
conda run -n vtool pip install plyfile tqdm ninja

# Patching the C++ file using sed!
echo "Patching rasterizer_impl.h to fix uint32_t error..."
# This command searches for #include "rasterizer.h" and inserts #include <cstdint> right above it
sed -i 's/#include "rasterizer.h"/#include <cstdint>\n#include "rasterizer.h"/' external/gaussian-splatting/submodules/diff-gaussian-rasterization/cuda_rasterizer/rasterizer_impl.h

# Install custom CUDA extensions (this might take a minute)
echo "Installing diff-gaussian-rasterization..."
conda run -n vtool env MAX_JOBS=4 pip install -v ./external/gaussian-splatting/submodules/diff-gaussian-rasterization --no-build-isolation

echo "Installing simple-knn..."
conda run -n vtool pip install -v ./external/gaussian-splatting/submodules/simple-knn --no-build-isolation

echo "==========================================="
echo "Setup Complete!"
echo "To use this environment, run: conda activate vtool"
echo "==========================================="
