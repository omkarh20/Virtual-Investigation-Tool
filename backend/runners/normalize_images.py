#!/usr/bin/env python3
import os
import sys
import json
import argparse
import cv2

def build_camera_lookup(cameras):
    lookup = {}
    for cam in cameras:
        img_name = cam.get("img_name", "")
        if not img_name:
            continue
        # Use lowercased basename to match robustly
        stem = os.path.splitext(os.path.basename(img_name))[0].lower()
        lookup[stem] = cam
    return lookup

def main():
    parser = argparse.ArgumentParser(description="Normalize image rotations to match COLMAP raw sensor orientation.")
    parser.add_argument("--images_dir", required=True, help="Directory containing the input images")
    parser.add_argument("--cameras", required=True, help="Path to cameras.json containing COLMAP dimensions")
    
    args = parser.parse_args()

    if not os.path.exists(args.images_dir):
        print(f"Error: Images directory not found: {args.images_dir}")
        sys.exit(1)
        
    if not os.path.exists(args.cameras):
        print(f"Error: cameras.json not found: {args.cameras}")
        sys.exit(1)

    print(f"Loading camera parameters from {args.cameras}...")
    with open(args.cameras, "r") as f:
        cameras = json.load(f)
        
    camera_lookup = build_camera_lookup(cameras)
    
    image_files = sorted([f for f in os.listdir(args.images_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
    
    if not image_files:
        print(f"No images found in {args.images_dir}")
        sys.exit(0)

    parent_dir = os.path.dirname(os.path.abspath(args.images_dir))
    output_dir = os.path.join(parent_dir, "images_normalized")
    os.makedirs(output_dir, exist_ok=True)
    
    print(f"Found {len(image_files)} images. Outputting to {output_dir}...")
    
    rotated_count = 0
    copied_count = 0
    
    import shutil
    
    for img_file in image_files:
        stem = os.path.splitext(img_file)[0].lower()
        cam = camera_lookup.get(stem)
        
        img_path = os.path.join(args.images_dir, img_file)
        out_path = os.path.join(output_dir, img_file)
        
        if cam is None:
            # If no camera matches, just copy it over so it's not lost
            shutil.copy2(img_path, out_path)
            copied_count += 1
            continue
            
        # Read the raw pixels
        img = cv2.imread(img_path)
        if img is None:
            print(f"  [Error] Could not read {img_file}")
            continue
            
        h, w = img.shape[:2]
        expected_w = cam["width"]
        expected_h = cam["height"]
        
        # Check if aspect ratio is inverted (Portrait vs Landscape mismatch)
        if (h > w and expected_w > expected_h) or (w > h and expected_h > expected_w):
            print(f"  [Rotating] {img_file} (Found {w}x{h}, expected {expected_w}x{expected_h})")
            
            # Rotate 90 degrees Counter-Clockwise to match COLMAP's landscape tracking
            img_rotated = cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
            cv2.imwrite(out_path, img_rotated)
            rotated_count += 1
        else:
            # Aspect ratio is correct, just copy the file over to avoid re-encoding compression
            shutil.copy2(img_path, out_path)
            copied_count += 1

    print("-" * 50)
    print(f"Normalization complete. Rotated {rotated_count} images. Copied {copied_count} unrotated images.")
    print(f"All images saved safely to: {output_dir}")

if __name__ == "__main__":
    main()
