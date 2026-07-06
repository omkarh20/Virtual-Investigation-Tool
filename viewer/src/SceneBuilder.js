import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ManifestLoader } from './ManifestLoader.js';
import { SplatMesh } from '@sparkjsdev/spark';

export class SceneBuilder {
    constructor(scene, camera, transformControls, disableControlsFn, enableControlsFn, physicsManager) {
        this.scene = scene;
        this.camera = camera;
        this.transformControls = transformControls;
        this.disableControls = disableControlsFn;
        this.enableControls = enableControlsFn;
        this.physicsManager = physicsManager;

        this.segments = new Map();       // id -> splatMesh
        this.hitboxes = new Map();       // id -> hitbox mesh
        this.originalPositions = new Map(); // id -> { hitbox: Vector3, splat: Vector3, hitboxQuat: Quaternion, splatQuat: Quaternion }

        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.tooltip = document.getElementById('tooltip');
        
        this.interactionMode = false;
        this.gizmoMode = 'translate';
        this.rectSelectMode = false;
        this.selectedId = null;
        this.deletedRegions = []; // Store { matrixWorld, rect: [xmin, ymin, xmax, ymax] }
        
        this.setupRaycasting();
        this.setupInteractionToggle();
        this.setupSelection();
        this.setupGizmoModeToggle();
        this.setupRectSelectionToggle();
        this.setupResetButtons();
        this.setupGizmoSync();
        this.setupRectSelection();
        this.setupHullToggle();
    }

    // ── File Upload ─────────────────────────────────────────────────────────
    async loadFromFile(file) {
        this.clearScene();
        
        const statusEl = document.getElementById('scene-status');
        const countEl = document.getElementById('segment-count');

        if (statusEl) statusEl.innerText = `Loading ${file.name}...`;

        const url = URL.createObjectURL(file);
        const splat = new SplatMesh({ url: url });
        splat.quaternion.set(1, 0, 0, 0);

        splat.userData = {
            id: Date.now(),
            label: file.name,
            movable: false
        };

        this.scene.add(splat);
        this.segments.set(splat.userData.id, splat);

        if (statusEl) statusEl.innerText = `Loaded: ${file.name}`;
        if (countEl) countEl.innerText = this.segments.size.toString();
        
        this.currentLocalFile = file;
        this.showEditingCard(false, null);
        
        const interactionCard = document.getElementById('card-interaction');
        if (interactionCard) interactionCard.style.display = 'flex';
        
        const vrBtn = document.getElementById('enter-vr-btn');
        if (vrBtn) vrBtn.disabled = false;

        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    
    async loadPointCloudForAlignment(jobId) {
        const statusEl = document.getElementById('scene-status');
        if (statusEl) statusEl.innerText = `Loading point cloud for Job ${jobId.slice(0, 8)}...`;
        
        try {
            this.clearScene();
            const url = `http://${window.location.hostname}:8000/download/${jobId}/4`;
            this.alignmentDownloadUrl = `/download/${jobId}/4`;
            const res = await fetch(url);
            if (!res.ok) throw new Error("Could not download point cloud");
            
            const blob = await res.blob();
            const file = new File([blob], 'labelled_point_cloud.ply');
            await this.loadFromFile(file);
            this.enterAlignmentMode(jobId);
        } catch (e) {
            console.error(e);
            if (statusEl) statusEl.innerText = `Error: ${e.message}`;
        }
    }

    async loadSplatForVcam(jobId, isReload = false) {
        const statusEl = document.getElementById('scene-status');
        if (statusEl) statusEl.innerText = `Loading 3DGS point cloud for Job ${jobId.slice(0, 8)}...`;
        
        try {
            this.clearScene();
            const url = `http://${window.location.hostname}:8000/download/${jobId}/splat`;
            this.alignmentDownloadUrl = `/download/${jobId}/splat`;
            const res = await fetch(url);
            if (!res.ok) throw new Error("Could not download splat point cloud");
            
            const blob = await res.blob();
            const file = new File([blob], 'point_cloud.ply');
            await this.loadFromFile(file);
            if (!isReload) this.enterAlignmentMode(jobId);
        } catch (e) {
            console.error(e);
            if (statusEl) statusEl.innerText = `Error: ${e.message}`;
        }
    }

    showEditingCard(isPipelineMode, jobId) {
        const editingCard = document.getElementById('card-scene-editing');
        const submitBtn = document.getElementById('submit-alignment-btn');
        const applyLocalBtn = document.getElementById('apply-local-btn');
        const exportLocalBtn = document.getElementById('export-local-btn');
        const deleteBtn = document.getElementById('delete-selected-btn');
        const keepBtn = document.getElementById('keep-selected-btn');
        const undoBtn = document.getElementById('undo-delete-btn');
        
        if (editingCard) editingCard.style.display = 'flex';
        
        if (deleteBtn) deleteBtn.style.display = 'block';
        if (keepBtn) keepBtn.style.display = 'block';
        if (undoBtn) undoBtn.style.display = 'block';

        // Hide all save/apply/export buttons initially
        if (submitBtn) submitBtn.style.display = 'none';
        if (applyLocalBtn) applyLocalBtn.style.display = 'none';
        if (exportLocalBtn) exportLocalBtn.style.display = 'none';
        
        // Reset mode to 'none' visually
        const transBtn = document.getElementById('gizmo-translate-btn');
        const rotBtn = document.getElementById('gizmo-rotate-btn');
        const noneBtn = document.getElementById('gizmo-none-btn');
        if (transBtn) transBtn.classList.remove('active');
        if (rotBtn) rotBtn.classList.remove('active');
        if (noneBtn) noneBtn.classList.add('active');
        this.gizmoMode = 'none';
        this.transformControls.detach();
        
        // Hide "Save Edits to Pipeline" if we are in Virtual Camera mode.
        // We know we are in VCam mode if the download url includes 'splat'.
        const isVcamMode = this.alignmentDownloadUrl && this.alignmentDownloadUrl.includes('splat');
        
        if (isPipelineMode) {
            if (submitBtn) {
                if (isVcamMode) {
                    submitBtn.style.display = 'none';
                } else {
                    submitBtn.style.display = 'block';
                    submitBtn.onclick = async () => this.submitPipelineEdits(jobId, submitBtn);
                }
            }
            if (applyLocalBtn) {
                applyLocalBtn.style.display = 'block';
                applyLocalBtn.onclick = async () => this.applyLocalEdits(applyLocalBtn);
            }
            if (exportLocalBtn) {
                exportLocalBtn.style.display = 'block';
                exportLocalBtn.onclick = async () => this.exportLocalEdits(exportLocalBtn);
            }
        } else {
            if (applyLocalBtn) {
                applyLocalBtn.style.display = 'block';
                applyLocalBtn.onclick = async () => this.applyLocalEdits(applyLocalBtn);
            }
            if (exportLocalBtn) {
                exportLocalBtn.style.display = 'block';
                exportLocalBtn.onclick = async () => this.exportLocalEdits(exportLocalBtn);
            }
        }
    }

    async submitPipelineEdits(jobId, submitBtn) {
        const statusEl = document.getElementById('scene-status');
        const splat = Array.from(this.segments.values())[0];
        if (!splat) return;
        
        splat.updateMatrixWorld(true);
        
        // Remove the default 180 deg X rotation (Q) from the matrix before sending.
        // This ensures the backend saves the .ply in its native orientation space,
        // so that when it is reloaded and Q is applied again, it doesn't double-flip.
        const qInv = new THREE.Matrix4().makeRotationX(-Math.PI);
        const matrix = qInv.multiply(splat.matrixWorld).toArray();
        const worldMatrix = splat.matrixWorld.toArray();
        
        if (submitBtn) submitBtn.innerText = 'Submitting...';
        
        try {
            const res = await fetch(`http://${window.location.hostname}:8000/submit-edits`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    job_id: jobId, 
                    transform_matrix: matrix,
                    world_matrix: worldMatrix,
                    deletions: this.deletedRegions
                })
            });
            
