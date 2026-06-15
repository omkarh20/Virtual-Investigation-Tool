#!/usr/bin/env python3

import struct
import numpy as np
import json
import os
import sys
import cv2

class PLYReader:
    def __init__(self, path):
        self.path = path
        self.format = None
        self.elements = {}
        self.data = {}
        self.parse()
    
    def parse(self):
        with open(self.path, 'rb') as f:
            header_lines = []
            while True:
                line = f.readline().decode('utf-8').strip()
                header_lines.append(line)
                if line == 'end_header':
                    break
            
            current_elem = None
            for line in header_lines:
                if line.startswith('format'):
                    self.format = line.split()[1]
                elif line.startswith('element'):
                    parts = line.split()
                    current_elem = parts[1]
                    count = int(parts[2])
                    self.elements[current_elem] = {'count': count, 'properties': []}
                elif line.startswith('property'):
                    parts = line.split()
                    dtype = parts[1]
                    name = parts[2]
                    self.elements[current_elem]['properties'].append((name, dtype))
            
            if 'binary' in self.format:
                self._parse_binary(f)
    
    def _parse_binary(self, f):
        is_little_endian = 'little_endian' in self.format
        endian = '<' if is_little_endian else '>'
        
        for elem_name, elem_info in self.elements.items():
            self.data[elem_name] = {}
            for name, _ in elem_info['properties']:
                self.data[elem_name][name] = []
            
            for _ in range(elem_info['count']):
                for name, dtype in elem_info['properties']:
                    if dtype == 'double':
                        val = struct.unpack(endian + 'd', f.read(8))[0]
                    elif dtype == 'float':
                        val = struct.unpack(endian + 'f', f.read(4))[0]
                    elif dtype == 'uint':
                        val = struct.unpack(endian + 'I', f.read(4))[0]
                    elif dtype == 'int':
                        val = struct.unpack(endian + 'i', f.read(4))[0]
                    elif dtype == 'uchar':
                        val = struct.unpack(endian + 'B', f.read(1))[0]
                    elif dtype == 'char':
                        val = struct.unpack(endian + 'b', f.read(1))[0]
                    else:
                        continue
                    
                    self.data[elem_name][name].append(val)

class PLYWriter:
    def __init__(self, path, elements_info, data):
        self.path = path
        self.elements_info = elements_info
        self.data = data
    
    def write(self, is_binary=True, is_little_endian=True):
        with open(self.path, 'wb') as f:
            f.write(b'ply\n')
            format_str = 'binary_little_endian' if is_binary and is_little_endian else 'binary_big_endian' if is_binary else 'ascii'
            f.write(f'format {format_str} 1.0\n'.encode('utf-8'))
            
            for elem_name, elem_info in self.elements_info.items():
                first_prop = next(iter(elem_info["properties"]))[0]
                count = len(self.data[elem_name][first_prop])
                f.write(f'element {elem_name} {count}\n'.encode('utf-8'))
                for name, dtype in elem_info['properties']:
                    f.write(f'property {dtype} {name}\n'.encode('utf-8'))
            
            f.write(b'end_header\n')
            
            if is_binary:
                self._write_binary(f, is_little_endian)
    
    def _write_binary(self, f, is_little_endian):
        endian = '<' if is_little_endian else '>'
        
        for elem_name, elem_info in self.elements_info.items():
            first_prop = next(iter(elem_info["properties"]))[0]
            n_items = len(self.data[elem_name][first_prop])
            
            for i in range(n_items):
                for name, dtype in elem_info['properties']:
                    val = self.data[elem_name][name][i]
                    if dtype == 'double':
                        f.write(struct.pack(endian + 'd', float(val)))
                    elif dtype == 'float':
                        f.write(struct.pack(endian + 'f', float(val)))
                    elif dtype == 'uint':
                        f.write(struct.pack(endian + 'I', int(val)))
                    elif dtype == 'int':
                        f.write(struct.pack(endian + 'i', int(val)))
                    elif dtype == 'uchar':
                        f.write(struct.pack(endian + 'B', int(val)))
                    elif dtype == 'char':
                        f.write(struct.pack(endian + 'b', int(val)))

