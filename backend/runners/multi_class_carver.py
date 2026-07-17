#!/usr/bin/env python3
"""
Multi-Class Mask Reprojection (Ratio Voting + Conflict Resolution).
Processes a master folder containing subfolders of masks (one folder per object).
Resolves overlapping point conflicts by assigning the class with the highest vote ratio.
"""

import argparse
import json
import os
import struct
import sys
import glob

import cv2
import numpy as np


class PLYReader:
    def __init__(self, path):
        self.path = path
        self.format = None
        self.elements = {}
        self.data = {}
        self.parse()

    def parse(self):
        with open(self.path, "rb") as f:
            header_lines = []
            while True:
                line = f.readline().decode("utf-8").strip()
                header_lines.append(line)
                if line == "end_header":
                    break

            current_elem = None
            for line in header_lines:
                if line.startswith("format"):
                    self.format = line.split()[1]
                elif line.startswith("element"):
                    parts = line.split()
                    current_elem = parts[1]
                    count = int(parts[2])
                    self.elements[current_elem] = {"count": count, "properties": []}
                elif line.startswith("property"):
                    parts = line.split()
                    dtype = parts[1]
                    name = parts[2]
                    self.elements[current_elem]["properties"].append((name, dtype))

            if "binary" in self.format:
                self._parse_binary(f)

    def _parse_binary(self, f):
        is_little_endian = "little_endian" in self.format
        endian = "<" if is_little_endian else ">"

        for elem_name, elem_info in self.elements.items():
            self.data[elem_name] = {}
            for name, _ in elem_info["properties"]:
                self.data[elem_name][name] = []

            for _ in range(elem_info["count"]):
                for name, dtype in elem_info["properties"]:
                    if dtype == "double":
                        val = struct.unpack(endian + "d", f.read(8))[0]
                    elif dtype == "float":
                        val = struct.unpack(endian + "f", f.read(4))[0]
                    elif dtype == "uint":
                        val = struct.unpack(endian + "I", f.read(4))[0]
                    elif dtype == "int":
                        val = struct.unpack(endian + "i", f.read(4))[0]
                    elif dtype == "uchar":
                        val = struct.unpack(endian + "B", f.read(1))[0]
                    elif dtype == "char":
                        val = struct.unpack(endian + "b", f.read(1))[0]
                    else:
                        continue
                    self.data[elem_name][name].append(val)


class PLYWriter:
    def __init__(self, path, elements_info, data):
        self.path = path
        self.elements_info = elements_info
        self.data = data

    def write(self, is_binary=True, is_little_endian=True):
        with open(self.path, "wb") as f:
            f.write(b"ply\n")
            format_str = (
                "binary_little_endian"
                if is_binary and is_little_endian
                else "binary_big_endian"
                if is_binary
                else "ascii"
            )
            f.write(f"format {format_str} 1.0\n".encode("utf-8"))

            for elem_name, elem_info in self.elements_info.items():
                first_prop = next(iter(elem_info["properties"]))[0]
                count = len(self.data[elem_name][first_prop])
                f.write(f"element {elem_name} {count}\n".encode("utf-8"))
                for name, dtype in elem_info["properties"]:
                    f.write(f"property {dtype} {name}\n".encode("utf-8"))

            f.write(b"end_header\n")
            if is_binary:
                self._write_binary(f, is_little_endian)

    def _write_binary(self, f, is_little_endian):
        endian = "<" if is_little_endian else ">"

        for elem_name, elem_info in self.elements_info.items():
            first_prop = next(iter(elem_info["properties"]))[0]
            n_items = len(self.data[elem_name][first_prop])

            for i in range(n_items):
                for name, dtype in elem_info["properties"]:
                    val = self.data[elem_name][name][i]
                    if dtype == "double":
                        f.write(struct.pack(endian + "d", float(val)))
                    elif dtype == "float":
                        f.write(struct.pack(endian + "f", float(val)))
                    elif dtype == "uint":
                        f.write(struct.pack(endian + "I", int(val)))
                    elif dtype == "int":
                        f.write(struct.pack(endian + "i", int(val)))
                    elif dtype == "uchar":
                        f.write(struct.pack(endian + "B", int(val)))
                    elif dtype == "char":
                        f.write(struct.pack(endian + "b", int(val)))


