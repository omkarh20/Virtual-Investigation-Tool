#!/usr/bin/env python3
"""
Multi-Mask Reprojection (Single Class).
Projects multiple 2D masks into 3D Gaussians and labels/recolors them 
using a voting algorithm (requires X% of views to see the gaussian).
"""

import argparse
import json
import os
import struct
import sys

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
    parser = argparse.ArgumentParser(description="Multi-mask reprojection (voting algorithm).")
    parser.add_argument("--splat", required=True, help="Path to input point_cloud.ply")
    parser.add_argument("--cameras", required=True, help="Path to cameras.json")
    parser.add_argument("--masks", nargs='+', required=True, help="Paths to the mask images")
    parser.add_argument("--vote_ratio", type=float, default=0.45, help="Percentage of views required to label (default: 0.45)")
    parser.add_argument("--output", required=True, help="Path to save the output PLY file")
    parser.add_argument("--recolor", action="store_true", help="Recolor labelled gaussians to red for visual verification")
    
    args = parser.parse_args()

    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)

    if not os.path.exists(args.splat):
        print(f"Error: Could not find PLY at {args.splat}")
        sys.exit(1)
    if not os.path.exists(args.cameras):
        print(f"Error: Could not find cameras.json at {args.cameras}")
        sys.exit(1)

    with open(args.cameras, "r") as f:
        cameras = json.load(f)

    camera_lookup = build_camera_lookup(cameras)

    print(f"Reading 3DGS PLY: {args.splat}...")
    splat = PLYReader(args.splat)
    vertex_data = splat.data["vertex"]
    n_points = len(vertex_data["x"])
    print(f"Loaded {n_points} Gaussians.")

    points_3d = np.vstack([vertex_data["x"], vertex_data["y"], vertex_data["z"]]).T

    vote_counts = np.zeros(n_points, dtype=np.uint16)
    views_used = 0

    print(f"\nProcessing {len(args.masks)} masks...")
    
    for view_num, mask_path in enumerate(args.masks, start=1):
        if not os.path.exists(mask_path):
            print(f"  [{view_num}/{len(args.masks)}] Skipping missing mask: {mask_path}")
            continue

        cam = match_mask_to_camera(camera_lookup, mask_path)
        if cam is None:
            print(f"  [{view_num}/{len(args.masks)}] Skipping {mask_path} - no matching camera found.")
            continue

        mask_cv = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)
        if mask_cv is None:
            print(f"  [{view_num}/{len(args.masks)}] Error reading mask: {mask_path}")
            continue

        width = cam["width"]
        height = cam["height"]
        fx = cam["fx"]
        fy = cam["fy"]

        h, w = mask_cv.shape
        if (h > w and width > height) or (w > h and height > width):
            mask_cv = cv2.rotate(mask_cv, cv2.ROTATE_90_COUNTERCLOCKWISE)
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

        hits_this_mask = np.sum(in_mask)
        print(f"  [{view_num}/{len(args.masks)}] Projected {mask_path} (Matches: {hits_this_mask})")

        vote_counts += in_mask.astype(np.uint16)
        views_used += 1

    if views_used == 0:
        print("\nError: No valid masks projected successfully.")
        sys.exit(1)

    print("\nCalculating voting results...")
    point_ratios = vote_counts.astype(np.float32) / views_used
    passed_threshold = point_ratios >= args.vote_ratio
    
    hits_count = np.sum(passed_threshold)
    print(f"Gaussians passing >= {args.vote_ratio*100}% threshold: {hits_count}")

    # Set label property
    prop_names = [prop[0] for prop in splat.elements["vertex"]["properties"]]
    if "label" not in prop_names:
        splat.elements["vertex"]["properties"].append(("label", "uint"))
        vertex_data["label"] = [0] * n_points
    
    # Apply label 1 to matched gaussians
    for i in np.where(passed_threshold)[0]:
        vertex_data["label"][i] = 1

    # Recolor if requested
    if args.recolor:
        # Pure red DC: 1.772, -1.772, -1.772
        for i in np.where(passed_threshold)[0]:
            if "f_dc_0" in vertex_data: vertex_data["f_dc_0"][i] = 1.772
            if "f_dc_1" in vertex_data: vertex_data["f_dc_1"][i] = -1.772
            if "f_dc_2" in vertex_data: vertex_data["f_dc_2"][i] = -1.772
            
            # Zero out rest SH
            for r in range(45):
                rest_name = f"f_rest_{r}"
                if rest_name in vertex_data:
                    vertex_data[rest_name][i] = 0.0
        print("Recolored labelled gaussians to pure red.")

    print(f"Writing resulting PLY to: {args.output}")
    writer = PLYWriter(args.output, splat.elements, splat.data)
    writer.write(is_binary=True, is_little_endian=("little_endian" in splat.format))
    print("✓ Reprojection complete!")


if __name__ == "__main__":
    import warnings
    warnings.filterwarnings("ignore")
    main()
