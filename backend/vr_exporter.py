import os
import json
import numpy as np
from plyfile import PlyData, PlyElement
import trimesh

def process_vr_export(job_id: str, input_ply_path: str, output_dir: str):
    """
    Reads a labeled .ply file, splits it by segment label, generates bounding boxes
    and collision meshes, and produces a manifest.json.
    """
    os.makedirs(output_dir, exist_ok=True)
    
    print(f"[VR Export] Reading PLY file: {input_ply_path}")
    plydata = PlyData.read(input_ply_path)
    vertex_data = plydata['vertex'].data

    # Identify the label field
    label_field = None
    for field in vertex_data.dtype.names:
        if field in ['label', 'segment_id', 'segment']:
            label_field = field
            break
            
    if not label_field:
        print("[VR Export] WARNING: No label field found. Using all points as background.")
        # Create a dummy label array of zeros
        labels = np.zeros(len(vertex_data), dtype=np.int32)
    else:
        labels = vertex_data[label_field]

    unique_labels = np.unique(labels)
    print(f"[VR Export] Found labels: {unique_labels}")

    manifest = {
        "scene_id": job_id,
        "segments": [],
        "scene_collision": "scene_collision.glb"
    }

    # For the whole scene collision
    all_x = vertex_data['x']
    all_y = vertex_data['y']
    all_z = vertex_data['z']
    scene_min = np.array([all_x.min(), all_y.min(), all_z.min()])
    scene_max = np.array([all_x.max(), all_y.max(), all_z.max()])
    scene_extents = scene_max - scene_min
    scene_centroid = (scene_min + scene_max) / 2.0

    # Create scene collision (floor plane)
    scene_box = trimesh.creation.box(extents=scene_extents)
    scene_box.apply_translation(scene_centroid)
    scene_collision_path = os.path.join(output_dir, "scene_collision.glb")
    scene_box.export(scene_collision_path)

    for label_val in unique_labels:
        label_val = int(label_val)
        mask = (labels == label_val)
        segment_data = vertex_data[mask]
        
        is_background = (label_val == 0)
        label_name = "background" if is_background else f"object_{label_val}"
        
        ply_filename = f"segment_{label_val}_{label_name}.ply"
        glb_filename = f"collision_{label_val}.glb"
        
        ply_path = os.path.join(output_dir, ply_filename)
        glb_path = os.path.join(output_dir, glb_filename)
        
        # 1. Write the split PLY
        print(f"[VR Export] Writing {ply_filename} ({len(segment_data)} points)")
        el = PlyElement.describe(segment_data, 'vertex')
        PlyData([el], text=False).write(ply_path)
        
        # 2. Calculate Bounding Box
        x = segment_data['x']
        y = segment_data['y']
        z = segment_data['z']
        
        # If no points, skip or use zero bbox
        if len(x) == 0:
            continue
            
        bmin = np.array([x.min(), y.min(), z.min()])
        bmax = np.array([x.max(), y.max(), z.max()])
        extents = bmax - bmin
        centroid = (bmin + bmax) / 2.0
        
        # 3. Generate Convex Hull for Collision
        points = np.column_stack((x, y, z))
        collision_type = "convex_hull"
        
        if len(points) >= 4:
            try:
                # Try generating the convex hull
                collision_mesh = trimesh.points.PointCloud(points).convex_hull
                
                # Check if the hull is valid/has volume. If it is flat, fallback.
                if collision_mesh.is_empty or collision_mesh.volume < 1e-6:
                    raise ValueError("Hull is flat or empty")
            except Exception as e:
                # Fallback to box if hull generation fails (e.g. coplanar points)
                print(f"[VR Export] Hull generation failed for {label_name} ({e}). Falling back to box.")
                collision_type = "box"
                extents_pad = np.maximum(extents, 0.01)
                collision_mesh = trimesh.creation.box(extents=extents_pad)
                collision_mesh.apply_translation(centroid)
        else:
            # Fallback to box if not enough points
            collision_type = "box"
            extents_pad = np.maximum(extents, 0.01)
            collision_mesh = trimesh.creation.box(extents=extents_pad)
            collision_mesh.apply_translation(centroid)
            
        collision_mesh.export(glb_path)
        
        # 4. Append to manifest
        manifest["segments"].append({
            "id": label_val,
            "label": label_name,
            "file": ply_filename,
            "collision": glb_filename,
            "collision_type": collision_type,
            "bbox": {
                "min": bmin.tolist(),
                "max": bmax.tolist()
            },
            "centroid": centroid.tolist(),
            "movable": not is_background
        })
        
    # Write manifest
    manifest_path = os.path.join(output_dir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
        
    print(f"[VR Export] Complete! Wrote manifest to {manifest_path}")
    return manifest