def build_camera_lookup(cameras):
    lookup = {}
    for cam in cameras:
        img_name = cam.get("img_name", "")
        if not img_name:
            continue
        stem = os.path.splitext(os.path.basename(img_name))[0].lower()
        lookup[stem] = cam
    return lookup


def match_mask_to_camera(camera_lookup, mask_filename):
    base = os.path.basename(mask_filename).lower()
    for cam_stem, cam_data in camera_lookup.items():
        if cam_stem in base:
            return cam_data
    return None


def main():
    parser = argparse.ArgumentParser(description="Multi-class mask reprojection with conflict resolution.")
    parser.add_argument("--splat", required=True, help="Path to input point_cloud.ply")
    parser.add_argument("--cameras", required=True, help="Path to cameras.json")
    parser.add_argument("--master_dir", required=True, help="Master directory containing subfolders of masks")
    parser.add_argument("--output", required=True, help="Path to save the output PLY file")
    parser.add_argument("--vote_ratio", type=float, default=0.45, help="Percentage of views required (default: 0.45)")
    
    args = parser.parse_args()

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)

    if not os.path.exists(args.splat):
        print(f"Error: Could not find PLY at {args.splat}")
        sys.exit(1)
    if not os.path.exists(args.cameras):
        print(f"Error: Could not find cameras.json at {args.cameras}")
        sys.exit(1)
    if not os.path.isdir(args.master_dir):
        print(f"Error: Could not find master directory at {args.master_dir}")
        sys.exit(1)

    # Detect class subfolders
    class_folders = [d for d in os.listdir(args.master_dir) if os.path.isdir(os.path.join(args.master_dir, d))]
    class_folders.sort() # Sort alphabetically to ensure consistent ID assignment

    if not class_folders:
        print(f"Error: No subfolders found inside {args.master_dir}. Make sure masks are inside class folders.")
        sys.exit(1)

    print("\n" + "=" * 60)
    print("MULTI-CLASS REPROJECTION (CONFLICT RESOLUTION)")
    print(f"Target Voting Ratio: {args.vote_ratio * 100}%")
    print("Detected Classes:")
    for idx, folder in enumerate(class_folders, start=1):
        print(f"  ID {idx}: {folder}")
    print("  ID 0: Background (Default)")
    print("=" * 60 + "\n")

    with open(args.cameras, "r") as f:
        cameras = json.load(f)
    camera_lookup = build_camera_lookup(cameras)

    print(f"Reading 3DGS PLY: {args.splat}...")
    splat = PLYReader(args.splat)
    vertex_data = splat.data["vertex"]
    n_points = len(vertex_data["x"])
    print(f"Loaded {n_points} Gaussians.")

    points_3d = np.vstack([vertex_data["x"], vertex_data["y"], vertex_data["z"]]).T
    
    # Global state trackers for conflict resolution
    final_labels = np.zeros(n_points, dtype=np.uint32)
    highest_vote_ratios = np.zeros(n_points, dtype=np.float32)
    
    class_stats = {}

    for class_id, folder_name in enumerate(class_folders, start=1):
        class_dir = os.path.join(args.master_dir, folder_name)
        
        mask_files = []
        for ext in ["*.png", "*.jpg", "*.jpeg", "*.bmp"]:
            mask_files.extend(glob.glob(os.path.join(class_dir, ext)))
        
        if not mask_files:
            print(f"Warning: No masks found in {folder_name}. Skipping class.")
            continue
            
        print(f"\nProcessing Class [{class_id}/{len(class_folders)}]: '{folder_name}' ({len(mask_files)} masks)")
        
        vote_counts = np.zeros(n_points, dtype=np.uint16)
        views_used = 0

        for view_num, mask_path in enumerate(mask_files, start=1):
            cam = match_mask_to_camera(camera_lookup, mask_path)
            if cam is None:
                continue

            width = cam["width"]
            height = cam["height"]
            fx = cam["fx"]
            fy = cam["fy"]

            sys.stdout.write(f"\r  -> Processing Mask [{view_num}/{len(mask_files)}]")
            sys.stdout.flush()

            mask_cv = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)
            if mask_cv is None:
                continue

            h, w = mask_cv.shape
            if w != width or h != height:
                mask_cv = cv2.resize(mask_cv, (width, height), interpolation=cv2.INTER_NEAREST)
            
            _, boolean_mask = cv2.threshold(mask_cv, 127, 255, cv2.THRESH_BINARY)
            boolean_mask = boolean_mask > 0

            R_c2w = np.array(cam["rotation"])
            R_w2c = R_c2w.T
            C = np.array(cam["position"])

            shifted_points = points_3d - C
            cam_points = np.dot(R_w2c, shifted_points.T)

            z = cam_points[2, :]
            valid_depth = z > 0.01

            z_safe = np.where(z == 0, 1e-6, z)
            u = (cam_points[0, :] / z_safe) * fx + (width / 2.0)
            v = (cam_points[1, :] / z_safe) * fy + (height / 2.0)

            u_int = np.round(u).astype(int)
            v_int = np.round(v).astype(int)

            valid_proj = valid_depth & (u_int >= 0) & (u_int < width) & (v_int >= 0) & (v_int < height)

            in_mask = np.zeros(n_points, dtype=bool)
            valid_indices = np.where(valid_proj)[0]
            if len(valid_indices) > 0:
                mask_hits = boolean_mask[v_int[valid_indices], u_int[valid_indices]]
                in_mask[valid_indices[mask_hits]] = True

            vote_counts += in_mask.astype(np.uint16)
            views_used += 1

        print() # Clear line after progress
        
        if views_used == 0:
            print(f"  -> No valid masks projected for '{folder_name}'.")
            continue

        # Calculate normalized confidence ratios for this class
        point_ratios = vote_counts.astype(np.float32) / views_used
        
        # 1. Did the point pass the minimum threshold for this class?
        passed_threshold = point_ratios >= args.vote_ratio
        
        # 2. Does this class have a higher confidence ratio than the current reigning champion?
        beat_current_best = point_ratios > highest_vote_ratios
        
        # 3. Update the global trackers where BOTH conditions are true
        to_update = passed_threshold & beat_current_best
        
        highest_vote_ratios[to_update] = point_ratios[to_update]
        final_labels[to_update] = class_id
        
        class_stats[folder_name] = np.sum(final_labels == class_id)
        print(f"  -> Assigned {class_stats[folder_name]} points to '{folder_name}' (won conflicts)")

    # Final summary
    print("\n" + "=" * 60)
    print("FINAL SEGMENTATION RESULTS:")
    for folder_name, count in class_stats.items():
        print(f"  - {folder_name}: {count} points")
        
    bg_count = np.sum(final_labels == 0)
    print(f"  - Background: {bg_count} points")
    print("=" * 60 + "\n")

    vertex_data["label"] = final_labels.tolist()

    prop_names = [prop[0] for prop in splat.elements["vertex"]["properties"]]
    if "label" not in prop_names:
        splat.elements["vertex"]["properties"].append(("label", "uint"))

    print(f"Writing multi-labeled 3DGS model to: {args.output}")
    writer = PLYWriter(args.output, splat.elements, splat.data)
    writer.write(is_binary=True, is_little_endian=("little_endian" in splat.format))
    print("✓ Multi-class reprojection complete!")


if __name__ == "__main__":
    import warnings
    warnings.filterwarnings("ignore")
    main()