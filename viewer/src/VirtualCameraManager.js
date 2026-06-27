import * as THREE from 'three';
import JSZip from 'jszip';

export class VirtualCameraManager {
    constructor(scene, camera, renderer, transformControls, orbitControls) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.transformControls = transformControls;
        this.orbitControls = orbitControls;

        this.active = false;
        this.placeMode = false;
        this.pois = []; // Array of THREE.Mesh spheres
        this.previewLines = []; // Array of THREE.LineSegments

        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        // An invisible plane at Y=0 for placing initial POIs
        this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

        this.setupUI();
        this.setupInteractions();
    }

    setupUI() {
        this.vcToggleBtn = document.getElementById('toggle-vc-btn');
        this.vcPanel = document.getElementById('vc-panel');
        this.placeModeBtn = document.getElementById('vc-place-mode-btn');
        this.poiListContainer = document.getElementById('vc-poi-list');
        this.countInput = document.getElementById('vc-count');
        this.resSelect = document.getElementById('vc-res');
        this.standoffInput = document.getElementById('vc-standoff');
        this.standoffValText = document.getElementById('vc-standoff-val');
        this.previewToggle = document.getElementById('vc-preview');
        this.clearBtn = document.getElementById('vc-clear-btn');
        this.exportBtn = document.getElementById('vc-export-btn');
        this.statusText = document.getElementById('vc-status');

        if (!this.vcToggleBtn) return;

        this.vcToggleBtn.addEventListener('click', () => {
            this.active = !this.active;
            this.vcToggleBtn.style.backgroundColor = this.active ? '#2563eb' : '#4b5563';
            this.vcPanel.style.display = this.active ? 'block' : 'none';

            if (!this.active) {
                this.placeMode = false;
                this.updatePlaceModeUI();
                this.transformControls.detach();
            } else {
                const interactionBtn = document.getElementById('toggle-interaction-btn');
                if (interactionBtn && interactionBtn.innerText.includes('ON')) {
                    interactionBtn.click();
                }
            }
            this.updatePreview();
        });

        this.placeModeBtn.addEventListener('click', () => {
            this.placeMode = !this.placeMode;
            this.updatePlaceModeUI();
        });

        this.clearBtn.addEventListener('click', () => {
            this.pois.forEach(poi => {
                this.scene.remove(poi);
                poi.geometry.dispose();
                poi.material.dispose();
            });
            this.pois = [];
            this.transformControls.detach();
            this.updatePoiList();
            this.updatePreview();
        });

        this.previewToggle.addEventListener('change', () => this.updatePreview());
        this.countInput.addEventListener('change', () => this.updatePreview());
        
        if (this.standoffInput) {
            this.standoffInput.addEventListener('input', () => {
                if (this.standoffValText) this.standoffValText.innerText = `${this.standoffInput.value} units`;
                this.updatePreview();
            });
        }

        this.exportBtn.addEventListener('click', () => this.exportCameras());
    }

    updatePlaceModeUI() {
        if (!this.placeModeBtn) return;
        this.placeModeBtn.style.backgroundColor = this.placeMode ? '#2563eb' : '#4b5563';
        this.placeModeBtn.innerText = this.placeMode ? '⊕ Mode: Place Markers' : '✎ Mode: Adjust Markers';
    }

    updatePoiList() {
        if (!this.poiListContainer) return;
        
        if (this.pois.length === 0) {
            this.poiListContainer.innerHTML = '<p style="font-size: 0.8rem; color: #cbd5e1; text-align: center; margin: 5px 0;">No markers placed.</p>';
            return;
        }

        this.poiListContainer.innerHTML = '';
        this.pois.forEach((poi, index) => {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.justifyContent = 'space-between';
            row.style.alignItems = 'center';
            row.style.padding = '4px 8px';
            row.style.marginBottom = '2px';
            row.style.backgroundColor = 'rgba(255,255,255,0.05)';
            row.style.borderRadius = '3px';
            row.style.cursor = 'pointer';

            row.addEventListener('click', () => {
                this.transformControls.setMode('translate');
                this.transformControls.attach(poi);
            });

            const label = document.createElement('span');
            label.innerText = `Marker ${index + 1} (${poi.position.x.toFixed(1)}, ${poi.position.y.toFixed(1)}, ${poi.position.z.toFixed(1)})`;
            label.style.fontSize = '0.8rem';
            label.style.color = '#cbd5e1';

            // Create custom standoff distance input field
            const distInput = document.createElement('input');
            distInput.type = 'number';
            distInput.min = '0.1';
            distInput.max = '10.0';
            distInput.step = '0.1';
            distInput.placeholder = 'def';
            distInput.value = (poi.userData && poi.userData.standoff !== null) ? poi.userData.standoff : '';
            distInput.style.width = '40px';
            distInput.style.fontSize = '0.75rem';
            distInput.style.background = 'rgba(255, 255, 255, 0.1)';
            distInput.style.color = 'white';
            distInput.style.border = '1px solid #4b5563';
            distInput.style.borderRadius = '3px';
            distInput.style.padding = '1px 3px';
            distInput.style.marginLeft = '8px';
            distInput.title = 'Custom standoff distance (leave empty to use global default)';

            distInput.addEventListener('change', () => {
                const val = parseFloat(distInput.value);
                if (!isNaN(val) && val > 0) {
                    if (!poi.userData) poi.userData = {};
                    poi.userData.standoff = val;
                } else {
                    if (!poi.userData) poi.userData = {};
                    poi.userData.standoff = null;
                    distInput.value = '';
                }
                this.updatePreview();
            });
            distInput.addEventListener('click', (e) => e.stopPropagation());

            // Create alignment buttons container
            const axisContainer = document.createElement('div');
            axisContainer.style.display = 'flex';
            axisContainer.style.gap = '4px';
            axisContainer.style.marginRight = '8px';
            axisContainer.style.marginLeft = 'auto'; // push it to the right side of the row

            ['X', 'Y', 'Z'].forEach(axis => {
                const axisBtn = document.createElement('button');
                axisBtn.innerText = axis;
                axisBtn.style.backgroundColor = 'rgba(255,255,255,0.1)';
                axisBtn.style.border = 'none';
                axisBtn.style.color = 'white';
                axisBtn.style.borderRadius = '3px';
                axisBtn.style.padding = '2px 6px';
                axisBtn.style.fontSize = '0.75rem';
                axisBtn.style.cursor = 'pointer';
                axisBtn.title = `Align camera view along ${axis}-axis`;

                axisBtn.addEventListener('mouseenter', () => {
                    axisBtn.style.backgroundColor = '#3b82f6';
                });
                axisBtn.addEventListener('mouseleave', () => {
                    axisBtn.style.backgroundColor = 'rgba(255,255,255,0.1)';
                });

                axisBtn.addEventListener('click', (e) => {
                    e.stopPropagation(); // prevent row click / select object
                    
                    // Attach transform controls to this marker
                    this.transformControls.setMode('translate');
                    this.transformControls.attach(poi);
                    
                    // Align the camera
                    const distance = (poi.userData && poi.userData.standoff !== null)
                        ? poi.userData.standoff
                        : (parseFloat(this.standoffInput.value) || 2.5);
                    if (axis === 'X') {
                        this.camera.position.set(poi.position.x + distance, poi.position.y, poi.position.z);
                    } else if (axis === 'Y') {
                        // Offset by 0.0001 to prevent OrbitControls gimbal lock/flipping when looking straight down
                        this.camera.position.set(poi.position.x, poi.position.y + distance, poi.position.z + 0.0001);
                    } else if (axis === 'Z') {
                        this.camera.position.set(poi.position.x, poi.position.y, poi.position.z + distance);
                    }
                    this.camera.lookAt(poi.position);
                    
                    if (this.orbitControls) {
                        this.orbitControls.target.copy(poi.position);
                        this.orbitControls.update();
                    }
                });

                axisContainer.appendChild(axisBtn);
            });

            const delBtn = document.createElement('button');
            delBtn.innerText = '✕';
            delBtn.style.background = 'none';
            delBtn.style.border = 'none';
            delBtn.style.color = '#ef4444';
            delBtn.style.cursor = 'pointer';
            delBtn.title = 'Delete Marker';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deletePOI(index);
            });

            row.appendChild(label);
            row.appendChild(distInput);
            row.appendChild(axisContainer);
            row.appendChild(delBtn);
            this.poiListContainer.appendChild(row);
        });
    }

    deletePOI(index) {
        const poi = this.pois[index];
        if (this.transformControls.object === poi) {
            this.transformControls.detach();
        }
        this.scene.remove(poi);
        poi.geometry.dispose();
        poi.material.dispose();
        this.pois.splice(index, 1);
        this.updatePoiList();
        this.updatePreview();
    }

    setupInteractions() {
        window.addEventListener('mousedown', (event) => {
            if (!this.active) return;
            if (event.target.closest('#vc-panel') || event.target.closest('#ui-overlay')) return;
            if (this.transformControls.dragging) return;

            this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
            this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

            this.raycaster.setFromCamera(this.mouse, this.camera);

            const currentAttached = this.transformControls.object;
            const isCurrentPoi = currentAttached && this.pois.includes(currentAttached);

            // 1. Place Mode: Allow adding and switching markers freely
            if (this.placeMode) {
                const hits = this.raycaster.intersectObjects(this.pois, false);
                if (hits.length > 0) {
                    if (hits[0].object !== currentAttached) {
                        this.transformControls.setMode('translate');
                        this.transformControls.attach(hits[0].object);
                    }
                    return;
                }

                const intersectPoint = new THREE.Vector3();
                if (this.raycaster.ray.intersectPlane(this.groundPlane, intersectPoint)) {
                    this.createPOI(intersectPoint);
                }
                return;
            }

            // 2. Adjust Mode: Enforce lock to prevent accidental switching
            if (isCurrentPoi) {
                const hits = this.raycaster.intersectObjects(this.pois, false);
                if (hits.length > 0) {
                    // Selection is locked to current marker
                    return;
                }
                
                // Click empty space deselects current marker
                this.transformControls.detach();
                return;
            }

            // Select marker if none are active
            const hits = this.raycaster.intersectObjects(this.pois, false);
            if (hits.length > 0) {
                this.transformControls.setMode('translate');
                this.transformControls.attach(hits[0].object);
            }
        });

        // Update preview and camera position when dragging a POI
        this.transformControls.addEventListener('change', () => {
            if (this.active && this.transformControls.dragging && this.dragOffset && !this.isExporting) {
                const activePoi = this.transformControls.object;
                if (activePoi) {
                    this.camera.position.copy(activePoi.position).add(this.dragOffset);
                    if (this.orbitControls) {
                        this.orbitControls.target.copy(activePoi.position);
                        this.orbitControls.update();
                    }
                }
            }
            if (this.active && this.previewToggle.checked && !this.isExporting) {
                this.updatePreview();
            }
        });
        
        // Update list coordinates and drag offsets when drag starts/finishes
        this.transformControls.addEventListener('dragging-changed', (event) => {
            if (event.value) {
                const activePoi = this.transformControls.object;
                if (activePoi && this.pois.includes(activePoi)) {
                    this.dragOffset = this.camera.position.clone().sub(activePoi.position);
                } else {
                    this.dragOffset = null;
                }
            } else {
                this.dragOffset = null;
                if (this.active && !this.isExporting) {
                    this.updatePoiList();
                }
            }
        });

        // Keyboard shortcuts for X, Y, Z axis alignment
        window.addEventListener('keydown', (event) => {
            if (!this.active) return;
            
            // Ignore key events inside input elements
            if (document.activeElement && (
                document.activeElement.tagName === 'INPUT' || 
                document.activeElement.tagName === 'SELECT' || 
                document.activeElement.tagName === 'TEXTAREA'
            )) {
                return;
            }
            
            const activePoi = this.transformControls.object;
            if (!activePoi || !this.pois.includes(activePoi)) return;
            
            const key = event.key.toUpperCase();
            if (key === 'X' || key === 'Y' || key === 'Z') {
                const distance = (activePoi.userData && activePoi.userData.standoff !== null)
                    ? activePoi.userData.standoff
                    : (parseFloat(this.standoffInput.value) || 2.5);
                if (key === 'X') {
                    this.camera.position.set(activePoi.position.x + distance, activePoi.position.y, activePoi.position.z);
                } else if (key === 'Y') {
                    // Offset by 0.0001 to prevent OrbitControls gimbal lock/flipping when looking straight down
                    this.camera.position.set(activePoi.position.x, activePoi.position.y + distance, activePoi.position.z + 0.0001);
                } else if (key === 'Z') {
                    this.camera.position.set(activePoi.position.x, activePoi.position.y, activePoi.position.z + distance);
                }
                this.camera.lookAt(activePoi.position);
                
                if (this.orbitControls) {
                    this.orbitControls.target.copy(activePoi.position);
                    this.orbitControls.update();
                }
                
                // Refresh offset for dragging
                this.dragOffset = this.camera.position.clone().sub(activePoi.position);
            }
        });
    }

    createPOI(position) {
        const geometry = new THREE.SphereGeometry(0.1, 16, 16);
        const material = new THREE.MeshBasicMaterial({ color: 0xff3333, depthTest: false });
        const sphere = new THREE.Mesh(geometry, material);
        sphere.position.copy(position);
        sphere.renderOrder = 999; // Draw on top
        
        sphere.userData = {
            standoff: null
        };
        
        this.scene.add(sphere);
        this.pois.push(sphere);

        this.transformControls.setMode('translate');
        this.transformControls.attach(sphere);

        this.updatePoiList();
        this.updatePreview();
    }

    // ---------------------------------------------------------------------------
    // Math: Fibonacci Sphere Generators
    // ---------------------------------------------------------------------------
    generateUpperHemisphereFibonacci(centroid, radius, count, minElevationDeg = 10, maxElevationDeg = 45) {
        const positions = [];
        const goldenAngle = Math.PI * (1 + Math.sqrt(5)); // ≈ 137.5°

        const cosMin = Math.sin(minElevationDeg * Math.PI / 180);
        const cosMax = Math.sin(Math.min(maxElevationDeg, 89.9) * Math.PI / 180);

        for (let i = 0; i < count; i++) {
            const t = (i + 0.5) / count;
            const cosTheta = cosMin + (cosMax - cosMin) * t;
            const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
            const phi = goldenAngle * i;

            const x = centroid.x + radius * sinTheta * Math.cos(phi);
            const y = centroid.y + radius * cosTheta;
            const z = centroid.z + radius * sinTheta * Math.sin(phi);

            positions.push(new THREE.Vector3(x, y, z));
        }
        return positions;
    }

    generateSphereBandFibonacci(centroid, radius, count, minElevationDeg = -15, maxElevationDeg = 75) {
        const positions = [];
        const goldenAngle = Math.PI * (1 + Math.sqrt(5));

        const cosMin = Math.sin(minElevationDeg * Math.PI / 180);
        const cosMax = Math.sin(Math.min(maxElevationDeg, 89.9) * Math.PI / 180);

        for (let i = 0; i < count; i++) {
            const t = (i + 0.5) / count;
            const cosTheta = cosMin + (cosMax - cosMin) * t;
            const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
            const phi = goldenAngle * i;

            const x = centroid.x + radius * sinTheta * Math.cos(phi);
            const y = centroid.y + radius * cosTheta;
            const z = centroid.z + radius * sinTheta * Math.sin(phi);

            positions.push(new THREE.Vector3(x, y, z));
        }
        return positions;
    }

    buildVirtualCameraList() {
        const totalCameras = parseInt(this.countInput.value, 10) || 100;
        const globalCount = Math.round(totalCameras * 0.4);
        const closeupTotal = totalCameras - globalCount;

        const cameras = [];

        // Tier 1: Global Orbit
        let sceneCentroid = new THREE.Vector3();
        if (this.pois.length > 0) {
            this.pois.forEach(p => sceneCentroid.add(p.position));
            sceneCentroid.multiplyScalar(1 / this.pois.length);
        }

        // Estimate a global radius
        let maxDist = 2.0;
        if (this.pois.length > 0) {
            this.pois.forEach(p => {
                const d = p.position.distanceTo(sceneCentroid);
                if (d > maxDist) maxDist = d;
            });
        }
        const globalRadius = Math.max(3.0, maxDist * 2.0);

        const globalPositions = this.generateUpperHemisphereFibonacci(sceneCentroid, globalRadius, globalCount, 10, 45);
        globalPositions.forEach(pos => {
            cameras.push({ position: pos, target: sceneCentroid.clone(), tier: 'global' });
        });

        // Tier 2: POI Closeups
        if (this.pois.length > 0) {
            const perPoi = Math.floor(closeupTotal / this.pois.length);
            const defaultRadius = parseFloat(this.standoffInput ? this.standoffInput.value : 2.5);

            for (let pi = 0; pi < this.pois.length; pi++) {
                const poi = this.pois[pi];
                const radius = (poi.userData && poi.userData.standoff !== null)
                    ? poi.userData.standoff
                    : defaultRadius;
                const count = pi === this.pois.length - 1 ? closeupTotal - perPoi * pi : perPoi;
                const positions = this.generateSphereBandFibonacci(poi.position, radius, count, 5, 75);
                
                positions.forEach(pos => {
                    cameras.push({ position: pos, target: poi.position.clone(), tier: 'poi' });
                });
            }
        }

        return cameras;
    }

    // ---------------------------------------------------------------------------
    // Frustum Preview
    // ---------------------------------------------------------------------------
    updatePreview() {
        // Clear old lines
        this.previewLines.forEach(line => {
            this.scene.remove(line);
            line.geometry.dispose();
            line.material.dispose();
        });
        this.previewLines = [];

        if (!this.active || !this.previewToggle.checked) return;

        const cameras = this.buildVirtualCameraList();
        
        const [w, h] = this.resSelect.value.split('x').map(Number);
        const aspect = w / h;
        const fov = 60; // Assuming 60 deg FOV for export
        const fovRad = (fov * Math.PI) / 180;
        
        const far = 0.5; // Draw small frustums
        const hFar = 2 * Math.tan(fovRad / 2) * far;
        const wFar = hFar * aspect;

        const m = new THREE.Matrix4();
        const up = new THREE.Vector3(0, 1, 0);

        const colorGlobal = 0xffcc00; // Yellow for global
        const colorPoi = 0x33ccff;    // Cyan for POI

        cameras.forEach(cam => {
            m.lookAt(cam.position, cam.target, up);
            
            // Three.js cameras look down -Z. We need a quaternion for the frustum lines
            const quat = new THREE.Quaternion().setFromRotationMatrix(m);

            const points = [];
            const p0 = new THREE.Vector3(0, 0, 0);
            const p1 = new THREE.Vector3(-wFar / 2, hFar / 2, -far);
            const p2 = new THREE.Vector3(wFar / 2, hFar / 2, -far);
            const p3 = new THREE.Vector3(wFar / 2, -hFar / 2, -far);
            const p4 = new THREE.Vector3(-wFar / 2, -hFar / 2, -far);

            // Lines from origin to corners
            points.push(p0, p1, p0, p2, p0, p3, p0, p4);
            // Far plane rectangle
            points.push(p1, p2, p2, p3, p3, p4, p4, p1);

            const geometry = new THREE.BufferGeometry().setFromPoints(points);
            const material = new THREE.LineBasicMaterial({ 
                color: cam.tier === 'global' ? colorGlobal : colorPoi,
                transparent: true,
                opacity: 0.6
            });

            const line = new THREE.LineSegments(geometry, material);
            line.position.copy(cam.position);
            line.quaternion.copy(quat);

            this.scene.add(line);
            this.previewLines.push(line);
        });
    }

    // ---------------------------------------------------------------------------
    // Export Pipeline
    // ---------------------------------------------------------------------------
    async exportCameras() {
        if (this.pois.length === 0) {
            alert("Please place at least one Point of Interest (click on the ground) before exporting.");
            return;
        }

        let dirHandle = null;
        let useZip = false;
        try {
            if (window.showDirectoryPicker) {
                dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
            } else {
                useZip = true;
            }
        } catch (err) {
            console.warn("Directory selection cancelled or not supported, falling back to ZIP", err);
            useZip = true;
        }

        this.isExporting = true;
        this.exportBtn.disabled = true;
        this.statusText.innerText = "Initializing export...";

        let imgDir = null;
        let zip = null;
        let zipImages = null;
        if (!useZip) {
            imgDir = await dirHandle.getDirectoryHandle('images', { create: true });
        } else {
            zip = new JSZip();
            zipImages = zip.folder("images");
        }
        
        const [width, height] = this.resSelect.value.split('x').map(Number);
        const cameras = this.buildVirtualCameraList();
        const total = cameras.length;

        // Create Offscreen Render Target
        const renderTarget = new THREE.WebGLRenderTarget(width, height, {
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType
        });

        // Hide gizmos and POIs
        this.transformControls.detach();
        this.pois.forEach(p => p.visible = false);
        this.previewLines.forEach(l => l.visible = false);
        
        // Save original scene state
        const originalBg = this.scene.background;
        this.scene.background = new THREE.Color(0xffffff); // White background for YOLO/SAM

        // Canvas for PNG encoding
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(width, height);

        const cameraEntries = [];
        
        // Setup the export camera
        const exportCam = new THREE.PerspectiveCamera(60, width / height, 0.1, 100);

        try {
            for (let i = 0; i < total; i++) {
                this.statusText.innerText = `Rendering ${i + 1} / ${total}...`;
                const vc = cameras[i];

                exportCam.position.copy(vc.position);
                exportCam.lookAt(vc.target);
                exportCam.updateMatrixWorld();

                // 1. Render once to trigger the async splat sorting worker
                this.renderer.setRenderTarget(renderTarget);
                this.renderer.render(this.scene, exportCam);
                
                // 2. Yield the main thread to allow the WebWorker to finish sorting
                // 100ms is a safe, robust duration that ensures the worker completes 
                // even on slower machines, without needing internal API hooks.
                await new Promise(resolve => setTimeout(resolve, 100));

                // 3. Render a second time to draw the newly sorted splats
                this.renderer.render(this.scene, exportCam); 

                // Read pixels
                const buffer = new Uint8Array(width * height * 4);
                this.renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, buffer);

                // Create ImageData from WebGL buffer
                const rawImgData = new ImageData(new Uint8ClampedArray(buffer), width, height);

                // Draw to offscreen canvas to flip Y and composite over white
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = width;
                tempCanvas.height = height;
                tempCanvas.getContext('2d').putImageData(rawImgData, 0, 0);

                // Fill main canvas with solid white, then draw WebGL pixels over it flipped
                ctx.fillStyle = "white";
                ctx.fillRect(0, 0, width, height);
                ctx.save();
                ctx.translate(0, height);
                ctx.scale(1, -1);
                ctx.drawImage(tempCanvas, 0, 0);
                ctx.restore();

                // Compress to PNG Blob
                const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                
                // Write to file or ZIP
                const imgName = `${String(i).padStart(5, '0')}.png`;
                if (!useZip) {
                    const fileHandle = await imgDir.getFileHandle(imgName, { create: true });
                    const writable = await fileHandle.createWritable();
                    await writable.write(blob);
                    await writable.close();
                } else {
                    zipImages.file(imgName, blob);
                }

                // Build OpenCV cameras.json entry
                // focal length = (height / 2) / tan(fov/2)
                const fovRad = (60 * Math.PI) / 180;
                const fy = (height / 2) / Math.tan(fovRad / 2);
                const fx = fy;

                // Extrinsics: camera-to-world rotation for the carver
                const vm = exportCam.matrixWorldInverse.elements; 
                // Three.js stores matrices column-major: element index = col*4 + row
                //
                // R_c2w_three (camera-to-world in Three.js space) is the transpose of
                // the upper-left 3x3 of matrixWorldInverse:
                //   [[vm[0], vm[1], vm[2]],
                //    [vm[4], vm[5], vm[6]],
                //    [vm[8], vm[9], vm[10]]]
                //
                // Two corrections needed:
                //   1. PLY→Three.js: SplatMesh rotated 180° on X → M = diag(1,-1,-1)
                //      Multiply R_c2w on the RIGHT by M (negate cols 1,2)
                //   2. Three.js camera→OpenCV camera: y-up/z-back → y-down/z-forward
                //      Multiply R_c2w on the LEFT by M (negate rows 1,2)
                //
                // Combined: rotation = M * R_c2w_three * M
                const rotation = [
                    [ vm[0], -vm[1], -vm[2]],
                    [-vm[4],  vm[5],  vm[6]],
                    [-vm[8],  vm[9],  vm[10]]
                ];

                cameraEntries.push({
                    id: i,
                    img_name: imgName,
                    width: width,
                    height: height,
                    // Negate Y and Z to convert from Three.js world space back to original PLY space
                    position: [exportCam.position.x, -exportCam.position.y, -exportCam.position.z],
                    rotation: rotation,
                    fx: fx,
                    fy: fy
                });
            }

            // Write cameras.json
            this.statusText.innerText = "Writing cameras.json...";
            const jsonStr = JSON.stringify(cameraEntries, null, 2);
            if (!useZip) {
                const jsonHandle = await dirHandle.getFileHandle('cameras.json', { create: true });
                const jsonWritable = await jsonHandle.createWritable();
                await jsonWritable.write(jsonStr);
                await jsonWritable.close();
                this.statusText.innerText = `Export complete! Saved to selected folder.`;
            } else {
                zip.file("cameras.json", jsonStr);
                this.statusText.innerText = "Zipping files...";
                const zipBlob = await zip.generateAsync({ type: "blob" });
                const url = URL.createObjectURL(zipBlob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "virtual_cameras.zip";
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                }, 100);
                this.statusText.innerText = `Export complete! Downloaded ZIP.`;
            }

        } catch (err) {
            console.error(err);
            this.statusText.innerText = `Error: ${err.message}`;
        } finally {
            // Restore state
            this.renderer.setRenderTarget(null);
            this.scene.background = originalBg;
            this.pois.forEach(p => p.visible = true);
            this.updatePreview(); // restores preview lines based on toggle
            
            this.isExporting = false;
            this.exportBtn.disabled = false;
        }
    }
}