def main():
    # Paths to the exact COLMAP/3DGS data
    splat_path = r'D:\1_Omkar\book2\dense\output\point_cloud\iteration_4000\point_cloud.ply'
    camera_path = r'D:\1_Omkar\book2\dense\output\cameras.json'
    
    output_dir = r'c:\prj-build\supersplat\dev\data'
    output_path = os.path.join(output_dir, 'book_reprojected_multiview.ply')
    
    os.makedirs(output_dir, exist_ok=True)
    
    if not os.path.exists(splat_path):
        print(f"Error: Could not find the 3DGS PLY at {splat_path}")
        return
    if not os.path.exists(camera_path):
        print(f"Error: Could not find the cameras JSON at {camera_path}")
        return
        
    print(f"Reading full 3DGS PLY: {splat_path}...")
    splat = PLYReader(splat_path)
    vertex_data = splat.data['vertex']
    n_points = len(vertex_data['x'])
    print(f"Loaded {n_points} Gaussians.")
    
    print(f"Reading camera configurations...")
    with open(camera_path, 'r') as f:
        cameras = json.load(f)
        
    # Extract point coordinates (N x 3) once
    points_3d = np.vstack([vertex_data['x'], vertex_data['y'], vertex_data['z']]).T
    
    # We will compute the intersection of multiple view masks.
    # Start with all points set to True (1)
    intersection_mask = np.ones(n_points, dtype=bool)
    views_used = 0
    
    print("\n" + "="*60)
    print("MULTI-VIEW REPROJECTION MODE")
    print("You will be shown up to 4 different camera views.")
    print("Draw a box around the object in each view.")
    print("Press 'c' to skip a view if you don't want to use it.")
    print("="*60 + "\n")

    # We want 4 views with a gap of 9 between them to ensure diverse angles (0, 9, 18, 27)
    view_indices = [i * 9 for i in range(4) if (i * 9) < len(cameras)]
    
    for i, idx in enumerate(view_indices):
        cam = cameras[idx]
        width = cam['width']
        height = cam['height']
        fx = cam['fx']
        fy = cam['fy']
        cx = width / 2.0  
        cy = height / 2.0 
        
        print(f"[{i+1}/4] Loading camera: {cam['img_name']}...")
        
        img_dir = r'D:\1_Omkar\book2\dense\images'
        img_path = os.path.join(img_dir, cam['img_name'])
        
        img = cv2.imread(img_path)
        if img is None:
            print(f"Warning: Could not load image {img_path}. Skipping.")
            continue
            
        display_scale = 0.25
        display_img = cv2.resize(img, (0, 0), fx=display_scale, fy=display_scale)
        
        roi = cv2.selectROI(f"View {i+1}/4 - {cam['img_name']} (SPACE to confirm, C to skip)", display_img, showCrosshair=True, fromCenter=False)
        cv2.destroyAllWindows()
        
        if roi == (0, 0, 0, 0):
            print(" -> Skipped.")
            continue
            
        views_used += 1
            
        # Convert ROI coordinates back to original resolution
        box_x_min = roi[0] / display_scale
        box_y_min = roi[1] / display_scale
        box_w = roi[2] / display_scale
        box_h = roi[3] / display_scale
        box_x_max = box_x_min + box_w
        box_y_max = box_y_min + box_h
        
        print(" -> Projecting box and intersecting with 3D model...")
        
        R_c2w = np.array(cam['rotation'])
        R_w2c = R_c2w.T
        C = np.array(cam['position'])
        
        shifted_points = points_3d - C
        cam_points = np.dot(R_w2c, shifted_points.T)
        
        z = cam_points[2, :]
        valid_depth = z > 0.01
        
        z_safe = np.where(z == 0, 1e-6, z)
        u = (cam_points[0, :] / z_safe) * fx + cx
        v = (cam_points[1, :] / z_safe) * fy + cy
        
        in_box_x = (u >= box_x_min) & (u <= box_x_max)
        in_box_y = (v >= box_y_min) & (v <= box_y_max)
        
        in_mask = in_box_x & in_box_y & valid_depth
        
        # LOGICAL AND: A point must be in the box for ALL selected views
        intersection_mask = intersection_mask & in_mask
        
        current_count = np.sum(intersection_mask)
        print(f" -> Points remaining after this intersection: {current_count}")

    if views_used == 0:
        print("\nNo views were selected. Exiting without saving.")
        return
        
    labels = np.zeros(n_points, dtype=np.uint32)
    labels[intersection_mask] = 1
    
    final_count = np.sum(labels)
    print(f"\nFinal labeled points: {final_count} (Intersection of {views_used} views)")
    
    vertex_data['label'] = labels.tolist()
    
    prop_names = [prop[0] for prop in splat.elements['vertex']['properties']]
    if 'label' not in prop_names:
        splat.elements['vertex']['properties'].append(('label', 'uint'))
    
    print(f"Writing annotated multi-view 3DGS model to {output_path}...")
    writer = PLYWriter(output_path, splat.elements, splat.data)
    writer.write(is_binary=True, is_little_endian=('little_endian' in splat.format))
    print("✓ Multi-view reprojection complete!")

if __name__ == '__main__':
    main()
