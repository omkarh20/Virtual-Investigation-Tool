import os
import sys
import json
import struct
import shutil
import math
import numpy as np
import cv2
import torch
import open3d as o3d
import plyfile
from ultralytics import YOLO

# Suppress harmless model registry overwrite warnings from segment_anything_hq
import warnings
warnings.filterwarnings("ignore", category=UserWarning, module="segment_anything_hq")

from segment_anything_hq import sam_model_registry, SamPredictor

# Set random seed
np.random.seed(42)

class PLYReader:
    def __init__(self, path):
        self.path = path
        self.format = ""
        self.elements = {}
        self.data = {}
        self.parse()

    def parse(self):
        from plyfile import PlyData
        plydata = PlyData.read(self.path)
        
        if plydata.text:
            self.format = "ascii"
        else:
            self.format = "binary_little_endian" if plydata.byte_order == '<' else "binary_big_endian"
        for elem in plydata.elements:
            self.elements[elem.name] = {
                "count": elem.count,
                "properties": [(prop.name, prop.val_dtype) for prop in elem.properties]
            }
            
        for elem_name, elem_info in self.elements.items():
            self.data[elem_name] = {}
            
        vertex = plydata['vertex']
        
        if 'packed_position' in vertex.data.dtype.names:
            print("[*] PLYReader: Detected compressed 3DGS PLY format. Unpacking...")
            packed_positions = np.array(vertex['packed_position'])
            
            chunk = plydata['chunk']
            chunk_min_x = np.array(chunk['min_x'])
            chunk_max_x = np.array(chunk['max_x'])
            chunk_min_y = np.array(chunk['min_y'])
            chunk_max_y = np.array(chunk['max_y'])
            chunk_min_z = np.array(chunk['min_z'])
            chunk_max_z = np.array(chunk['max_z'])
            
            chunk_idx = np.clip(np.arange(len(packed_positions)) // 256, 0, len(chunk_min_x) - 1)
            
            min_x = chunk_min_x[chunk_idx]
            max_x = chunk_max_x[chunk_idx]
            min_y = chunk_min_y[chunk_idx]
            max_y = chunk_max_y[chunk_idx]
            min_z = chunk_min_z[chunk_idx]
            max_z = chunk_max_z[chunk_idx]
            
            x_norm = (packed_positions >> 21) & 0x7FF
            y_norm = (packed_positions >> 11) & 0x3FF
            z_norm = packed_positions & 0x7FF
            
            x = x_norm / 2047.0 * (max_x - min_x) + min_x
            y = y_norm / 1023.0 * (max_y - min_y) + min_y
            z = z_norm / 2047.0 * (max_z - min_z) + min_z
            
            self.data['vertex']['x'] = x
            self.data['vertex']['y'] = y
            self.data['vertex']['z'] = z
            
            if 'packed_color' in vertex.data.dtype.names:
                packed_colors = np.array(vertex['packed_color'])
                opacity = (packed_colors & 0xFF) / 255.0
                self.data['vertex']['opacity'] = opacity
                
                SH_C0 = 0.28209479177387814
                r_norm = (packed_colors >> 24) & 0xFF
                g_norm = (packed_colors >> 16) & 0xFF
                b_norm = (packed_colors >> 8) & 0xFF
                
                self.data['vertex']['f_dc_0'] = (r_norm / 255.0 - 0.5) / SH_C0
                self.data['vertex']['f_dc_1'] = (g_norm / 255.0 - 0.5) / SH_C0
                self.data['vertex']['f_dc_2'] = (b_norm / 255.0 - 0.5) / SH_C0

            if 'packed_scale' in vertex.data.dtype.names:
                packed_scales = np.array(vertex['packed_scale'])
                chunk_min_sx = np.array(chunk['min_scale_x'])
                chunk_max_sx = np.array(chunk['max_scale_x'])
                chunk_min_sy = np.array(chunk['min_scale_y'])
                chunk_max_sy = np.array(chunk['max_scale_y'])
                chunk_min_sz = np.array(chunk['min_scale_z'])
                chunk_max_sz = np.array(chunk['max_scale_z'])
                
                min_sx = chunk_min_sx[chunk_idx]
                max_sx = chunk_max_sx[chunk_idx]
                min_sy = chunk_min_sy[chunk_idx]
                max_sy = chunk_max_sy[chunk_idx]
                min_sz = chunk_min_sz[chunk_idx]
                max_sz = chunk_max_sz[chunk_idx]
                
                sx_norm = (packed_scales >> 21) & 0x7FF
                sy_norm = (packed_scales >> 11) & 0x3FF
                sz_norm = packed_scales & 0x7FF
                
                scale_0 = sx_norm / 2047.0 * (max_sx - min_sx) + min_sx
                scale_1 = sy_norm / 1023.0 * (max_sy - min_sy) + min_sy
                scale_2 = sz_norm / 2047.0 * (max_sz - min_sz) + min_sz
                
                self.data['vertex']['scale_0'] = scale_0
                self.data['vertex']['scale_1'] = scale_1
                self.data['vertex']['scale_2'] = scale_2

            if 'packed_rotation' in vertex.data.dtype.names:
                packed_rotations = np.array(vertex['packed_rotation'])
                largest = (packed_rotations >> 30) & 0x3
                val1 = (packed_rotations >> 20) & 0x3FF
                val2 = (packed_rotations >> 10) & 0x3FF
                val3 = packed_rotations & 0x3FF
                
                norm_factor = np.sqrt(2.0)
                v1 = (val1 / 1023.0 - 0.5) * norm_factor
                v2 = (val2 / 1023.0 - 0.5) * norm_factor
                v3 = (val3 / 1023.0 - 0.5) * norm_factor
                
                sum_sq = v1*v1 + v2*v2 + v3*v3
                v_largest = np.sqrt(np.maximum(0.0, 1.0 - sum_sq))
                
                w = np.zeros(len(packed_rotations), dtype=np.float32)
                x = np.zeros(len(packed_rotations), dtype=np.float32)
                y = np.zeros(len(packed_rotations), dtype=np.float32)
                z = np.zeros(len(packed_rotations), dtype=np.float32)
                
                for idx_largest in range(4):
                    mask = (largest == idx_largest)
                    if not np.any(mask):
                        continue
                    if idx_largest == 0:
                        w[mask] = v_largest[mask]
                        x[mask] = v1[mask]
                        y[mask] = v2[mask]
                        z[mask] = v3[mask]
                    elif idx_largest == 1:
                        w[mask] = v1[mask]
                        x[mask] = v_largest[mask]
                        y[mask] = v2[mask]
                        z[mask] = v3[mask]
                    elif idx_largest == 2:
                        w[mask] = v1[mask]
                        x[mask] = v2[mask]
                        y[mask] = v_largest[mask]
                        z[mask] = v3[mask]
                    elif idx_largest == 3:
                        w[mask] = v1[mask]
                        x[mask] = v2[mask]
                        y[mask] = v3[mask]
                        z[mask] = v_largest[mask]
                
                self.data['vertex']['rot_0'] = w
                self.data['vertex']['rot_1'] = x
                self.data['vertex']['rot_2'] = y
                self.data['vertex']['rot_3'] = z
        else:
            # Uncompressed format: copy properties
            for prop_name, _ in self.elements['vertex']['properties']:
                self.data['vertex'][prop_name] = np.array(vertex[prop_name])
                
            for elem_name, elem_info in self.elements.items():
                if elem_name == 'vertex':
                    continue
                elem_data = plydata[elem_name]
                for prop_name, _ in elem_info['properties']:
                    self.data[elem_name][prop_name] = np.array(elem_data[prop_name])


def extract_mesh(ply_path, output_mesh_path, opacity_threshold=0.5, depth=9, method="poisson", alpha_value=0.15):
    """
    Phase 1: Filter point cloud by opacity, calculate/estimate normals, 
    and construct mesh using either Poisson Surface Reconstruction or Alpha Shapes.
    """
    print(f"[*] Reading PLY data: {ply_path}")
    ply = PLYReader(ply_path)
    vertex_data = ply.data["vertex"]
    
    # Extract positions
    points = np.vstack([vertex_data["x"], vertex_data["y"], vertex_data["z"]]).T
    
    # Opacity check
    opacity = None
    for k in ["opacity", "inv_sigmoid_opacity", "o"]:
        if k in vertex_data:
            opacity = np.array(vertex_data[k])
            break
            
    if opacity is not None:
        if opacity.min() < 0 or opacity.max() > 1:
            opacity = 1.0 / (1.0 + np.exp(-opacity)) # Sigmoid activation
        mask = opacity > opacity_threshold
        points = points[mask]
        print(f"[*] Filtered out low opacity points (threshold={opacity_threshold}). Retained {len(points)}/{len(vertex_data['x'])} points.")
    else:
        print("[!] Warning: Opacity attribute not found. Processing all points.")
        mask = np.ones(len(points), dtype=bool)
        
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(points)
    
    # Check if scales and rotations are available to compute covariance-based oriented normals
    has_cov_properties = all(k in vertex_data for k in ["scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"])
    
    if has_cov_properties:
        print("[*] Calculating normals from Gaussian scales and rotations...")
        s0 = np.array(vertex_data["scale_0"])[mask]
        s1 = np.array(vertex_data["scale_1"])[mask]
        s2 = np.array(vertex_data["scale_2"])[mask]
        
        w = np.array(vertex_data["rot_0"])[mask]
        x = np.array(vertex_data["rot_1"])[mask]
        y = np.array(vertex_data["rot_2"])[mask]
        z = np.array(vertex_data["rot_3"])[mask]
        
        # Normalize quaternions
        q_len = np.sqrt(w*w + x*x + y*y + z*z) + 1e-8
        w, x, y, z = w / q_len, x / q_len, y / q_len, z / q_len
        
        # Calculate rotation columns
        r0 = np.vstack([
            1.0 - 2.0 * (y**2 + z**2),
            2.0 * (x * y + w * z),
            2.0 * (x * z - w * y)
        ]).T
        
        r1 = np.vstack([
            2.0 * (x * y - w * z),
            1.0 - 2.0 * (x**2 + z**2),
            2.0 * (y * z + w * x)
        ]).T
        
        r2 = np.vstack([
            2.0 * (x * z + w * y),
            2.0 * (y * z - w * x),
            1.0 - 2.0 * (x**2 + y**2)
        ]).T
        
        # Shortest scaling axis index (minimum log-scale corresponds to minimum scale)
        scales = np.vstack([s0, s1, s2]).T
        min_scale_idx = np.argmin(scales, axis=1)
        
        normals = np.zeros_like(points)
        m0 = (min_scale_idx == 0)
        m1 = (min_scale_idx == 1)
        m2 = (min_scale_idx == 2)
        
        normals[m0] = r0[m0]
        normals[m1] = r1[m1]
        normals[m2] = r2[m2]
        
        # Orient normals towards the centroid of the points
        centroid = np.mean(points, axis=0)
        to_center = centroid - points
        to_center_len = np.linalg.norm(to_center, axis=1, keepdims=True) + 1e-8
        to_center_norm = to_center / to_center_len
        
        dot_prod = np.sum(normals * to_center_norm, axis=1)
        normals[dot_prod < 0] = -normals[dot_prod < 0]
        
        pcd.normals = o3d.utility.Vector3dVector(normals)
    else:
        # Fallback to spatial normal estimation
        print("[*] Estimating normals using KDTree spatial neighbors...")
        pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.1, max_nn=30))
        pcd.orient_normals_consistent_tangent_plane(k=15)
        
    print("[*] Downsampling Point Cloud...")
    pcd = pcd.voxel_down_sample(voxel_size=0.015)
    print(f"[*] Voxel downsampled to {len(pcd.points)} points.")
    
    os.makedirs(os.path.dirname(os.path.abspath(output_mesh_path)), exist_ok=True)
    
    if method == "alpha_shape":
        print(f"[*] Running Alpha Shape reconstruction (alpha={alpha_value})...")
        mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_alpha_shape(pcd, alpha_value)
    else:
        # Default: Screened Poisson Surface Reconstruction
        print(f"[*] Running Screened Poisson Surface Reconstruction (depth={depth})...")
        mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(pcd, depth=depth)
        
        print("[*] Filtering out low-density boundary noise...")
        densities = np.asarray(densities)
        density_threshold = np.percentile(densities, 4)
        vertices_to_remove = densities < density_threshold
        mesh.remove_vertices_by_mask(vertices_to_remove)
        
    # Simplify the mesh for rendering and physics performance
    target_triangles = 100000
    if len(mesh.triangles) > target_triangles:
        print(f"[*] Simplifying mesh from {len(mesh.triangles)} to {target_triangles} triangles for performance...")
        mesh = mesh.simplify_quadric_decimation(target_number_of_triangles=target_triangles)
        
    o3d.io.write_triangle_mesh(output_mesh_path, mesh)
    print(f"[+] Reconstructed Mesh saved successfully: {output_mesh_path}")
    return output_mesh_path

