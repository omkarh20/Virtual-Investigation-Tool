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

        this.pendingSegmentRay = null;
        this.pendingRayLine = null;

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
            this.cancelPendingSegmentation();
            this.updatePoiList();
            this.updatePreview();
        });

        this.previewToggle.addEventListener('change', () => {
            const state = this.previewToggle.checked;
            this.pois.forEach(poi => {
                if (!poi.userData) poi.userData = {};
                poi.userData.showFrustums = state;
            });
            this.updatePoiList(); // update the individual checkboxes
            this.updatePreview();
        });
        
        this.countInput.addEventListener('change', () => {
            this.recalculateCameraCounts(false); // distribute delta
            this.updatePoiList();
            this.updatePreview();
        });

        this.distributeBtn = document.getElementById('vc-distribute-btn');
        if (this.distributeBtn) {
            this.distributeBtn.addEventListener('click', () => {
                this.recalculateCameraCounts(true); // force equal
                this.updatePoiList();
                this.updatePreview();
            });
        }

        this.exportBtn.addEventListener('click', () => this.exportCameras());

        this.segmentThisBtn = document.getElementById('vc-segment-this-btn');
        if (this.segmentThisBtn) {
            this.segmentThisBtn.addEventListener('click', () => this.autoSegmentCurrentView());
        }
    }

    recalculateCameraCounts(distributeEqually = false) {
        if (this.pois.length === 0) return;
        
        let newTotal = parseInt(this.countInput.value, 10) || 0;
        if (newTotal < 1) newTotal = 1;
        
        let currentTotal = 0;
        this.pois.forEach(p => {
            currentTotal += (p.userData.cameraCount || 0);
        });

        if (distributeEqually) {
            const perPoi = Math.floor(newTotal / this.pois.length);
            let currentSum = 0;
            this.pois.forEach((poi, index) => {
                let count = (index === this.pois.length - 1) ? newTotal - currentSum : perPoi;
                poi.userData.cameraCount = Math.max(1, count);
                currentSum += poi.userData.cameraCount;
            });
            this.countInput.value = currentSum;
        } else {
            let delta = newTotal - currentTotal;
            if (delta === 0) {
                // Ensure no marker has 0 cameras
                this.pois.forEach(poi => {
                    if ((poi.userData.cameraCount || 0) === 0) {
                        poi.userData.cameraCount = 1;
                        newTotal += 1;
                    }
                });
                if (newTotal !== currentTotal) {
                    this.countInput.value = newTotal;
                }
                return;
            }

            let remainingDelta = delta;
            let iter = 0;
            while (remainingDelta !== 0 && iter < 10) {
                iter++;
                let activePois = this.pois.filter(p => remainingDelta > 0 || p.userData.cameraCount > 1);
                if (activePois.length === 0) break; 
                
                let perPoiDelta = Math.trunc(remainingDelta / activePois.length);
                if (perPoiDelta === 0) perPoiDelta = Math.sign(remainingDelta);

                let deltaApplied = 0;
                for (let i = 0; i < activePois.length; i++) {
                    if (remainingDelta === 0) break;
                    let poi = activePois[i];
                    let apply = perPoiDelta;
                    
                    if (perPoiDelta !== 1 && perPoiDelta !== -1 && i === activePois.length - 1) {
                        apply = remainingDelta;
                    }
                    
                    let newCount = poi.userData.cameraCount + apply;
                    if (newCount < 1) {
                        apply = 1 - poi.userData.cameraCount;
                        poi.userData.cameraCount = 1;
                    } else {
                        poi.userData.cameraCount = newCount;
                    }
                    
                    deltaApplied += apply;
                    remainingDelta -= apply;
                }
                if (deltaApplied === 0) break;
            }
            
            // Re-sum to ensure exact match
            let finalSum = 0;
            this.pois.forEach(p => finalSum += p.userData.cameraCount);
            this.countInput.value = finalSum;
        }
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
            const isSelected = this.transformControls.object === poi;

            const container = document.createElement('div');
            container.style.backgroundColor = isSelected ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)';
            container.style.borderRadius = '3px';
            container.style.marginBottom = '4px';

            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.justifyContent = 'space-between';
            row.style.alignItems = 'center';
            row.style.padding = '4px 8px';
            row.style.cursor = 'pointer';

            row.addEventListener('click', () => {
                if (!isSelected) {
                    this.transformControls.setMode('translate');
                    this.transformControls.attach(poi);
                    this.updatePoiList();
                }
            });

            const label = document.createElement('span');
            label.innerText = `Marker ${index + 1} (${poi.position.x.toFixed(1)}, ${poi.position.y.toFixed(1)}, ${poi.position.z.toFixed(1)})`;
            label.style.fontSize = '0.8rem';
            label.style.color = '#cbd5e1';

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
            row.appendChild(delBtn);
            container.appendChild(row);

            // Create the slider below the marker if selected
            if (isSelected) {
                const sliderContainer = document.createElement('div');
                sliderContainer.style.padding = '0 8px 8px 8px';

                const sliderLabel = document.createElement('div');
                sliderLabel.style.display = 'flex';
                sliderLabel.style.justifyContent = 'space-between';
                sliderLabel.style.fontSize = '0.75rem';
                sliderLabel.style.color = '#cbd5e1';
                
                const currentDist = (poi.userData && poi.userData.standoff !== null) ? poi.userData.standoff : 2.5;
                const distValueSpan = document.createElement('span');
                distValueSpan.innerText = `${currentDist.toFixed(1)} units`;

                sliderLabel.innerHTML = `<span>Standoff Dist:</span>`;
                sliderLabel.appendChild(distValueSpan);

                const rangeInput = document.createElement('input');
                rangeInput.type = 'range';
                rangeInput.min = '0.5';
                rangeInput.max = '10.0';
                rangeInput.step = '0.1';
                rangeInput.value = currentDist;
                rangeInput.style.width = '100%';
                rangeInput.style.marginTop = '4px';

                rangeInput.addEventListener('input', (e) => {
                    e.stopPropagation();
                    const val = parseFloat(rangeInput.value);
                    if (!poi.userData) poi.userData = {};
                    poi.userData.standoff = val;
                    distValueSpan.innerText = `${val.toFixed(1)} units`;
                    this.updatePreview();
                });
                
                // Prevent drag/click events on the slider from re-triggering row selection
                rangeInput.addEventListener('mousedown', (e) => e.stopPropagation());
                rangeInput.addEventListener('click', (e) => e.stopPropagation());

                sliderContainer.appendChild(sliderLabel);
                sliderContainer.appendChild(rangeInput);

                // --- Camera Count Input ---
                const countContainer = document.createElement('div');
                countContainer.style.display = 'flex';
                countContainer.style.justifyContent = 'space-between';
                countContainer.style.alignItems = 'center';
                countContainer.style.fontSize = '0.75rem';
                countContainer.style.color = '#cbd5e1';
                countContainer.style.marginTop = '8px';
                
                const countLabel = document.createElement('span');
                countLabel.innerText = 'Cameras:';
                
                const countInputBox = document.createElement('input');
                countInputBox.type = 'number';
                countInputBox.min = '1';
                countInputBox.max = '1000';
                countInputBox.value = poi.userData.cameraCount || 0;
                countInputBox.style.width = '60px';
                countInputBox.style.backgroundColor = 'rgba(0,0,0,0.3)';
                countInputBox.style.border = '1px solid #4b5563';
                countInputBox.style.color = 'white';
                countInputBox.style.padding = '2px 4px';
                countInputBox.style.borderRadius = '3px';

                countInputBox.addEventListener('change', (e) => {
                    e.stopPropagation();
                    let val = parseInt(countInputBox.value, 10) || 0;
                    if (val < 0) val = 0;
                    poi.userData.cameraCount = val;
                    
                    // Update global total dynamically
                    let newTotal = 0;
                    this.pois.forEach(p => {
                        newTotal += p.userData.cameraCount || 0;
                    });
                    this.countInput.value = newTotal;
                    
                    this.updatePreview();
                });
                
                countInputBox.addEventListener('mousedown', (e) => e.stopPropagation());
                countInputBox.addEventListener('click', (e) => e.stopPropagation());
                countInputBox.addEventListener('keydown', (e) => e.stopPropagation());

                countContainer.appendChild(countLabel);
                countContainer.appendChild(countInputBox);
                sliderContainer.appendChild(countContainer);

                // --- Preview Frustums Checkbox ---
                const previewContainer = document.createElement('div');
                previewContainer.style.display = 'flex';
                previewContainer.style.justifyContent = 'space-between';
                previewContainer.style.alignItems = 'center';
                previewContainer.style.fontSize = '0.75rem';
                previewContainer.style.color = '#cbd5e1';
                previewContainer.style.marginTop = '8px';
                
                const previewLabel = document.createElement('span');
                previewLabel.innerText = 'Show Frustums:';
                
                const previewCheckbox = document.createElement('input');
                previewCheckbox.type = 'checkbox';
                previewCheckbox.checked = poi.userData.showFrustums !== false;

                previewCheckbox.addEventListener('change', (e) => {
                    e.stopPropagation();
                    poi.userData.showFrustums = previewCheckbox.checked;
                    this.updatePreview();
                });
                
                previewCheckbox.addEventListener('mousedown', (e) => e.stopPropagation());
                previewCheckbox.addEventListener('click', (e) => e.stopPropagation());

                previewContainer.appendChild(previewLabel);
                previewContainer.appendChild(previewCheckbox);
                sliderContainer.appendChild(previewContainer);

                container.appendChild(sliderContainer);
            }

            this.poiListContainer.appendChild(container);
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
        
        // Just update total UI, don't redistribute remaining!
        let newTotal = 0;
        this.pois.forEach(p => newTotal += p.userData.cameraCount);
        this.countInput.value = newTotal;
        
        this.updatePoiList();
        this.updatePreview();
    }

    setupInteractions() {
        let pointerDownPos = { x: 0, y: 0 };

        window.addEventListener('pointerdown', (event) => {
            if (!this.active) return;
            pointerDownPos.x = event.clientX;
            pointerDownPos.y = event.clientY;
        });

        window.addEventListener('pointerup', (event) => {
            if (!this.active) return;
            
            // Check if it was a drag (moved more than 3 pixels)
            const dx = event.clientX - pointerDownPos.x;
            const dy = event.clientY - pointerDownPos.y;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                return; // It was a drag (e.g. orbiting), ignore for selection
            }

            if (event.target.closest('#vc-panel') || event.target.closest('#ui-overlay')) return;
            if (this.transformControls.dragging) return;

            // Ignore clicks in the bottom-right 128x128 area (ViewHelper gizmo)
            const rect = this.renderer.domElement.getBoundingClientRect();
            const clickX = event.clientX - rect.left;
            const clickY = event.clientY - rect.top;
            if (clickX > rect.width - 128 && clickY > rect.height - 128) {
                return;
            }

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
                        this.updatePoiList();
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
                this.updatePoiList();
                return;
            }

            // Select marker if none are active
            const hits = this.raycaster.intersectObjects(this.pois, false);
            if (hits.length > 0) {
                this.transformControls.setMode('translate');
                this.transformControls.attach(hits[0].object);
                this.updatePoiList();
            }
        });

        // Update preview when dragging a POI
        this.transformControls.addEventListener('change', () => {
            if (this.active && this.previewToggle.checked && !this.isExporting) {
                this.updatePreview();
            }
        });
        
        // Update list coordinates and camera target when drag finishes
        this.transformControls.addEventListener('dragging-changed', (event) => {
            if (!event.value) {
                if (this.active && !this.isExporting) {
                    this.updatePoiList();
                    const activePoi = this.transformControls.object;
                    if (activePoi && this.orbitControls) {
                        this.orbitControls.target.copy(activePoi.position);
                        this.orbitControls.update();
                    }
                }
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
            standoff: null,
            cameraCount: 50,
            showFrustums: true
        };
        this.scene.add(sphere);
        this.pois.push(sphere);

        // Update total UI by appending the new marker's cameras
        let newTotal = 0;
        this.pois.forEach(p => newTotal += p.userData.cameraCount);
        this.countInput.value = newTotal;

        this.transformControls.setMode('translate');
        this.transformControls.attach(sphere);

        this.updatePoiList();
        this.updatePreview();
    }

    cancelPendingSegmentation() {
        this.pendingSegmentRay = null;
        if (this.pendingRayLine) {
            this.scene.remove(this.pendingRayLine);
            this.pendingRayLine.geometry.dispose();
            this.pendingRayLine.material.dispose();
            this.pendingRayLine = null;
        }
    }

    calculateRayIntersection(ray1, ray2) {
        const p1 = ray1.origin, d1 = ray1.direction;
        const p2 = ray2.origin, d2 = ray2.direction;
        
        const w0 = new THREE.Vector3().subVectors(p1, p2);
        
        const a = d1.dot(d1);
        const b = d1.dot(d2);
        const c = d2.dot(d2);
        const d = d1.dot(w0);
        const e = d2.dot(w0);
        
        const D = a * c - b * b;
        let sc, tc;
        
        if (D < 1e-6) {
            sc = 0;
            tc = d / b; 
        } else {
            sc = (b * e - c * d) / D;
            tc = (a * e - b * d) / D;
        }
        
        const pA = new THREE.Vector3().copy(d1).multiplyScalar(sc).add(p1);
        const pB = new THREE.Vector3().copy(d2).multiplyScalar(tc).add(p2);
        
        return new THREE.Vector3().addVectors(pA, pB).multiplyScalar(0.5);
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
        const cameras = [];

        // POI Closeups Only
        if (this.pois.length > 0) {
            const defaultRadius = 2.5;

            for (let pi = 0; pi < this.pois.length; pi++) {
                const poi = this.pois[pi];
                const radius = (poi.userData && poi.userData.standoff !== null)
                    ? poi.userData.standoff
                    : defaultRadius;
                
                const count = poi.userData.cameraCount || 0;
                
                if (count > 0) {
                    const positions = this.generateSphereBandFibonacci(poi.position, radius, count, 5, 75);
                    
                    positions.forEach(pos => {
                        cameras.push({ position: pos, target: poi.position.clone(), tier: 'poi', poi: poi });
                    });
                }
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

        // We no longer abort early if previewToggle is unchecked, because 
        // individual markers might have showFrustums=true overriding it (though 
        // they are normally synced when the global toggle is clicked).
        if (!this.active) return;

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
            if (cam.poi && cam.poi.userData.showFrustums === false) return;

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
                    [vm[0], -vm[1], -vm[2]],
                    [-vm[4], vm[5], vm[6]],
                    [-vm[8], vm[9], vm[10]]
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

    async autoSegmentCurrentView() {
        this.statusText.innerText = "Capturing view for segmentation...";
        this.segmentThisBtn.disabled = true;
        
        const [width, height] = this.resSelect.value.split('x').map(Number);
        
        // Hide gizmos and POIs
        this.transformControls.detach();
        this.pois.forEach(p => p.visible = false);
        this.previewLines.forEach(l => l.visible = false);
        
        const originalBg = this.scene.background;
        this.scene.background = new THREE.Color(0xffffff);

        // Render to offscreen canvas
        const renderTarget = new THREE.WebGLRenderTarget(width, height, {
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType
        });

        const exportCam = new THREE.PerspectiveCamera(60, width / height, 0.1, 100);
        exportCam.position.copy(this.camera.position);
        exportCam.quaternion.copy(this.camera.quaternion);
        exportCam.updateMatrixWorld();

        this.renderer.setRenderTarget(renderTarget);
        this.renderer.render(this.scene, exportCam);
        await new Promise(resolve => setTimeout(resolve, 100)); // let sorting finish
        this.renderer.render(this.scene, exportCam);

        const buffer = new Uint8Array(width * height * 4);
        this.renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, buffer);
        
        const rawImgData = new ImageData(new Uint8ClampedArray(buffer), width, height);
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        tempCanvas.getContext('2d').putImageData(rawImgData, 0, 0);

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, width, height);
        ctx.save();
        ctx.translate(0, height);
        ctx.scale(1, -1);
        ctx.drawImage(tempCanvas, 0, 0);
        ctx.restore();

        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        
        // Restore scene
        this.renderer.setRenderTarget(null);
        this.scene.background = originalBg;
        this.pois.forEach(p => p.visible = true);
        this.updatePreview();

        try {
            const formData = new FormData();
            formData.append('file', blob, 'capture.png');
            
            const promptStr = prompt("Enter object to segment (or leave blank for auto):", "");
            if (promptStr) {
                formData.append('prompt', promptStr);
            }

            this.statusText.innerText = "Running object detection...";
            const res = await fetch(`http://${window.location.hostname}:8000/segment-view`, {
                method: 'POST',
                body: formData
            });

            if (!res.ok) {
                throw new Error(`Server returned status ${res.status}`);
            }

            const data = await res.json();
            if (data.error) throw new Error(data.error);

            if (!data.detections || data.detections.length === 0) {
                this.statusText.innerText = "No objects detected.";
                return;
            }

            const bestObj = data.detections[0];
            console.log("Detected object:", bestObj);

            // Calculate 3D centroid
            const ndcX = (bestObj.center_x / width) * 2 - 1;
            const ndcY = -(bestObj.center_y / height) * 2 + 1;
            
            this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), exportCam);
            
            if (!this.pendingSegmentRay) {
                // First click: store the ray and draw a preview line
                this.pendingSegmentRay = this.raycaster.ray.clone();
                
                const points = [
                    this.pendingSegmentRay.origin,
                    this.pendingSegmentRay.origin.clone().add(this.pendingSegmentRay.direction.clone().multiplyScalar(20))
                ];
                const geometry = new THREE.BufferGeometry().setFromPoints(points);
                const material = new THREE.LineDashedMaterial({ color: 0x00ff00, dashSize: 0.5, gapSize: 0.2 });
                this.pendingRayLine = new THREE.Line(geometry, material);
                this.pendingRayLine.computeLineDistances();
                this.scene.add(this.pendingRayLine);
                
                this.statusText.innerText = `Captured angle 1 for ${bestObj.class}. Move camera and click Segment again.`;
                return;
            }
            
            // Second click: intersect rays
            const intersectPoint = this.calculateRayIntersection(this.pendingSegmentRay, this.raycaster.ray);
            
            // Clean up pending state
            this.cancelPendingSegmentation();
            
            const distanceToObj = exportCam.position.distanceTo(intersectPoint);
            
            // Calculate optimal standoff distance
            // We want the object to occupy ~70% of the screen width
            const targetWidthPx = width * 0.7;
            const bbWidthPx = bestObj.width;
            
            // new_dist = current_dist * (current_px / target_px)
            let optimalDistance = distanceToObj * (bbWidthPx / targetWidthPx);
            
            // Clamp to reasonable values
            optimalDistance = Math.max(0.5, Math.min(optimalDistance, 10.0));
            
            // Clear existing POIs and add the new one
            this.pois.forEach(poi => {
                this.scene.remove(poi);
                poi.geometry.dispose();
                poi.material.dispose();
            });
            this.pois = [];
            
            this.createPOI(intersectPoint);
            
            // Update UI
            if (this.standoffInput) {
                this.standoffInput.value = optimalDistance.toFixed(1);
                if (this.standoffValText) this.standoffValText.innerText = `${optimalDistance.toFixed(1)} units`;
            }
            
            this.updatePreview();
            this.statusText.innerText = `Found ${bestObj.class}! Auto-set camera radius to ${optimalDistance.toFixed(1)}.`;
            
        } catch (err) {
            console.error(err);
            this.statusText.innerText = `Error: ${err.message}`;
        } finally {
            this.segmentThisBtn.disabled = false;
        }
    }
}
