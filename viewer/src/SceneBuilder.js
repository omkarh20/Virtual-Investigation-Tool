import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
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
        this.selectedId = null;

        // Alignment mode properties
        this.alignmentDummy = new THREE.Object3D();
        this.scene.add(this.alignmentDummy);
        this.prevDummyQuaternion = new THREE.Quaternion();
        this.isAligning = false;

        // Interactive mini-gizmo for whole scene rotation
        this.alignContainer = document.createElement('div');
        this.alignContainer.id = 'alignment-gizmo-container';
        this.alignContainer.style.position = 'absolute';
        this.alignContainer.style.right = '20px';
        this.alignContainer.style.top = '20px';
        this.alignContainer.style.width = '220px';
        this.alignContainer.style.height = '220px';
        this.alignContainer.style.zIndex = '1000';
        this.alignContainer.style.borderRadius = '50%';
        this.alignContainer.style.background = 'rgba(15, 23, 42, 0.65)';
        this.alignContainer.style.backdropFilter = 'blur(4px)';
        this.alignContainer.style.border = '1px solid rgba(255, 255, 255, 0.15)';
        this.alignContainer.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.5)';
        this.alignContainer.style.display = 'none';
        this.alignContainer.style.pointerEvents = 'auto';
        document.body.appendChild(this.alignContainer);

        // Setup mini scene, camera, renderer
        this.alignScene = new THREE.Scene();
        this.alignRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.alignRenderer.setSize(220, 220);
        this.alignRenderer.setPixelRatio(window.devicePixelRatio);
        this.alignContainer.appendChild(this.alignRenderer.domElement);

        this.alignCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
        this.alignCamera.position.set(0, 0, 2.5);

        // Mini sphere representing the scene rotation
        const sphereGeo = new THREE.SphereGeometry(0.35, 16, 16);
        const sphereMat = new THREE.MeshStandardMaterial({ 
            color: 0x6366f1, 
            wireframe: true,
            transparent: true,
            opacity: 0.8
        });
        this.alignDummySphere = new THREE.Mesh(sphereGeo, sphereMat);
        this.alignScene.add(this.alignDummySphere);

        // Simple lighting for shaded appearance if wireframe isn't enough
        const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
        dirLight.position.set(1, 2, 1);
        this.alignScene.add(dirLight);
        this.alignScene.add(new THREE.AmbientLight(0xffffff, 0.4));

        // Setup mini transform controls for the sphere
        this.alignControls = new TransformControls(this.alignCamera, this.alignRenderer.domElement);
        this.alignControls.setMode('rotate');
        this.alignControls.setSize(1.0);
        this.alignScene.add(this.alignControls.getHelper());
        this.alignControls.attach(this.alignDummySphere);

        this.alignControls.addEventListener('objectChange', () => {
            if (!this.isAligning) return;
            const currentQuat = this.alignDummySphere.quaternion;
            const prevQuatInv = this.prevDummyQuaternion.clone().invert();
            const deltaQuat = currentQuat.clone().multiply(prevQuatInv);
            
            this.applyAlignmentRotation(deltaQuat);
            
            this.prevDummyQuaternion.copy(currentQuat);
        });

        this.alignControls.addEventListener('dragging-changed', (event) => {
            if (event.value) {
                this.disableControls();
                this.prevDummyQuaternion.copy(this.alignDummySphere.quaternion);
            } else {
                this.enableControls();
                this.alignDummySphere.quaternion.set(0, 0, 0, 1);
                this.prevDummyQuaternion.set(0, 0, 0, 1);
            }
        });
        
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
        const host = window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname;
        const BACKEND_URL = `http://${host}:8000`;
        const BACKEND_WS = `ws://${host}:8000`;

        if (statusEl) statusEl.innerText = "Uploading PLY file to backend server...";

        try {
            const formData = new FormData();
            formData.append("file", file);
            
            const response = await fetch(`${BACKEND_URL}/mesh-ply`, {
                method: "POST",
                body: formData
            });
            
            if (!response.ok) {
                throw new Error("Pipeline execution failed on server");
            }
            
            const data = await response.json();
            const jobId = data.job_id;
            
            if (statusEl) statusEl.innerText = "Reconstructing mesh: starting backend pipeline...";

            // Connect to WebSocket to track reconstruction progress
            const ws = new WebSocket(`${BACKEND_WS}/progress/${jobId}`);
            
            ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.type === 'log') {
                    if (statusEl) {
                        statusEl.innerText = `Reconstructing: [${msg.progress}%] ${msg.text}`;
                    }
                } else if (msg.type === 'step_end' && msg.step === 5) {
                    let manifestUrl = msg.manifest_url;
                    
                    // Normalize manifest_url loopback to prevent connection refusal in browser
                    if (manifestUrl && manifestUrl.includes('localhost:8000')) {
                        manifestUrl = manifestUrl.replace('localhost:8000', '127.0.0.1:8000');
                    }
                    
                    sessionStorage.setItem('vit_manifest_url', manifestUrl);
                    if (statusEl) statusEl.innerText = `Reconstructed successfully: ${file.name}`;
                    
                    ws.close();
                    
                    // Trigger loading of the actual scene and collision boundaries!
                    this.loadFromManifest();
                }
            };

            ws.onerror = (err) => {
                console.error("WebSocket connection error:", err);
                if (statusEl) statusEl.innerText = "Error: Connection lost during meshing.";
            };

            ws.onclose = () => {
                console.log("WebSocket closed for job:", jobId);
            };
            
        } catch (error) {
            console.warn("Backend meshing pipeline failed, falling back to local preview:", error);
            if (statusEl) statusEl.innerText = `Local Preview: ${file.name} (No mesh colliders)`;
            
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

            if (countEl) countEl.innerText = this.segments.size.toString();
            
            const alignPanel = document.querySelector('.scene-align-panel');
            if (alignPanel) alignPanel.style.display = 'block';
            this.startAlignmentMode();
            
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        }
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

        const startTime = performance.now();
        const loadPromises = [];

        for (const segment of manifest.segments) {
            if (manifest.baseUrl) {
                const url = `${manifest.baseUrl}/${segment.file}`;
                loadPromises.push(this.loadSplatSegment(segment, url));
            } else {
                this.buildDummySegment(segment);
            }
        }

        if (loadPromises.length > 0) {
            if (statusEl) statusEl.innerText = "Loading 3D assets...";
            await Promise.all(loadPromises);
        }

        const endTime = performance.now();
        const elapsedSeconds = ((endTime - startTime) / 1000).toFixed(2);
        if (statusEl) {
            statusEl.innerText = `Scene: ${manifest.scene_id} (Loaded in ${elapsedSeconds}s)`;
        }
        
        const vrBtn = document.getElementById('enter-vr-btn');
        if (vrBtn) vrBtn.disabled = false;

        const alignPanel = document.querySelector('.scene-align-panel');
        if (alignPanel) alignPanel.style.display = 'block';
        this.startAlignmentMode();
    }

    // ── Splat Segment Loading ───────────────────────────────────────────────
    loadSplatSegment(segment, url) {
        const splat = new SplatMesh({ url: url });
        splat.quaternion.set(1, 0, 0, 0);

        splat.userData = {
            id: segment.id,
            label: segment.label,
            movable: segment.movable
        };

        this.scene.add(splat);
        this.segments.set(segment.id, splat);
        
        const color = 0xef4444;
        const glbUrl = url.replace(segment.file, segment.collision);
        const loader = new GLTFLoader();

        return new Promise((resolve) => {
            loader.load(glbUrl, (gltf) => {
                let mesh = null;
                gltf.scene.traverse((child) => {
                    if (child.isMesh && !mesh) mesh = child;
                });
                if (!mesh) {
                    resolve();
                    return;
                }

                const geometry = mesh.geometry;
                // Shift vertices so the mesh origin is at the centroid
                geometry.translate(-segment.centroid[0], -segment.centroid[1], -segment.centroid[2]);

                const material = new THREE.MeshBasicMaterial({ 
                    color: color, 
                    wireframe: false,
                    transparent: true,
                    opacity: 0.3,    
                    depthWrite: false, 
                    visible: this.interactionMode,
                    side: THREE.DoubleSide
                });
                const hitbox = new THREE.Mesh(geometry, material);

                // Place the mesh at the flipped centroid and apply the 180 deg X rotation
                hitbox.position.set(segment.centroid[0], -segment.centroid[1], -segment.centroid[2]);
                hitbox.quaternion.set(1, 0, 0, 0);

                hitbox.userData = {
                    id: segment.id,
                    label: segment.label,
                    movable: segment.movable,
                    splatRef: splat
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
                resolve();
            }, undefined, (error) => {
                console.error("Error loading collision GLB:", error);
                resolve();
            });
        });
    }

    // ── Dummy Segments (fallback) ───────────────────────────────────────────
    buildDummySegment(segment) {
        const width = segment.bbox.max[0] - segment.bbox.min[0];
        const height = segment.bbox.max[1] - segment.bbox.min[1];
        const depth = segment.bbox.max[2] - segment.bbox.min[2];

        const geometry = new THREE.BoxGeometry(width, height, depth);
        
        const color = 0xef4444;
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
                    hitbox.material.opacity = this.interactionMode ? 0.3 : 0.0;
                }
            }

            if (this.interactionMode && this.isAligning) {
                this.endAlignmentMode();
                const alignPanel = document.querySelector('.scene-align-panel');
                if (alignPanel) alignPanel.style.display = 'none';
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
            hitbox.material.color.setHex(0x22ff44);
            hitbox.material.opacity = 0.3;
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
                hitbox.userData.edgeHelper.visible = this.interactionMode;
                hitbox.material.color.setHex(hitbox.userData.originalColor);
                hitbox.material.opacity = this.interactionMode ? 0.3 : 0.0;
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
            if (this.isAligning && this.transformControls.object === this.alignmentDummy) {
                const currentQuat = this.alignmentDummy.quaternion;
                const prevQuatInv = this.prevDummyQuaternion.clone().invert();
                const deltaQuat = currentQuat.clone().multiply(prevQuatInv);
                
                this.applyAlignmentRotation(deltaQuat);
                
                this.prevDummyQuaternion.copy(currentQuat);
                return;
            }

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
                if (this.isAligning && this.transformControls.object === this.alignmentDummy) {
                    this.prevDummyQuaternion.copy(this.alignmentDummy.quaternion);
                }
            } else {
                this.enableControls();
                if (this.isAligning && this.transformControls.object === this.alignmentDummy) {
                    this.alignmentDummy.quaternion.set(0, 0, 0, 1);
                    this.prevDummyQuaternion.set(0, 0, 0, 1);
                }
            }
        });
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

        const alignPanel = document.querySelector('.scene-align-panel');
        if (alignPanel) alignPanel.style.display = 'block';
        this.startAlignmentMode();
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

    setVirtualCameraManager(vcManager) {
        this.vcManager = vcManager;
    }

    createCollisionMeshForLocalSplat() {
        if (this.segments.size === 0) return;
        
        // Find the local splat (there should be only one for local file)
        const splat = Array.from(this.segments.values())[0];
        if (!splat) return;

        // Compute bounding box
        let bbox = null;
        if (typeof splat.getBoundingBox === 'function') {
            bbox = splat.getBoundingBox();
        } else if (splat.geometry) {
            splat.geometry.computeBoundingBox();
            bbox = splat.geometry.boundingBox;
        }

        if (bbox) {
            const size = new THREE.Vector3();
            bbox.getSize(size);
            const center = new THREE.Vector3();
            bbox.getCenter(center);

            // Create hitbox mesh (invisible solid container or visible wireframe room)
            const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
            const material = new THREE.MeshBasicMaterial({
                color: 0x3b82f6,
                wireframe: false,
                transparent: true,
                opacity: 0.15,
                depthWrite: false,
                visible: window.roomMeshVisible || false,
                side: THREE.DoubleSide
            });
            const hitbox = new THREE.Mesh(geometry, material);
            
            // Apply splat transformation
            hitbox.position.copy(center);
            hitbox.quaternion.copy(splat.quaternion);
            hitbox.position.applyQuaternion(splat.quaternion).add(splat.position);

            hitbox.userData = {
                id: splat.userData.id,
                label: splat.userData.label,
                movable: false,
                splatRef: splat
            };

            // Setup wireframe helper
            const edges = new THREE.EdgesGeometry(geometry);
            const lineMat = new THREE.LineBasicMaterial({ color: 0x3b82f6, opacity: 0.8, transparent: true });
            const line = new THREE.LineSegments(edges, lineMat);
            line.visible = window.roomMeshVisible || false;
            hitbox.userData.edgeHelper = line;
            hitbox.userData.originalColor = 0x3b82f6;
            hitbox.add(line);

            this.scene.add(hitbox);
            this.hitboxes.set(splat.userData.id, hitbox);

            // Register with physics engine to build floor/walls
            if (this.physicsManager) {
                this.physicsManager.createBodyFromMesh(splat.userData.id, hitbox, false);
            }

            // Save original positions
            this.originalPositions.set(splat.userData.id, {
                hitbox: hitbox.position.clone(),
                splat: splat.position.clone(),
                hitboxQuat: hitbox.quaternion.clone(),
                splatQuat: splat.quaternion.clone()
            });

            console.log("Created local collision room bounds for:", splat.userData.label);
        }
    }

    startAlignmentMode() {
        this.deselectObject();
        this.isAligning = true;
        this.alignmentDummy.position.set(0, 0, 0);
        this.alignmentDummy.quaternion.set(0, 0, 0, 1);
        this.prevDummyQuaternion.set(0, 0, 0, 1);

        if (this.onAlignmentStart) this.onAlignmentStart();
        
        // Setup mini alignment gizmo
        this.alignDummySphere.quaternion.set(0, 0, 0, 1);
        this.alignContainer.style.display = 'block';

        // Turn off interaction mode to avoid collision/selection conflicts
        this.interactionMode = false;
        const interactionBtn = document.getElementById('toggle-interaction-btn');
        if (interactionBtn) {
            interactionBtn.innerText = 'Interaction: OFF';
            interactionBtn.style.backgroundColor = '#4b5563';
        }
        for (const hitbox of this.hitboxes.values()) {
            if (hitbox.userData.edgeHelper) {
                hitbox.userData.edgeHelper.visible = false;
                hitbox.material.opacity = 0.0;
            }
        }

        // Detach main controls from scene objects during alignment
        this.transformControls.detach();
    }

    endAlignmentMode() {
        if (this.isAligning) {
            this.isAligning = false;
            this.alignContainer.style.display = 'none';
        }
    }

    applyAlignmentRotation(q) {
        // Rotate all splats
        for (const splat of this.segments.values()) {
            splat.position.applyQuaternion(q);
            splat.quaternion.premultiply(q);
            splat.updateMatrixWorld();
        }

        // Rotate all hitboxes
        for (const hitbox of this.hitboxes.values()) {
            hitbox.position.applyQuaternion(q);
            hitbox.quaternion.premultiply(q);
            hitbox.updateMatrixWorld();

            // Sync physics bodies
            if (this.physicsManager) {
                this.physicsManager.updateBodyTransform(hitbox.userData.id, hitbox.position, hitbox.quaternion);
            }
        }

        // Update originalPositions too so they reset/sync correctly
        for (const [id, orig] of this.originalPositions.entries()) {
            orig.hitbox.applyQuaternion(q);
            orig.hitboxQuat.premultiply(q);
            orig.splat.applyQuaternion(q);
            orig.splatQuat.premultiply(q);
        }

        // Also rotate POIs if vcManager exists
        if (this.vcManager) {
            this.vcManager.pois.forEach(poi => {
                poi.position.applyQuaternion(q);
                poi.updateMatrixWorld();
            });
            this.vcManager.updatePreview();
            this.vcManager.updatePoiList();
        }
    }

    rotateScene(axisName, angle) {
        this.deselectObject();

        const axis = new THREE.Vector3();
        if (axisName === 'x') axis.set(1, 0, 0);
        else if (axisName === 'y') axis.set(0, 1, 0);
        else if (axisName === 'z') axis.set(0, 0, 1);

        const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
        this.applyAlignmentRotation(q);
    }

    renderAlignmentGizmo() {
        if (!this.isAligning) return;
        this.alignCamera.quaternion.copy(this.camera.quaternion);
        this.alignCamera.position.set(0, 0, 2.5).applyQuaternion(this.camera.quaternion);
        this.alignCamera.lookAt(0, 0, 0);
        this.alignRenderer.render(this.alignScene, this.alignCamera);
    }
}