def generate_virtual_cameras(bbox_min, bbox_max, center, num_cameras=30):
    """
    Generates a trajectory of camera poses around a target bounding box using a spiral/sphere path.
    """
    extents = bbox_max - bbox_min
    radius = np.linalg.norm(extents) * 0.95
    
    cameras = []
    for i in range(num_cameras):
        # Fibonacci Sphere coordinates
        phi = math.acos(1 - 2 * (i + 0.5) / num_cameras)
        theta = math.pi * (1 + 5**0.5) * i
        
        x = center[0] + radius * math.sin(phi) * math.cos(theta)
        y = center[1] + radius * math.sin(phi) * math.sin(theta)
        z = center[2] + radius * math.cos(phi)
        
        pos = np.array([x, y, z])
        
        # Calculate rotation matrix pointing to the center
        forward = center - pos
        forward = forward / np.linalg.norm(forward)
        
        # Temp up vector
        temp_up = np.array([0.0, 1.0, 0.0])
        if abs(forward[1]) > 0.99:
            temp_up = np.array([0.0, 0.0, 1.0])
            
        right = np.cross(temp_up, forward)
        right = right / np.linalg.norm(right)
        up = np.cross(forward, right)
        
        # Camera-to-world rotation matrix (OpenCV system: right, down, forward)
        # Note: we negate up/down to point camera down
        R = np.vstack([right, -up, forward]).T
        
        cameras.append({
            "id": i,
            "position": pos.tolist(),
            "rotation": R.tolist()
        })
    return cameras