            if (!res.ok) throw new Error("Failed to submit edits");
            
            if (statusEl) statusEl.innerText = "Edits submitted successfully!";
            const editingCard = document.getElementById('card-scene-editing');
            if (editingCard) editingCard.style.display = 'none';
            
            this.transformControls.detach();
            for (const region of this.deletedRegions) {
                if (region.mesh) {
                    this.scene.remove(region.mesh);
                    if (region.mesh.geometry) region.mesh.geometry.dispose();
                }
            }
            this.deletedRegions = []; 
            const vcPanel = document.getElementById('vc-panel');
            if (window.location.hash.includes('?vcam=')) {
                if (statusEl) statusEl.innerText = "Edits saved! Reloading scene...";
                setTimeout(() => {
                    this.loadSplatForVcam(jobId, true);
                    if (statusEl) statusEl.innerText = "Edits saved! Now place Virtual Cameras.";
                    if (vcPanel) vcPanel.style.display = 'block';
                    this.transformControls.detach();
                }, 500);
            } else {
                window.location.hash = `#/pipeline/${jobId}`;
            }
        } catch(e) {
            alert("Error submitting edits: " + e.message);
            if (submitBtn) submitBtn.innerText = 'Save Edits to Pipeline';
        }
    }

    async applyLocalEdits(applyBtn) {
        if (!this.currentLocalFile) {
            alert("No local file loaded to apply edits.");
            return;
        }
        
        const splat = Array.from(this.segments.values())[0];
        if (!splat) return;
        
        splat.updateMatrixWorld(true);
        
        const qInv = new THREE.Matrix4().makeRotationX(-Math.PI);
        const matrix = qInv.multiply(splat.matrixWorld).toArray();
        const worldMatrix = splat.matrixWorld.toArray();
        
        applyBtn.innerText = 'Applying...';
        const statusEl = document.getElementById('scene-status');
        if (statusEl) statusEl.innerText = 'Applying edits on backend...';
        
        try {
            if (this.alignmentJobId) {
                // Pipeline mode iterative edit preview
                const body = {
                    job_id: this.alignmentJobId,
                    transform_matrix: matrix,
                    world_matrix: worldMatrix,
                    deletions: this.deletedRegions,
                    preview: true
                };
                const res = await fetch(`http://${window.location.hostname}:8000/submit-edits`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (!res.ok) throw new Error("Failed to preview pipeline edits");
                
                // Re-download the modified pipeline file
                const downloadPath = this.alignmentDownloadUrl || `/download/${this.alignmentJobId}/4`;
                const url = `http://${window.location.hostname}:8000${downloadPath}?t=${Date.now()}`;
                const dRes = await fetch(url);
                if (!dRes.ok) throw new Error("Could not re-download point cloud");
                const blob = await dRes.blob();
                const newFile = new File([blob], 'labelled_point_cloud.ply');
                
                await this.loadFromFile(newFile);
                this.enterAlignmentMode(this.alignmentJobId);
                
                applyBtn.innerText = 'Apply & Reload';
                if (statusEl) statusEl.innerText = 'Edits applied successfully.';
                return;
            }

            const formData = new FormData();
            formData.append('file', this.currentLocalFile);
            formData.append('transform_matrix', JSON.stringify(matrix));
            formData.append('world_matrix', JSON.stringify(worldMatrix));
            formData.append('deletions', JSON.stringify(this.deletedRegions));
            
            const res = await fetch(`http://${window.location.hostname}:8000/export-local`, {
                method: 'POST',
                body: formData
            });
            
            if (!res.ok) throw new Error("Failed to apply local edits");
            
            const blob = await res.blob();
            // Create a new File from the returned blob
            const newFile = new File([blob], this.currentLocalFile.name);
            
            // Clean up old state
            applyBtn.innerText = 'Apply & Reload';
            for (const region of this.deletedRegions) {
                if (region.mesh) {
                    this.scene.remove(region.mesh);
                    if (region.mesh.geometry) region.mesh.geometry.dispose();
                }
            }
            this.deletedRegions = [];
            
            if (statusEl) statusEl.innerText = "Edits applied successfully! Reloading...";
            
            // Reload into viewer
            await this.loadFromFile(newFile);
            if (this.alignmentJobId) {
                this.enterAlignmentMode(this.alignmentJobId);
            }
            
        } catch(e) {
            alert("Error applying edits: " + e.message);
            applyBtn.innerText = 'Apply & Reload';
            if (statusEl) statusEl.innerText = "Error applying edits.";
        }
    }

    async exportLocalEdits(exportBtn) {
        if (!this.currentLocalFile) {
            alert("No local file loaded to export.");
            return;
        }
        
        const splat = Array.from(this.segments.values())[0];
        if (!splat) return;
        
        splat.updateMatrixWorld(true);
        
        const qInv = new THREE.Matrix4().makeRotationX(-Math.PI);
        const matrix = qInv.multiply(splat.matrixWorld).toArray();
        const worldMatrix = splat.matrixWorld.toArray();
        
        exportBtn.innerText = 'Exporting...';
        
        const formData = new FormData();
        formData.append('file', this.currentLocalFile);
        formData.append('transform_matrix', JSON.stringify(matrix));
        formData.append('world_matrix', JSON.stringify(worldMatrix));
        formData.append('deletions', JSON.stringify(this.deletedRegions));
        
        try {
            const res = await fetch(`http://${window.location.hostname}:8000/export-local`, {
                method: 'POST',
                body: formData
            });
            
            if (!res.ok) throw new Error("Failed to export local edits");
            
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `edited_${this.currentLocalFile.name}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            exportBtn.innerText = 'Export Local (.ply)';
            for (const region of this.deletedRegions) {
                if (region.mesh) {
                    this.scene.remove(region.mesh);
                    if (region.mesh.geometry) region.mesh.geometry.dispose();
                }
            }
            this.deletedRegions = [];
            
            const statusEl = document.getElementById('scene-status');
            if (statusEl) statusEl.innerText = "Export successful!";
        } catch(e) {
            alert("Error exporting: " + e.message);
            exportBtn.innerText = 'Export Local (.ply)';
        }
    }

    enterAlignmentMode(jobId) {
        this.alignmentJobId = jobId;
        const statusEl = document.getElementById('scene-status');
        if (statusEl) statusEl.innerText = "SCENE EDIT MODE. Align model and draw selections to crop, then click Save Edits.";
        
        const vcPanel = document.getElementById('vc-panel');
        if (vcPanel) vcPanel.style.display = 'none'; // Hide VCam panel while editing
        
        this.showEditingCard(true, jobId);
        
        
        // Auto-select none by default
        const noneBtn = document.getElementById('gizmo-none-btn');
        if (noneBtn) noneBtn.click();
    }

    clearScene() {
        this.deselectObject();
        for (const mesh of this.segments.values()) {
            this.scene.remove(mesh);
            if (mesh.geometry) mesh.geometry.dispose();
            if (mesh.material) {
                if (Array.isArray(mesh.material)) {
                    mesh.material.forEach(m => m.dispose());
                } else {
                    mesh.material.dispose();
                }
            }
            if (typeof mesh.dispose === 'function') {
                mesh.dispose();
            }
        }
        for (const hitbox of this.hitboxes.values()) {
            this.scene.remove(hitbox);
            if (hitbox.geometry) hitbox.geometry.dispose();
            if (hitbox.material) hitbox.material.dispose();
        }
        
        for (const region of this.deletedRegions) {
            if (region.mesh) {
                this.scene.remove(region.mesh);
                if (region.mesh.geometry) region.mesh.geometry.dispose();
            }
        }
        
        this.segments.clear();
        this.hitboxes.clear();
        this.originalPositions.clear();
        this.deletedRegions = [];
        
        window.dispatchEvent(new Event('scene-cleared'));
    }

    // ── Manifest Loading ────────────────────────────────────────────────────
    async loadFromManifest() {
        const statusEl = document.getElementById('scene-status');
        const countEl = document.getElementById('segment-count');

        if (statusEl) statusEl.innerText = "Loading Manifest...";

        try {
            const manifest = await ManifestLoader.load();
            if (statusEl) statusEl.innerText = `Loaded Scene: ${manifest.scene_id}`;

            for (const segment of manifest.segments) {
                if (manifest.baseUrl) {
                    const url = `${manifest.baseUrl}/${segment.file}`;
                    this.loadSplatSegment(segment, url);
                } else {
                    this.buildDummySegment(segment);
                }
            }
            
            this.populateSceneGraph(manifest);

            if (countEl) countEl.innerText = this.segments.size.toString();
            
            const vrBtn = document.getElementById('enter-vr-btn');
            if (vrBtn) vrBtn.disabled = false;

            const interactionCard = document.getElementById('card-interaction');
            if (interactionCard) interactionCard.style.display = 'flex';
            
            const sceneGraphClose = document.getElementById('scene-graph-close-btn');
            if (sceneGraphClose) {
                sceneGraphClose.onclick = () => { document.getElementById('scene-graph-panel').style.display = 'none'; };
            }

            this.showEditingCard(false, null);
        } catch (e) {
            console.warn("Manifest load skipped:", e.message);
            if (statusEl) statusEl.innerText = "Ready. Please load a local file.";
        }
    }

    populateSceneGraph(manifest) {
        const list = document.getElementById('scene-graph-list');
        if (!list) return;
        
        list.innerHTML = '';
        manifest.segments.forEach(segment => {
            const item = document.createElement('div');
            item.style.display = 'flex';
            item.style.justifyContent = 'space-between';
            item.style.alignItems = 'center';
            item.style.padding = '4px 8px';
            item.style.background = 'rgba(255,255,255,0.05)';
            item.style.borderRadius = '4px';
            
            const name = document.createElement('span');
            name.style.color = 'white';
            name.style.fontSize = '0.9rem';
            name.innerText = segment.label || `Segment ${segment.id}`;
            
            const eyeBtn = document.createElement('button');
            eyeBtn.style.background = 'none';
            eyeBtn.style.border = 'none';
            eyeBtn.style.cursor = 'pointer';
            eyeBtn.style.fontSize = '1.1rem';
            eyeBtn.innerText = '👁️';
            eyeBtn.title = "Toggle Physics Hull";
            
            eyeBtn.style.opacity = this.showHulls ? '1.0' : '0.3';
            
            eyeBtn.onclick = () => {
                const hitbox = this.hitboxes.get(segment.id);
                if (hitbox) {
                    const isVisible = hitbox.userData.hullVisible !== false;
                    hitbox.userData.hullVisible = !isVisible;
                    eyeBtn.style.opacity = hitbox.userData.hullVisible ? '1.0' : '0.3';
                    this.updateHullVisibility();
                }
            };
            
            item.appendChild(name);
            item.appendChild(eyeBtn);
            list.appendChild(item);
        });
    }

    // ── Splat Segment Loading ───────────────────────────────────────────────
    async loadSplatSegment(segment, url) {
        const splat = new SplatMesh({ url: url });
        splat.quaternion.set(1, 0, 0, 0);

        splat.userData = {
            id: segment.id,
            label: segment.label,
            movable: segment.movable
        };

        this.scene.add(splat);
        this.segments.set(segment.id, splat);
        
        const color = segment.movable ? 0xef4444 : 0x3b82f6;
        const glbUrl = url.replace(segment.file, segment.collision);
        const loader = new GLTFLoader();

        loader.load(glbUrl, (gltf) => {
            let mesh = null;
            gltf.scene.traverse((child) => {
                if (child.isMesh && !mesh) mesh = child;
            });
            if (!mesh) return;

            const geometry = mesh.geometry;
            // Shift vertices so the mesh origin is at the centroid
            geometry.translate(-segment.centroid[0], -segment.centroid[1], -segment.centroid[2]);

            const material = new THREE.MeshBasicMaterial({ 
                color: color, 
                wireframe: false,
                transparent: true,
                opacity: 0.3,    
                depthWrite: false, 
                visible: this.interactionMode
            });
            const hitbox = new THREE.Mesh(geometry, material);

            // Place the mesh at the flipped centroid and apply the 180 deg X rotation
            hitbox.position.set(segment.centroid[0], -segment.centroid[1], -segment.centroid[2]);
            hitbox.quaternion.set(1, 0, 0, 0);

            hitbox.userData = {
                id: segment.id,
                label: segment.label,
                movable: segment.movable,
                splatRef: splat,
                hullVisible: this.showHulls
            };
            
            // Wireframe edges
            const edges = new THREE.EdgesGeometry(geometry);
            const lineMat = new THREE.LineBasicMaterial({ color: color, opacity: 0.8, transparent: true });
            const line = new THREE.LineSegments(edges, lineMat);
            line.visible = this.interactionMode;
            
            hitbox.userData.edgeHelper = line;
            hitbox.userData.originalColor = color;
            hitbox.add(line);
            
            this.scene.add(hitbox);
            this.hitboxes.set(segment.id, hitbox);

            // Register with physics engine!
            if (this.physicsManager) {
                this.physicsManager.createBodyFromMesh(segment.id, hitbox, segment.movable);
            }

            // Store original positions and rotations for reset
            this.originalPositions.set(segment.id, {
                hitbox: hitbox.position.clone(),
                splat: splat.position.clone(),
                hitboxQuat: hitbox.quaternion.clone(),
                splatQuat: splat.quaternion.clone()
            });
        });
    }

    // ── Dummy Segments (fallback) ───────────────────────────────────────────
    buildDummySegment(segment) {
        const width = segment.bbox.max[0] - segment.bbox.min[0];
        const height = segment.bbox.max[1] - segment.bbox.min[1];
        const depth = segment.bbox.max[2] - segment.bbox.min[2];

        const geometry = new THREE.BoxGeometry(width, height, depth);
        
        const color = segment.movable ? 0xef4444 : 0x3b82f6;
        const material = new THREE.MeshStandardMaterial({ 
            color: color, 
            transparent: true, 
            opacity: 0.8,
            roughness: 0.2,
            metalness: 0.1
        });
        
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(segment.centroid[0], segment.centroid[1], segment.centroid[2]);
        
        const edges = new THREE.EdgesGeometry(geometry);
        const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.5, transparent: true }));
        mesh.add(line);

        mesh.userData = {
            id: segment.id,
            label: segment.label,
            movable: segment.movable,
            hullVisible: this.showHulls
        };

        this.scene.add(mesh);
        this.segments.set(segment.id, mesh);
    }

    // ── Interaction & Selection ─────────────────────────────────────────────
    setupInteractionToggle() {
        const btn = document.getElementById('toggle-interaction-btn');
        if (!btn) return;
        
        btn.addEventListener('click', () => {
            this.interactionMode = !this.interactionMode;
            btn.innerText = `Interaction: ${this.interactionMode ? 'ON' : 'OFF'}`;
            if (this.interactionMode) {
                btn.classList.add('active');
                const sceneGraphPanel = document.getElementById('scene-graph-panel');
                if (sceneGraphPanel && this.hitboxes.size > 0) sceneGraphPanel.style.display = 'block';
            } else {
                btn.classList.remove('active');
                const sceneGraphPanel = document.getElementById('scene-graph-panel');
                if (sceneGraphPanel) sceneGraphPanel.style.display = 'none';
            }
            
            this.updateHullVisibility();

            if (!this.interactionMode) {
                this.deselectObject();
                this.transformControls.detach();
                const modeBtn = document.getElementById('toggle-gizmo-mode-btn');
                if (modeBtn) modeBtn.style.display = 'none';
                const resetObjBtn = document.getElementById('reset-object-btn');
                if (resetObjBtn) resetObjBtn.style.display = 'none';
            }
        });
    }
    
    setupHullToggle() {
        this.showHulls = false;
        const btn = document.getElementById('toggle-hull-btn');
        if (!btn) return;
        
        btn.addEventListener('click', () => {
            this.showHulls = !this.showHulls;
            btn.innerText = `Hulls: ${this.showHulls ? 'ON' : 'OFF'}`;
            if (this.showHulls) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
            
            // Mass update hullVisible states
            for (const hitbox of this.hitboxes.values()) {
                hitbox.userData.hullVisible = this.showHulls;
            }
            
            // Sync UI panel eyes
            const list = document.getElementById('scene-graph-list');
            if (list) {
                const eyes = list.querySelectorAll('button');
                eyes.forEach(eyeBtn => {
                    eyeBtn.style.opacity = this.showHulls ? '1.0' : '0.3';
                });
            }
            
            this.updateHullVisibility();
        });
    }
    
    updateHullVisibility() {
        for (const [id, hitbox] of this.hitboxes.entries()) {
            if (hitbox.userData.edgeHelper) {
                const isHullVisible = hitbox.userData.hullVisible !== false;
                hitbox.userData.edgeHelper.visible = isHullVisible && (id === this.selectedId || this.interactionMode);
                if (id !== this.selectedId) {
                    hitbox.material.visible = this.interactionMode && isHullVisible;
                }
            }
        }
    }

    setupGizmoModeToggle() {
        const transBtn = document.getElementById('gizmo-translate-btn');
        const rotBtn = document.getElementById('gizmo-rotate-btn');
        const noneBtn = document.getElementById('gizmo-none-btn');
        
        const updateActive = (activeBtn) => {
            if (transBtn) transBtn.classList.remove('active');
            if (rotBtn) rotBtn.classList.remove('active');
            if (noneBtn) noneBtn.classList.remove('active');
            if (activeBtn) activeBtn.classList.add('active');
        };

        if (transBtn) {
            transBtn.addEventListener('click', () => {
                this.gizmoMode = 'translate';
                this.transformControls.setMode('translate');
                updateActive(transBtn);
                this.attachGizmoToActiveTarget();
            });
        }
        if (rotBtn) {
            rotBtn.addEventListener('click', () => {
                this.gizmoMode = 'rotate';
                this.transformControls.setMode('rotate');
                updateActive(rotBtn);
                this.attachGizmoToActiveTarget();
            });
        }
        if (noneBtn) {
            noneBtn.addEventListener('click', () => {
                this.gizmoMode = 'none';
                this.transformControls.detach();
                updateActive(noneBtn);
            });
        }
    }

    attachGizmoToActiveTarget() {
        if (this.gizmoMode === 'none') {
            this.transformControls.detach();
            return;
        }
        if (this.interactionMode) {
            if (this.selectedId && this.hitboxes.has(this.selectedId)) {
                this.transformControls.attach(this.hitboxes.get(this.selectedId));
            } else {
                this.transformControls.detach();
            }
        } else {
            const splat = Array.from(this.segments.values())[0];
            if (splat) {
                this.transformControls.attach(splat);
            }
        }
    }

    createFrustumMesh(rect, camera, color = 0xff0000) {
        const xMin = rect.xMin * 2 - 1;
        const xMax = rect.xMax * 2 - 1;
        const yMin = -(rect.yMax * 2 - 1);
        const yMax = -(rect.yMin * 2 - 1);

        const pts = [
            new THREE.Vector3(xMin, yMin, -1),
            new THREE.Vector3(xMax, yMin, -1),
            new THREE.Vector3(xMin, yMax, -1),
            new THREE.Vector3(xMax, yMax, -1),
            new THREE.Vector3(xMin, yMin, 1),
            new THREE.Vector3(xMax, yMin, 1),
            new THREE.Vector3(xMin, yMax, 1),
            new THREE.Vector3(xMax, yMax, 1)
        ];

        pts.forEach(p => p.unproject(camera));

        const indices = [
            0, 1, 2,  1, 3, 2, 
            4, 6, 5,  5, 6, 7, 
            0, 4, 1,  1, 4, 5, 
            2, 3, 6,  3, 7, 6, 
            0, 2, 4,  2, 6, 4, 
            1, 5, 3,  3, 5, 7  
        ];

        const positions = new Float32Array(pts.length * 3);
        pts.forEach((p, i) => {
            positions[i*3] = p.x;
            positions[i*3+1] = p.y;
            positions[i*3+2] = p.z;
        });

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geom.setIndex(indices);
        geom.computeVertexNormals();

        const mat = new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.15, side: THREE.DoubleSide, depthWrite: false });
        const mesh = new THREE.Mesh(geom, mat);
        
        const edges = new THREE.EdgesGeometry(geom);
        const lineMat = new THREE.LineBasicMaterial({ color: color, linewidth: 2 });
        const lines = new THREE.LineSegments(edges, lineMat);
        mesh.add(lines);

        return mesh;
    }

    setupRectSelectionToggle() {
        const toggleBtn = document.getElementById('toggle-rect-select-btn');
        const deleteBtn = document.getElementById('delete-selected-btn');
        const keepBtn = document.getElementById('keep-selected-btn');
        const undoBtn = document.getElementById('undo-delete-btn');
        
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                this.rectSelectMode = !this.rectSelectMode;
                toggleBtn.innerText = this.rectSelectMode ? 'Select: On' : 'Select: Off';
                if (this.rectSelectMode) {
                    toggleBtn.classList.add('active');
                    this.transformControls.enabled = false;
                    this.disableControls();
                } else {
                    toggleBtn.classList.remove('active');
                    this.transformControls.enabled = true;
                    this.enableControls();
                    
                    // Clear the selection box when turning off
                    const svg = document.getElementById('rect-select-svg');
                    const box = document.getElementById('rect-select-box');
                    if (svg && box) {
                        box.style.display = 'none';
                        svg.classList.remove('active');
                    }
                    this.currentRect = null;
                }
            });
        }
        
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => {
                if (!this.currentRect) return;
                
                const frustumMesh = this.createFrustumMesh(this.currentRect, this.camera);
                this.scene.add(frustumMesh);

                // Store the current camera matrix and rect normalized coordinates
                const camMatrix = this.camera.matrixWorld.toArray();
                this.deletedRegions.push({
                    matrix: camMatrix,
                    rect: [
                        this.currentRect.xMin,
                        this.currentRect.yMin,
                        this.currentRect.xMax,
                        this.currentRect.yMax
                    ],
                    projectionMatrix: this.camera.projectionMatrix.toArray(),
                    mesh: frustumMesh
                });
                
                // Hide rect
                const svg = document.getElementById('rect-select-svg');
                const box = document.getElementById('rect-select-box');
                if (svg && box) {
                    box.style.display = 'none';
                    svg.classList.remove('active');
                }
                this.currentRect = null;
            });
        }
        
        if (keepBtn) {
            keepBtn.addEventListener('click', () => {
                if (!this.currentRect) return;
                
                const frustumMesh = this.createFrustumMesh(this.currentRect, this.camera, 0x3b82f6); // Blue
                this.scene.add(frustumMesh);

                // Store the current camera matrix and rect normalized coordinates
                const camMatrix = this.camera.matrixWorld.toArray();
                this.deletedRegions.push({
                    matrix: camMatrix,
                    rect: [
                        this.currentRect.xMin,
                        this.currentRect.yMin,
                        this.currentRect.xMax,
                        this.currentRect.yMax
                    ],
                    projectionMatrix: this.camera.projectionMatrix.toArray(),
                    mesh: frustumMesh,
                    invert: true
                });
                
                // Hide rect
                const svg = document.getElementById('rect-select-svg');
                const box = document.getElementById('rect-select-box');
                if (svg && box) {
                    box.style.display = 'none';
                    svg.classList.remove('active');
                }
                this.currentRect = null;
            });
        }

        if (undoBtn) {
            undoBtn.addEventListener('click', () => {
                if (this.deletedRegions.length === 0) {
                    alert("No deletions to undo.");
                    return;
                }
                const last = this.deletedRegions.pop();
                if (last.mesh) {
                    this.scene.remove(last.mesh);
                }
                alert(`Undid last deletion. (Total regions: ${this.deletedRegions.length})`);
            });
        }
    }

    setupRectSelection() {
        const svg = document.getElementById('rect-select-svg');
        const box = document.getElementById('rect-select-box');
        if (!svg || !box) return;

        let isDragging = false;
        let startX = 0, startY = 0;

        const updateBox = (endX, endY) => {
            const x = Math.min(startX, endX);
            const y = Math.min(startY, endY);
            const w = Math.abs(endX - startX);
            const h = Math.abs(endY - startY);
            box.setAttribute('x', x);
            box.setAttribute('y', y);
            box.setAttribute('width', w);
            box.setAttribute('height', h);
            
            this.currentRect = {
                xMin: x / window.innerWidth,
                yMin: y / window.innerHeight,
                xMax: (x + w) / window.innerWidth,
                yMax: (y + h) / window.innerHeight
            };
        };

        window.addEventListener('pointerdown', (e) => {
            if (!this.rectSelectMode || e.button !== 0) return;
            if (e.target.closest('.app-nav') || e.target.closest('.glass-panel') || e.target.closest('.primary-btn')) return;
            
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            
            svg.classList.add('active');
            box.style.display = 'block';
            updateBox(startX, startY);
        });

        window.addEventListener('pointermove', (e) => {
            if (!isDragging) return;
            updateBox(e.clientX, e.clientY);
        });

        window.addEventListener('pointerup', (e) => {
            if (!isDragging) return;
            isDragging = false;
            svg.classList.remove('active');
        });
    }

    selectObject(hitbox) {
        if (!hitbox.userData.movable) return;
        
        this.deselectObject();
        this.selectedId = hitbox.userData.id;

        if (hitbox.userData.edgeHelper) {
            hitbox.userData.edgeHelper.material.color.setHex(0x22ff44);
            const isHullVisible = hitbox.userData.hullVisible !== false;
            hitbox.userData.edgeHelper.visible = isHullVisible;
            hitbox.material.color.setHex(0x22ff44);
            hitbox.material.visible = isHullVisible;
        }

        // Reset gizmo mode to translate by default upon selection
        this.gizmoMode = 'translate';
        this.transformControls.setMode('translate');
        
        const modeBtn = document.getElementById('toggle-gizmo-mode-btn');
        if (modeBtn) {
            modeBtn.style.display = 'block';
            modeBtn.innerText = 'Mode: Translate';
        }

        const resetObjBtn = document.getElementById('reset-object-btn');
        if (resetObjBtn) resetObjBtn.style.display = 'block';

        this.transformControls.attach(hitbox);

        if (this.physicsManager && window.physicsEnabled) {
            this.physicsManager.setKinematic(this.selectedId, true);
        }
    }

    deselectObject() {
        if (this.selectedId === null) return;

        const hitbox = this.hitboxes.get(this.selectedId);
        if (hitbox) {
            if (hitbox.userData.edgeHelper) {
                hitbox.userData.edgeHelper.material.color.setHex(hitbox.userData.originalColor);
                const isHullVisible = hitbox.userData.hullVisible !== false;
                hitbox.userData.edgeHelper.visible = isHullVisible && this.interactionMode;
                hitbox.material.color.setHex(hitbox.userData.originalColor);
                hitbox.material.visible = false;
            }
        }

        const modeBtn = document.getElementById('toggle-gizmo-mode-btn');
        if (modeBtn) modeBtn.style.display = 'none';

        const resetObjBtn = document.getElementById('reset-object-btn');
        if (resetObjBtn) resetObjBtn.style.display = 'none';

        if (this.physicsManager && this.selectedId !== null && window.physicsEnabled) {
            const hitbox = this.hitboxes.get(this.selectedId);
            if (hitbox) {
                this.physicsManager.updateBodyTransform(this.selectedId, hitbox.position, hitbox.quaternion);
            }
            this.physicsManager.setKinematic(this.selectedId, false);
        }

        this.transformControls.detach();
        this.selectedId = null;
    }

    setupSelection() {
        window.addEventListener('mousedown', (event) => {
            if (!this.interactionMode) return; // Only select if interaction mode is ON
            if (event.target && typeof event.target.closest === 'function' && event.target.closest('#ui-overlay')) return; // Ignore UI clicks
            if (this.transformControls.dragging) return; // Ignore if dragging gizmo
            
            this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
            this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
            this.raycaster.setFromCamera(this.mouse, this.camera);
            
            const allHitboxes = Array.from(this.hitboxes.values());
            const movableHitboxes = allHitboxes.filter(h => h.userData.movable);

            const movableHits = this.raycaster.intersectObjects(movableHitboxes, false);

            if (movableHits.length > 0) {
                const hitbox = movableHits[0].object;
                this.selectObject(hitbox);
            }
            // Do NOT deselect on clicking empty space. Let Escape handle deselect.
        });

        // Escape to deselect
        window.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                this.deselectObject();
            }
        });
    }

    setupGizmoSync() {
        // Apply position and rotation to SplatMesh when Hitbox changes
        this.transformControls.addEventListener('objectChange', () => {
            if (this.selectedId === null) return;
            
            const hitbox = this.hitboxes.get(this.selectedId);
            const splat = hitbox?.userData.splatRef;
            const orig = this.originalPositions.get(this.selectedId);
            if (!orig) return;

            // 1. Rotation delta
            // hitbox current rotation relative to its original rotation
            const origQuatInv = orig.hitboxQuat.clone().invert();
            const deltaQuat = hitbox.quaternion.clone().multiply(origQuatInv);
            
            // apply this delta to the splat's original rotation
            splat.quaternion.copy(deltaQuat).multiply(orig.splatQuat);

            // 2. Position update (with pivot offset)
            // Since the splat's 0,0,0 origin is far away from the centroid, we must treat
            // the distance between them as a lever arm and rotate it by deltaQuat.
            const pivotOffset = new THREE.Vector3().subVectors(orig.splat, orig.hitbox);
            pivotOffset.applyQuaternion(deltaQuat);
            
            // The new position is the hitbox's position + the rotated lever arm
            splat.position.copy(hitbox.position).add(pivotOffset);

            // Sync back to physics engine so it doesn't fight the user!
            if (this.physicsManager && window.physicsEnabled) {
                this.physicsManager.updateBodyTransform(this.selectedId, hitbox.position, hitbox.quaternion);
            }
        });

        // Disable camera controls while dragging the gizmo
        this.transformControls.addEventListener('dragging-changed', (event) => {
            if (event.value) {
                this.disableControls();
            } else {
                this.enableControls();
            }
        });
    }

    syncSplatToHitboxWorld(id, worldPos, worldQuat) {
        const splat = this.segments.get(id);
        const orig = this.originalPositions.get(id);
        if (!splat || !orig) return;

        const origQuatInv = orig.hitboxQuat.clone().invert();
        const deltaQuat = worldQuat.clone().multiply(origQuatInv);
        
        splat.quaternion.copy(deltaQuat).multiply(orig.splatQuat);

        const pivotOffset = new THREE.Vector3().subVectors(orig.splat, orig.hitbox);
        pivotOffset.applyQuaternion(deltaQuat);
        
        splat.position.copy(worldPos).add(pivotOffset);
    }

    syncSplatsToHitboxes() {
        // Runs every frame to strictly tie the visual SplatMeshes to the physical hitboxes
        for (const [id, hitbox] of this.hitboxes.entries()) {
            const splat = this.segments.get(id);
            const orig = this.originalPositions.get(id);
            if (!splat || !orig) continue;

            const origQuatInv = orig.hitboxQuat.clone().invert();
            const deltaQuat = hitbox.quaternion.clone().multiply(origQuatInv);
            
            splat.quaternion.copy(deltaQuat).multiply(orig.splatQuat);

            const pivotOffset = new THREE.Vector3().subVectors(orig.splat, orig.hitbox);
            pivotOffset.applyQuaternion(deltaQuat);
            
            splat.position.copy(hitbox.position).add(pivotOffset);
        }
    }

    // ── Reset ───────────────────────────────────────────────────────────────
    resetObject() {
        if (this.selectedId === null) return;
        
        const orig = this.originalPositions.get(this.selectedId);
        const hitbox = this.hitboxes.get(this.selectedId);
        const splat = this.segments.get(this.selectedId);

        if (hitbox && orig) {
            hitbox.position.copy(orig.hitbox);
            hitbox.quaternion.copy(orig.hitboxQuat);
        }
        if (splat && orig) {
            splat.position.copy(orig.splat);
            splat.quaternion.copy(orig.splatQuat);
        }
    }

    resetScene() {
        this.deselectObject();

        for (const [id, positions] of this.originalPositions.entries()) {
            const hitbox = this.hitboxes.get(id);
            const splat = this.segments.get(id);

            if (hitbox) {
                hitbox.position.copy(positions.hitbox);
                hitbox.quaternion.copy(positions.hitboxQuat);
            }
            if (splat) {
                splat.position.copy(positions.splat);
                splat.quaternion.copy(positions.splatQuat);
            }
        }
        
        if (this.physicsManager && window.physicsEnabled) {
            this.physicsManager.resetAll();
        }
    }

    setupResetButtons() {
        const sceneBtn = document.getElementById('reset-scene-btn');
        if (sceneBtn) sceneBtn.addEventListener('click', () => this.resetScene());

        const objBtn = document.getElementById('reset-object-btn');
        if (objBtn) objBtn.addEventListener('click', () => this.resetObject());
    }

    // ── Raycasting & Tooltip ────────────────────────────────────────────────
    setupRaycasting() {
        window.addEventListener('mousemove', (event) => {
            this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
            this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

            this.raycast();
            
            if (this.tooltip && !this.tooltip.classList.contains('hidden')) {
                this.tooltip.style.left = event.clientX + 'px';
                this.tooltip.style.top = event.clientY + 'px';
            }
        });
    }

    raycast() {
        this.raycaster.setFromCamera(this.mouse, this.camera);
        
        const allHitboxes = Array.from(this.hitboxes.values());
        const movableHitboxes = allHitboxes.filter(h => h.userData.movable);
        const staticHitboxes  = allHitboxes.filter(h => !h.userData.movable);

        const dummyMeshes = this.scene.children.filter(
            c => c instanceof THREE.Mesh && !this.hitboxes.has(c.userData?.id)
        );

        let hit = null;

        const movableHits = this.raycaster.intersectObjects(movableHitboxes, false);
        if (movableHits.length > 0) {
            hit = movableHits[0].object;
        } else {
            const fallback = this.raycaster.intersectObjects([...staticHitboxes, ...dummyMeshes], true);
            if (fallback.length > 0) {
                let obj = fallback[0].object;
                while (obj && !obj.userData.label && obj.parent) obj = obj.parent;
                hit = obj;
            }
        }

        if (hit && hit.userData.label) {
            if (this.tooltip) {
                // If interaction mode is OFF, we probably don't want to show the tooltip either?
                // Actually, the tooltip is fine even if interaction mode is off, but
                // it might be cleaner to hide it. Let's keep it visible so users know what objects are.
                this.tooltip.innerText = hit.userData.label;
                this.tooltip.classList.remove('hidden');
                document.body.style.cursor = 'pointer';
            }
        } else {
            if (this.tooltip) {
                this.tooltip.classList.add('hidden');
                document.body.style.cursor = 'default';
            }
        }
    }
}
