import numpy as np
from plyfile import PlyData

def compute_pca_alignment(ply_path: str) -> np.ndarray:
    """
    Computes PCA on the points in the PLY file to find the ground plane,
    and returns a 4x4 rotation matrix that aligns the normal to the Y-axis.
    """
    plydata = PlyData.read(ply_path)
    vertex = plydata['vertex']
    
    x = np.array(vertex['x'])
    y = np.array(vertex['y'])
    z = np.array(vertex['z'])
    
    points = np.vstack((x, y, z)).T
    
    # Compute centroid
    centroid = np.mean(points, axis=0)
    centered = points - centroid
    
    # Compute covariance matrix
    cov = np.cov(centered.T)
    
    # PCA: eigenvectors
    eigenvalues, eigenvectors = np.linalg.eigh(cov)
    
    # The normal of the largest plane is the eigenvector with the smallest eigenvalue
    # eigh returns eigenvalues in ascending order, so index 0 is the smallest
    normal = eigenvectors[:, 0]
    
    # Ensure normal points 'up' (positive Y direction mostly)
    if normal[1] < 0:
        normal = -normal
        
    target_normal = np.array([0, 1, 0])
    
    # Compute rotation matrix to align `normal` to `target_normal`
    v = np.cross(normal, target_normal)
    c = np.dot(normal, target_normal)
    s = np.linalg.norm(v)
    
    if s < 1e-6:
        # Already aligned or completely opposite
        if c < 0:
            # 180 degree rotation around X
            R = np.diag([1, -1, -1])
        else:
            R = np.eye(3)
    else:
        vX = np.array([
            [0, -v[2], v[1]],
            [v[2], 0, -v[0]],
            [-v[1], v[0], 0]
        ])
        R = np.eye(3) + vX + np.dot(vX, vX) * ((1 - c) / (s ** 2))
        
    matrix = np.eye(4)
    matrix[:3, :3] = R
    
    return matrix

def apply_transform(input_ply: str, output_ply: str, matrix: np.ndarray):
    """
    Applies a 4x4 transformation matrix to the vertices of a PLY file.
    """
    plydata = PlyData.read(input_ply)
    vertex = plydata['vertex']
    
    x = np.array(vertex['x'])
    y = np.array(vertex['y'])
    z = np.array(vertex['z'])
    
    # Convert to homogeneous coordinates
    points = np.vstack((x, y, z, np.ones_like(x)))
    
    # Apply transformation
    transformed = np.dot(matrix, points)
    
    # Update coordinates
    vertex['x'] = transformed[0, :]
    vertex['y'] = transformed[1, :]
    vertex['z'] = transformed[2, :]
    
    # Also update normals if they exist
    if 'nx' in vertex.data.dtype.names and 'ny' in vertex.data.dtype.names and 'nz' in vertex.data.dtype.names:
        nx = np.array(vertex['nx'])
        ny = np.array(vertex['ny'])
        nz = np.array(vertex['nz'])
        normals = np.vstack((nx, ny, nz, np.zeros_like(nx)))
        transformed_normals = np.dot(matrix, normals)
        vertex['nx'] = transformed_normals[0, :]
        vertex['ny'] = transformed_normals[1, :]
        vertex['nz'] = transformed_normals[2, :]
        
    plydata.write(output_ply)