def render_scene_view(points, colors, cameras, output_dir, width=800, height=600):
    """
    Phase 2: Renders synthetic RGB views and depth maps using fast point cloud rasterization.
    """
    os.makedirs(output_dir, exist_ok=True)
    images_dir = os.path.join(output_dir, "rgb")
    depths_dir = os.path.join(output_dir, "depth")
    os.makedirs(images_dir, exist_ok=True)
    os.makedirs(depths_dir, exist_ok=True)
    
    # Load default camera parameters
    fov_rad = (60 * math.pi) / 180
    fy = (height / 2.0) / math.tan(fov_rad / 2.0)
    fx = fy
    
    print(f"[*] Rendering {len(cameras)} synthetic views at {width}x{height}...")
    
    # Filter points to a manageable count for fast CPU drawing if too high
    if len(points) > 150000:
        indices = np.random.choice(len(points), 150000, replace=False)
        render_pts = points[indices]
        render_cols = colors[indices]
    else:
        render_pts = points
        render_cols = colors

    camera_metadata = []
    
    for i, cam in enumerate(cameras):
        pos = np.array(cam["position"])
        R_c2w = np.array(cam["rotation"])
        R_w2c = R_c2w.T
        
        # Transform points to camera coordinates
        shifted = render_pts - pos
        cam_pts = np.dot(R_w2c, shifted.T) # shape (3, N)
        
        z = cam_pts[2, :]
        valid = z > 0.05
        
        # Camera projection
        z_valid = z[valid]
        z_safe = np.where(z_valid == 0, 1e-6, z_valid)
        u = (cam_pts[0, valid] / z_safe) * fx + (width / 2.0)
        v = (cam_pts[1, valid] / z_safe) * fy + (height / 2.0)
        cols = render_cols[valid]
        
        in_bounds = (u >= 0) & (u < width) & (v >= 0) & (v < height)
        u = u[in_bounds].astype(np.int32)
        v = v[in_bounds].astype(np.int32)
        z_val = z_valid[in_bounds]
        cols_val = cols[in_bounds]
        
        # Initialize background buffers
        rgb_img = np.ones((height, width, 3), dtype=np.uint8) * 245
        depth_img = np.ones((height, width), dtype=np.float32) * 1e5
        
        # Back-to-front sorting
        sort_idx = np.argsort(z_val)[::-1]
        
        # Dynamic circle radius based on depth
        for idx in sort_idx:
            pt_u, pt_v, pt_z = u[idx], v[idx], z_val[idx]
            color = cols_val[idx]
            
            # Radii decrease with distance
            radius = max(1, int(1.8 / pt_z))
            
            cv2.circle(rgb_img, (pt_u, pt_v), radius, color.tolist(), -1)
            cv2.circle(depth_img, (pt_u, pt_v), radius, float(pt_z), -1)
            
        depth_img[depth_img > 1e4] = 0.0
        
        # Save RGB
        img_name = f"view_{i:04d}.png"
        cv2.imwrite(os.path.join(images_dir, img_name), rgb_img)
        
        # Save Depth (as 16-bit millimeter PNG or float .npy)
        depth_mm = (depth_img * 1000.0).astype(np.uint16)
        cv2.imwrite(os.path.join(depths_dir, f"view_{i:04d}_depth.png"), depth_mm)
        
        camera_metadata.append({
            "id": i,
            "img_name": img_name,
            "width": width,
            "height": height,
            "position": pos.tolist(),
            "rotation": R_c2w.tolist(),
            "fx": float(fx),
            "fy": float(fy)
        })
        
    # Write metadata cameras.json
    metadata_path = os.path.join(output_dir, "cameras.json")
    with open(metadata_path, "w") as f:
        json.dump(camera_metadata, f, indent=2)
        
    print(f"[+] Render complete. Views saved to {output_dir}")
    return images_dir, depths_dir, metadata_path

