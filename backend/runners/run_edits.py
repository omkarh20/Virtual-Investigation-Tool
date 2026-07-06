import numpy as np
import json
import os
from plyfile import PlyData, PlyElement

import traceback

def apply_edits_to_ply(ply_path: str, matrix_list: list = None, deletions: list = None, world_matrix: list = None):
    """
    Applies a 4x4 transformation matrix and rectangular frustum deletions to a PLY file.
    """
    if not os.path.exists(ply_path):
        raise FileNotFoundError(f"PLY file not found at {ply_path}")
        
    print(f"Applying edits to {ply_path}...")
    plydata = PlyData.read(ply_path)
    vertex_data = plydata.elements[0].data.copy()
    
    # Apply Transformation Matrix
    if matrix_list:
        # Frontend sends 16-element column-major array. Convert to 4x4 row-major.
        matrix = np.array(matrix_list).reshape(4, 4).T
        
        # Extract xyz
        pts = np.vstack((vertex_data['x'], vertex_data['y'], vertex_data['z'], np.ones(len(vertex_data)))).T
        
        # Apply transform
        transformed_pts = pts.dot(matrix.T)
        
        vertex_data['x'] = transformed_pts[:, 0]
        vertex_data['y'] = transformed_pts[:, 1]
        vertex_data['z'] = transformed_pts[:, 2]
        
        # Rotate normals if present
        if 'nx' in vertex_data.dtype.names:
            R = matrix[:3, :3]
            normals = np.vstack((vertex_data['nx'], vertex_data['ny'], vertex_data['nz'])).T
            rotated_normals = normals.dot(R.T)
            vertex_data['nx'] = rotated_normals[:, 0]
            vertex_data['ny'] = rotated_normals[:, 1]
            vertex_data['nz'] = rotated_normals[:, 2]
            
        # Rotate quaternions if present (3D Gaussian Splats)
        if 'rot_0' in vertex_data.dtype.names:
            from scipy.spatial.transform import Rotation as R_scipy
            
            rot_matrix = matrix[:3, :3]
            # Convert transform rotation to scipy Rotation
            r_applied = R_scipy.from_matrix(rot_matrix)
            
            # Original quaternions [w, x, y, z] (3DGS uses w, x, y, z)
            # SciPy uses [x, y, z, w]
            w = vertex_data['rot_0']
            x = vertex_data['rot_1']
            y = vertex_data['rot_2']
            z = vertex_data['rot_3']
            
            quats = np.vstack((x, y, z, w)).T
            
            # Handle unnormalized quaternions (sometimes produced by 3DGS trainers)
            norms = np.linalg.norm(quats, axis=1, keepdims=True)
            norms[norms == 0] = 1.0 # avoid div by zero
            quats_norm = quats / norms
            
            r_orig = R_scipy.from_quat(quats_norm)
            
            # Apply rotation
            r_new = r_applied * r_orig
            new_quats_norm = r_new.as_quat() # returns [x, y, z, w]
            
            # Multiply back the original norms
            new_quats = new_quats_norm * norms
            
            vertex_data['rot_1'] = new_quats[:, 0]
            vertex_data['rot_2'] = new_quats[:, 1]
            vertex_data['rot_3'] = new_quats[:, 2]
            vertex_data['rot_0'] = new_quats[:, 3]
            
        print("Transformation applied.")

    # Apply Deletions (Frustum cropping)
    if deletions and len(deletions) > 0:
        # For camera frustum checks, the points must be in the same World space 
        # that the camera was in when the box was drawn.
        # This means applying the ORIGINAL splat.matrixWorld (which we pass as world_matrix)
        pts3d = np.vstack((plydata.elements[0].data['x'], plydata.elements[0].data['y'], plydata.elements[0].data['z'])).T
        pts4d_orig = np.hstack((pts3d, np.ones((pts3d.shape[0], 1))))
        
        if world_matrix:
            w_matrix = np.array(world_matrix).reshape(4, 4).T
            pts4d_world = pts4d_orig.dot(w_matrix.T)
        else:
            # Fallback if no world_matrix was provided (should not happen normally)
            pts4d_world = pts4d_orig
            
        keep_mask = np.ones(len(vertex_data), dtype=bool)
        
        for d in deletions:
            # camera matrix is modelViewMatrix inverse in threejs? 
            # The frontend sends camera.matrixWorld. 
            # To go from world to camera space, we need the inverse of matrixWorld.
            cam_matrix_world = np.array(d["matrix"]).reshape(4, 4).T
            view_matrix = np.linalg.inv(cam_matrix_world)
            proj_matrix = np.array(d["projectionMatrix"]).reshape(4, 4).T
            
            x_min, y_min, x_max, y_max = d["rect"]
            # Three.js screen coords: x is 0 to 1, y is 0 to 1. 
            # NDC in Three.js is x: -1 to 1, y: -1 to 1 (bottom to top).
            # Wait, our frontend rect xMin/yMin was just (mouseX / width).
            # So x: 0 to 1 (left to right), y: 0 to 1 (top to bottom).
            
            # Project points from World space to Camera NDC
            pts_cam = pts4d_world.dot(view_matrix.T)
            pts_clip = pts_cam.dot(proj_matrix.T)
            
            # Filter points behind camera
            w = pts_clip[:, 3]
            valid_depth = w > 0
            
            # Divide by w to get NDC
            ndc_x = pts_clip[:, 0] / w
            ndc_y = pts_clip[:, 1] / w
            
            # Map NDC (-1 to 1) to screen (0 to 1)
            # Three.js projection: 
            # NDC x is -1 to 1 (left to right) -> screen x is (ndc_x + 1) / 2
            # NDC y is -1 to 1 (bottom to top) -> screen y is (-ndc_y + 1) / 2
            screen_x = (ndc_x + 1.0) / 2.0
            screen_y = (-ndc_y + 1.0) / 2.0
            
            in_rect = (screen_x >= x_min) & (screen_x <= x_max) & (screen_y >= y_min) & (screen_y <= y_max)
            
            if d.get("invert", False):
                # Keep what is inside the rect AND in front of the camera.
                # Which means delete everything else (outside rect OR behind camera).
                to_delete = ~(valid_depth & in_rect)
            else:
                # Delete what is inside the rect and in front of camera
                to_delete = valid_depth & in_rect
                
            keep_mask = keep_mask & ~to_delete
            
        print(f"Deleting {np.sum(~keep_mask)} points out of {len(vertex_data)}.")
        vertex_data = vertex_data[keep_mask]
        
    # Write back
    el = PlyElement.describe(vertex_data, 'vertex')
    PlyData([el]).write(ply_path)
    print(f"Edits saved to {ply_path}.")
