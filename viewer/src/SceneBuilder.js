import * as THREE from 'three';
import { ManifestLoader } from './ManifestLoader.js';
import { SplatMesh } from '@sparkjsdev/spark';

export class SceneBuilder {
    constructor(scene, camera, transformControls, disableControlsFn, enableControlsFn) {
        this.scene = scene;
        this.camera = camera;
        this.transformControls = transformControls;
        this.disableControls = disableControlsFn;
        this.enableControls = enableControlsFn;

        this.segments = new Map();       // id -> splatMesh
        this.hitboxes = new Map();       // id -> hitbox mesh
        this.originalPositions = new Map(); // id -> { hitbox: Vector3, splat: Vector3, hitboxQuat: Quaternion, splatQuat: Quaternion }

        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.tooltip = document.getElementById('tooltip');
        
        this.interactionMode = false;
        this.gizmoMode = 'translate';
        this.selectedId = null;
        
        this.setupRaycasting();
        this.setupInteractionToggle();
        this.setupSelection();
        this.setupGizmoModeToggle();
        this.setupResetButtons();
        this.setupGizmoSync();
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
        
        setTimeout(() => URL.revokeObjectURL(url), 5000);
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
        this.segments.clear();
        this.hitboxes.clear();
        this.originalPositions.clear();
    }

    // ── Manifest Loading ────────────────────────────────────────────────────
    async loadFromManifest() {
        const statusEl = document.getElementById('scene-status');
        const countEl = document.getElementById('segment-count');

        if (statusEl) statusEl.innerText = "Loading Manifest...";

        const manifest = await ManifestLoader.load();
        
        if (statusEl) statusEl.innerText = `Scene: ${manifest.scene_id}`;
        if (countEl) countEl.innerText = manifest.segments.length.toString();

        for (const segment of manifest.segments) {
            if (manifest.baseUrl) {
                const url = `${manifest.baseUrl}/${segment.file}`;
                this.loadSplatSegment(segment, url);
            } else {
                this.buildDummySegment(segment);
            }
        }
        
        const vrBtn = document.getElementById('enter-vr-btn');
        if (vrBtn) vrBtn.disabled = false;
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
        
        // Create invisible hitbox for raycasting
        const width = segment.bbox.max[0] - segment.bbox.min[0];
        const height = segment.bbox.max[1] - segment.bbox.min[1];
        const depth = segment.bbox.max[2] - segment.bbox.min[2];
        const geometry = new THREE.BoxGeometry(width, height, depth);
        const material = new THREE.MeshBasicMaterial({ 
            transparent: true, 
            opacity: 0,
            depthWrite: false 
        });
        const hitbox = new THREE.Mesh(geometry, material);

        // Flip Y and Z to match the 180° X-rotation on the SplatMesh
        hitbox.position.set(segment.centroid[0], -segment.centroid[1], -segment.centroid[2]);
        hitbox.userData = {
            id: segment.id,
            label: segment.label,
            movable: segment.movable,
            splatRef: splat  // Direct reference to the SplatMesh for movement
        };
        
        // Wireframe edges
        const edges = new THREE.EdgesGeometry(geometry);
        const color = segment.movable ? 0xef4444 : 0x3b82f6;
        const lineMat = new THREE.LineBasicMaterial({ color: color, opacity: 0.8, transparent: true });
        const line = new THREE.LineSegments(edges, lineMat);
        line.visible = this.interactionMode;
        
        hitbox.userData.edgeHelper = line;
        hitbox.userData.originalColor = color;
        hitbox.add(line);
        
        this.scene.add(hitbox);
        this.hitboxes.set(segment.id, hitbox);

        // Store original positions and rotations for reset
        this.originalPositions.set(segment.id, {
            hitbox: hitbox.position.clone(),
            splat: splat.position.clone(),
            hitboxQuat: hitbox.quaternion.clone(),
            splatQuat: splat.quaternion.clone()
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
            movable: segment.movable
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
            btn.style.backgroundColor = this.interactionMode ? '#2563eb' : '#4b5563'; // blue when ON
            
            // Toggle all hitbox visibilities
            for (const hitbox of this.hitboxes.values()) {
                if (hitbox.userData.edgeHelper) {
                    if (hitbox.userData.id === this.selectedId) continue; // skip selected
                    hitbox.userData.edgeHelper.visible = this.interactionMode;
                }
            }

            if (!this.interactionMode) {
                this.deselectObject();
            }
        });
    }

    setupGizmoModeToggle() {
        const btn = document.getElementById('toggle-gizmo-mode-btn');
        if (!btn) return;

        btn.addEventListener('click', () => {
            if (this.gizmoMode === 'translate') {
                this.gizmoMode = 'rotate';
                this.transformControls.setMode('rotate');
                btn.innerText = 'Mode: Rotate';
            } else {
                this.gizmoMode = 'translate';
                this.transformControls.setMode('translate');
                btn.innerText = 'Mode: Translate';
            }
        });
    }

    selectObject(hitbox) {
        if (!hitbox.userData.movable) return;
        
        this.deselectObject();
        this.selectedId = hitbox.userData.id;

        if (hitbox.userData.edgeHelper) {
            hitbox.userData.edgeHelper.material.color.setHex(0x22ff44);
            hitbox.userData.edgeHelper.visible = true;
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
    }

    deselectObject() {
        if (this.selectedId === null) return;

        const hitbox = this.hitboxes.get(this.selectedId);
        if (hitbox) {
            if (hitbox.userData.edgeHelper) {
                hitbox.userData.edgeHelper.material.color.setHex(hitbox.userData.originalColor);
                hitbox.userData.edgeHelper.visible = this.interactionMode;
            }
        }

        const modeBtn = document.getElementById('toggle-gizmo-mode-btn');
        if (modeBtn) modeBtn.style.display = 'none';

        const resetObjBtn = document.getElementById('reset-object-btn');
        if (resetObjBtn) resetObjBtn.style.display = 'none';

        this.transformControls.detach();
        this.selectedId = null;
    }

    setupSelection() {
        window.addEventListener('mousedown', (event) => {
            if (!this.interactionMode) return; // Only select if interaction mode is ON
            if (event.target.closest('#ui-overlay')) return; // Ignore UI clicks
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