def segment_and_project(ply_path, rgb_dir, depths_dir, cameras_json, output_dir, query_labels=None):
    """
    Phases 3 & 4: segment 2D renders, backproject pixels to 3D, isolate Gaussians, and generate meshes.
    """
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[*] Starting 2D-to-3D projection pipeline on {device}")
    
    # 1. Load YOLO + SAM HQ models
    print("[*] Loading segmentation models...")
    yolo_pt = os.path.join(os.path.dirname(__file__), "..", "..", "dev", "checkpoints", "yoloe-26x-seg-pf.pt")
    sam_pth = os.path.join(os.path.dirname(__file__), "..", "..", "dev", "checkpoints", "sam_hq_vit_h.pth")
    
    if not os.path.exists(yolo_pt) or not os.path.exists(sam_pth):
        # Graceful fallback to default coco segmentation model
        print("[!] Warnings: Checkpoints not found in dev/checkpoints. Using default YOLOv8x-seg model...")
        yolo_model = YOLO("yolov8x-seg.pt")
        predictor = None
    else:
        yolo_model = YOLO(yolo_pt)
        sam = sam_model_registry["vit_h"](checkpoint=sam_pth).to(device)
        predictor = SamPredictor(sam)

    # Load cameras metadata
    with open(cameras_json, "r") as f:
        cameras = json.load(f)
        
    # Load original point cloud
    print("[*] Loading master point cloud for labeling...")
    ply = PLYReader(ply_path)
    vertex_data = ply.data["vertex"]
    points_3d = np.vstack([vertex_data["x"], vertex_data["y"], vertex_data["z"]]).T
    n_points = len(points_3d)
    
    # Set default labels
    final_labels = {} # object_name -> boolean array
    
    image_files = sorted([f for f in os.listdir(rgb_dir) if f.endswith(".png")])
    
    print("[*] Segmenting and backprojecting views...")
    for idx, img_file in enumerate(image_files):
        img_path = os.path.join(rgb_dir, img_file)
        depth_path = os.path.join(depths_dir, img_file.replace(".png", "_depth.png"))
        
        if not os.path.exists(depth_path):
            continue
            
        img = cv2.imread(img_path)
        depth_mm = cv2.imread(depth_path, cv2.IMREAD_UNCHANGED)
        
        if img is None or depth_mm is None:
            continue
            
        depth_map = depth_mm.astype(np.float32) / 1000.0 # back to meters
        h, w, _ = img.shape
        cam = cameras[idx]
        fx, fy = cam["fx"], cam["fy"]
        C = np.array(cam["position"])
        R_c2w = np.array(cam["rotation"])
        R_w2c = R_c2w.T
        
        # Run YOLO detection
        results = yolo_model.predict(img, verbose=False, device=device)
        res = results[0]
        
        if res.boxes is None or len(res.boxes) == 0:
            continue
            
        raw_boxes = res.boxes.xyxy
        if hasattr(raw_boxes, "cpu"):
            boxes = raw_boxes.cpu().numpy()
        else:
            boxes = np.array(raw_boxes)
            
        raw_classes = res.boxes.cls
        if hasattr(raw_classes, "cpu"):
            classes = raw_classes.cpu().numpy()
        else:
            classes = np.array(raw_classes)
            
        names = res.names
        
        # Load image into SAM
        if predictor is not None:
            predictor.set_image(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
            
        for i, box in enumerate(boxes):
            label = names[int(classes[i])]
            if query_labels and label not in query_labels:
                continue
                
            clean_label = "".join(x for x in label if x.isalnum()).lower()
            
            # Obtain high quality mask
            if predictor is not None:
                masks, _, _ = predictor.predict(box=box[None, :], multimask_output=False)
                mask = masks[0]
            else:
                # Fallback to YOLO polygon mask
                if res.masks is not None:
                    mask = res.masks.data[i].cpu().numpy()
                    mask = cv2.resize(mask, (w, h), interpolation=cv2.INTER_NEAREST) > 0.5
                else:
                    # Bbox mask fallback
                    mask = np.zeros((h, w), dtype=bool)
                    bx1, by1, bx2, by2 = map(int, box)
                    mask[by1:by2, bx1:bx2] = True
                    
            if clean_label not in final_labels:
                final_labels[clean_label] = np.zeros(n_points, dtype=np.uint16)
                
            # Backproject the mask pixels
            # Instead of projection for every single pixel (slow), we project the 3D points
            # to check if they land on this 2D mask. This is 100x faster!
            shifted = points_3d - C
            cam_pts = np.dot(R_w2c, shifted.T)
            z = cam_pts[2, :]
            
            # Keep valid depths
            valid_depth = z > 0.05
            z_safe = np.where(z == 0, 1e-6, z)
            u_proj = np.round((cam_pts[0, :] / z_safe) * fx + w / 2.0).astype(np.int32)
            v_proj = np.round((cam_pts[1, :] / z_safe) * fy + h / 2.0).astype(np.int32)
            
            valid_proj = valid_depth & (u_proj >= 0) & (u_proj < w) & (v_proj >= 0) & (v_proj < h)
            
            # Check depth values to make sure the point isn't hidden behind an object (occlusion query)
            # A tolerance of 8cm prevents filtering points due to raster quantization
            if len(valid_proj) > 0:
                depth_check = np.asarray(depth_map[v_proj[valid_proj], u_proj[valid_proj]]).flatten()
                in_mask = np.asarray(mask[v_proj[valid_proj], u_proj[valid_proj]]).flatten()
                z_val = np.asarray(z[valid_proj]).flatten()
                occlusion = np.abs(z_val - depth_check) < 0.08
                
                valid_indices = np.where(valid_proj)[0]
                final_labels[clean_label][valid_indices[in_mask & occlusion]] += 1
                
    # Isolate splats based on voting threshold (e.g. at least 2 views saw it)
    print("[*] Isolating 3D Gaussian segments...")
    os.makedirs(output_dir, exist_ok=True)
    
    # Store elements definition
    orig_ply = plyfile.PlyData.read(ply_path)
    vertex_el = orig_ply['vertex']
    
    isolated_files = {}
    
    for obj_name, votes in final_labels.items():
        pass_votes = votes >= 2 # Point must be seen in at least 2 views
        if np.sum(pass_votes) < 100:
            print(f"[!] Object '{obj_name}' has too few points ({np.sum(pass_votes)}). Skipping.")
            continue
            
        print(f"[+] Isolating '{obj_name}' with {np.sum(pass_votes)} points...")
        
        # Read the points and filter
        obj_data = vertex_el.data[pass_votes]
        
        # Save as isolated .ply
        obj_ply_name = f"{obj_name}.ply"
        obj_ply_path = os.path.join(output_dir, obj_ply_name)
        
        # Re-describe PLY element
        el = plyfile.PlyElement.describe(obj_data, 'vertex')
        plyfile.PlyData([el], text=False).write(obj_ply_path)
        
        # Now run Phase 4: Mesh reconstruction for the isolated object
        obj_mesh_path = os.path.join(output_dir, f"{obj_name}_mesh.obj")
        print(f"[*] Reconstructing mesh for isolated object: '{obj_name}'")
        try:
            extract_mesh(obj_ply_path, obj_mesh_path, opacity_threshold=0.3, depth=8)
            isolated_files[obj_name] = {
                "ply": obj_ply_path,
                "mesh": obj_mesh_path
            }
        except Exception as e:
            print(f"[!] Reconstruction failed for '{obj_name}': {e}")
            
    return isolated_files

def run_unsegmented_mesh_pipeline(ply_path, output_dir, query_labels=None):
    """
    Executes the entire end-to-end pipeline:
    1. Extract global mesh.
    2. Render virtual views and depth maps.
    3. Segment views, project to 3D, and isolate segments.
    """
    print("="*60)
    print("     VIT END-TO-END POINT CLOUD MESHER & SEGMENTATION PIPELINE")
    print("="*60)
    
    # Phase 1: Extract master mesh
    master_mesh_path = os.path.join(output_dir, "master_scene_mesh.obj")
    extract_mesh(ply_path, master_mesh_path, opacity_threshold=0.45, depth=9)
    
    # Load PLY reader to calculate bounding box
    print("[*] Calculating Point Cloud bounds for virtual cameras...")
    ply = PLYReader(ply_path)
    vx = np.array(ply.data["vertex"]["x"])
    vy = np.array(ply.data["vertex"]["y"])
    vz = np.array(ply.data["vertex"]["z"])
    
    bbox_min = np.array([vx.min(), vy.min(), vz.min()])
    bbox_max = np.array([vx.max(), vy.max(), vz.max()])
    center = (bbox_min + bbox_max) / 2.0
    print(f"[*] Bounds: min={bbox_min}, max={bbox_max}, center={center}")
    
    # Phase 2: Virtual view generation
    temp_render_dir = os.path.join(output_dir, "temp_renders")
    cameras = generate_virtual_cameras(bbox_min, bbox_max, center, num_cameras=30)
    
    colors = None
    # DC Spherical Harmonics to RGB
    SH_C0 = 0.28209479177387814
    if "f_dc_0" in ply.data["vertex"]:
        r = 0.5 + SH_C0 * np.array(ply.data["vertex"]["f_dc_0"])
        g = 0.5 + SH_C0 * np.array(ply.data["vertex"]["f_dc_1"])
        b = 0.5 + SH_C0 * np.array(ply.data["vertex"]["f_dc_2"])
        colors = np.vstack([r, g, b]).T
        colors = np.clip(colors, 0.0, 1.0) * 255
    elif "red" in ply.data["vertex"]:
        r = np.array(ply.data["vertex"]["red"])
        g = np.array(ply.data["vertex"]["green"])
        b = np.array(ply.data["vertex"]["blue"])
        colors = np.vstack([r, g, b]).T
    else:
        colors = np.ones((len(vx), 3), dtype=np.uint8) * 128
        
    points = np.vstack([vx, vy, vz]).T
    
    rgb_dir, depths_dir, cams_json = render_scene_view(points, colors, cameras, temp_render_dir)
    
    # Phase 3 & 4: 2D-to-3D projection & meshing
    segments_output_dir = os.path.join(output_dir, "segments")
    isolated_objects = segment_and_project(
        ply_path=ply_path,
        rgb_dir=rgb_dir,
        depths_dir=depths_dir,
        cameras_json=cams_json,
        output_dir=segments_output_dir,
        query_labels=query_labels
    )
    
    # Clean up temporary renders
    print("[*] Cleaning up temporary render directories...")
    shutil.rmtree(temp_render_dir, ignore_errors=True)
    
    print("\n" + "="*60)
    print(" PIPELINE EXECUTION COMPLETE!")
    print(f" Master Scene Mesh: {master_mesh_path}")
    print(" Isolated Segmented Objects:")
    for name, paths in isolated_objects.items():
        print(f"  - {name}:")
        print(f"      PLY:  {paths['ply']}")
        print(f"      Mesh: {paths['mesh']}")
    print("="*60)
    
    return {
        "master_mesh": master_mesh_path,
        "objects": isolated_objects
    }

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python mesh_pipeline.py <input_splat.ply> <output_directory> [comma_separated_target_classes]")
        sys.exit(1)
        
    input_ply = sys.argv[1]
    out_dir = sys.argv[2]
    targets = None
    if len(sys.argv) > 3:
        targets = [t.strip().lower() for t in sys.argv[3].split(",")]
        
    run_unsegmented_mesh_pipeline(input_ply, out_dir, targets)

async def run_mesh_segmentation_pipeline(job_id: str, job_dir: str, config: dict, push_ws):
    import asyncio
    import glob
    import trimesh
    
    step_id = 5
    await push_ws({"type": "log", "step": step_id, "progress": 5, "text": "Starting Mesh Extraction & Segmentation Pipeline..."})
    
    # Locate the trained .ply file from Phase 4
    ply_files = glob.glob(os.path.join(job_dir, "3dgs", "point_cloud", "iteration_*", "point_cloud.ply"))
    if not ply_files:
        # Check if they uploaded an input .ply
        filename = config.get("filename", "")
        ply_path = os.path.join(job_dir, "input", filename)
        if not os.path.exists(ply_path) or not ply_path.endswith(".ply"):
            # Fallback to any input .ply in input/
            input_plies = glob.glob(os.path.join(job_dir, "input", "*.ply"))
            if input_plies:
                ply_path = input_plies[0]
            else:
                error_msg = "⚠️ No trained 3DGS point cloud (.ply) or input .ply found. Did you run Phase 4 successfully?"
                await push_ws({"type": "log", "step": step_id, "progress": 100, "text": error_msg})
                raise FileNotFoundError(error_msg)
    else:
        # Get the latest iteration
        ply_files.sort(key=os.path.getmtime, reverse=True)
        ply_path = ply_files[0]
        
    output_dir = os.path.join(job_dir, "mesh-pipeline-assets")
    os.makedirs(output_dir, exist_ok=True)
    
    await push_ws({"type": "log", "step": step_id, "progress": 10, "text": f"Found target point cloud: {ply_path}"})
    
    loop = asyncio.get_running_loop()
    
    def run_wrapper():
        def log_prog(pct, txt):
            asyncio.run_coroutine_threadsafe(
                push_ws({"type": "log", "step": step_id, "progress": pct, "text": txt}),
                loop
            )
        
        log_prog(15, "Phase 1: Full-Scene Mesh Extraction...")
        master_mesh_path = os.path.join(output_dir, "master_scene_mesh.obj")
        extract_mesh(ply_path, master_mesh_path, opacity_threshold=0.45, depth=9)
        log_prog(40, f"Full-scene mesh created successfully: {master_mesh_path}")
        
        # Compute bounds
        ply_data = PLYReader(ply_path)
        vx = np.array(ply_data.data["vertex"]["x"])
        vy = np.array(ply_data.data["vertex"]["y"])
        vz = np.array(ply_data.data["vertex"]["z"])
        bbox_min = np.array([vx.min(), vy.min(), vz.min()])
        bbox_max = np.array([vx.max(), vy.max(), vz.max()])
        center = (bbox_min + bbox_max) / 2.0
        
        # Check config to see if we should skip segmentation (only extract mesh)
        only_mesh = config.get("only_mesh", False)
        
        if only_mesh:
            print("[*] only_mesh mode is active. Skipping 2D Segmentation & 3D backprojection.")
            log_prog(60, "Skipping 2D Segmentation & backprojection (Only Mesh mode is active)...")
            isolated_objects = {}
        else:
            log_prog(45, "Phase 2: Generating Virtual Views & Depth maps...")
            temp_render_dir = os.path.join(output_dir, "temp_renders")
            cameras = generate_virtual_cameras(bbox_min, bbox_max, center, num_cameras=30)
            
            # Color resolution
            SH_C0 = 0.28209479177387814
            if "f_dc_0" in ply_data.data["vertex"]:
                r = 0.5 + SH_C0 * np.array(ply_data.data["vertex"]["f_dc_0"])
                g = 0.5 + SH_C0 * np.array(ply_data.data["vertex"]["f_dc_1"])
                b = 0.5 + SH_C0 * np.array(ply_data.data["vertex"]["f_dc_2"])
                colors = np.vstack([r, g, b]).T
                colors = np.clip(colors, 0.0, 1.0) * 255
            elif "red" in ply_data.data["vertex"]:
                r = np.array(ply_data.data["vertex"]["red"])
                g = np.array(ply_data.data["vertex"]["green"])
                b = np.array(ply_data.data["vertex"]["blue"])
                colors = np.vstack([r, g, b]).T
            else:
                colors = np.ones((len(vx), 3), dtype=np.uint8) * 128
            points = np.vstack([vx, vy, vz]).T
            
            rgb_dir, depths_dir, cams_json = render_scene_view(points, colors, cameras, temp_render_dir)
            log_prog(70, f"Renders complete. Saved 30 synthetic RGB views and depth maps.")
            
            log_prog(75, "Phase 3: 2D Segmentation & 3D Backprojection...")
            segments_output_dir = os.path.join(output_dir, "segments")
            isolated_objects = segment_and_project(
                ply_path=ply_path,
                rgb_dir=rgb_dir,
                depths_dir=depths_dir,
                cameras_json=cams_json,
                output_dir=segments_output_dir,
                query_labels=None
            )
            
            # Cleanup temp renders
            shutil.rmtree(temp_render_dir, ignore_errors=True)
            log_prog(90, f"Isolated and reconstructed {len(isolated_objects)} objects. Setting up renderer manifest...")
        
        # Copy assets to vr-assets folder and create the manifest.json
        print("[*] Preparing VR assets directory...")
        vr_assets_dir = os.path.join(job_dir, "vr-assets")
        os.makedirs(vr_assets_dir, exist_ok=True)
        
        # Copy the master trained PLY to vr-assets/background.ply
        print("[*] Copying master PLY file to vr-assets/background.ply...")
        shutil.copy(ply_path, os.path.join(vr_assets_dir, "background.ply"))
        
        # Convert full-scene room mesh to GLB for collision physics
        print("[*] Loading master scene mesh for GLB collision conversion (this takes ~10-15s)...")
        scene_mesh = trimesh.load(master_mesh_path)
        if isinstance(scene_mesh, trimesh.Scene):
            scene_mesh = scene_mesh.to_mesh()
        scene_glb_path = os.path.join(vr_assets_dir, "scene_collision.glb")
        print("[*] Exporting master mesh to GLB collision format...")
        scene_mesh.export(scene_glb_path)
        print("[+] Collision mesh exported successfully.")
        
        manifest = {
            "scene_id": job_id,
            "scene_collision": "scene_collision.glb",
            "segments": [
                {
                    "id": 0,
                    "label": "background",
                    "file": "background.ply",
                    "collision": "scene_collision.glb",
                    "bbox": {
                        "min": bbox_min.tolist(),
                        "max": bbox_max.tolist()
                    },
                    "centroid": center.tolist(),
                    "movable": False
                }
            ]
        }
        
        # Add isolated object segments
        seg_id = 1
        for obj_name, paths in isolated_objects.items():
            ply_src = paths["ply"]
            mesh_src = paths["mesh"]
            
            ply_dest_name = f"{obj_name}.ply"
            glb_dest_name = f"collision_{obj_name}.glb"
            
            # Copy PLY to vr-assets
            shutil.copy(ply_src, os.path.join(vr_assets_dir, ply_dest_name))
            
            # Convert OBJ mesh to GLB and save to vr-assets
            obj_mesh = trimesh.load(mesh_src)
            if isinstance(obj_mesh, trimesh.Scene):
                obj_mesh = obj_mesh.to_mesh()
            assert isinstance(obj_mesh, trimesh.Trimesh)
            obj_mesh.export(os.path.join(vr_assets_dir, glb_dest_name))
            
            # Calculate bbox and centroid
            pts = obj_mesh.vertices
            bmin = pts.min(axis=0)
            bmax = pts.max(axis=0)
            centroid = (bmin + bmax) / 2.0
            
            manifest["segments"].append({
                "id": seg_id,
                "label": obj_name,
                "file": ply_dest_name,
                "collision": glb_dest_name,
                "collision_type": "convex_hull",
                "bbox": {
                    "min": bmin.tolist(),
                    "max": bmax.tolist()
                },
                "centroid": centroid.tolist(),
                "movable": True
            })
            seg_id += 1
            
        manifest_path = os.path.join(vr_assets_dir, "manifest.json")
        print(f"[*] Writing interactive assets manifest: {manifest_path}...")
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)
            
        print("[+] Finished configuring interactive VR assets manifest.")
        log_prog(98, "Completed configuring interactive physics assets manifest.")
        return {
            "master_mesh": master_mesh_path,
            "objects": isolated_objects,
            "manifest": manifest
        }
        
    result = await loop.run_in_executor(None, run_wrapper)
    
    await push_ws({"type": "log", "step": step_id, "progress": 100, "text": "Mesh extraction and segmentation pipeline completed successfully!"})
    return result
