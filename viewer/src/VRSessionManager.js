import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { HTMLMesh } from 'three/examples/jsm/interactive/HTMLMesh.js';
import { InteractiveGroup } from 'three/examples/jsm/interactive/InteractiveGroup.js';

export class VRSessionManager {
    constructor(renderer, scene, camera, hitboxesMap, physicsManager, sceneBuilder) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        this.hitboxes = hitboxesMap;
        this.physicsManager = physicsManager;
        this.sceneBuilder = sceneBuilder;
        
        // 1. Enable XR in Three.js
        this.renderer.xr.enabled = true;
        
        // 2. Replace the dummy VR button with the real WebXR VRButton
        const existingBtn = document.getElementById('enter-vr-btn');
        if (existingBtn) {
            existingBtn.style.display = 'none';
        }
        document.body.appendChild(VRButton.createButton(this.renderer));
        
        // 3. Variables for grabbing objects
        this.raycaster = new THREE.Raycaster();
        this.tempMatrix = new THREE.Matrix4();
        this.grabbedObject = null;
        this.grabbingController = null;
        
        // 4. VR Menu Setup
        this.interactiveGroup = new InteractiveGroup();
        this.scene.add(this.interactiveGroup);
        this.setupVRMenu();

        this.setupControllers();
    }

    setupControllers() {
        this.controllers = [];
        const controllerModelFactory = new XRControllerModelFactory();

        for (let i = 0; i < 2; i++) {
            // Get the controller
            const controller = this.renderer.xr.getController(i);
            
            // Listen for Quest trigger squeeze
            controller.addEventListener('selectstart', (e) => this.onSelectStart(e));
            controller.addEventListener('selectend', (e) => this.onSelectEnd(e));
            
            this.scene.add(controller);
            
            // Get the visual 3D model of the controller (Quest 3 controllers will load automatically!)
            const controllerGrip = this.renderer.xr.getControllerGrip(i);
            controllerGrip.add(controllerModelFactory.createControllerModel(controllerGrip));
            this.scene.add(controllerGrip);
            
            // Add a laser pointer line extending from the controller
            const geometry = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(0, 0, 0),
                new THREE.Vector3(0, 0, -5) // 5 meters long laser
            ]);
            const material = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
            const line = new THREE.Line(geometry, material);
            controller.add(line);
            
            this.controllers.push(controller);
            this.interactiveGroup.listenToXRControllerEvents(controller);
        }
    }

    setupVRMenu() {
        const vrContainer = document.createElement('div');
        vrContainer.style.width = '400px';
        vrContainer.style.padding = '20px';
        vrContainer.style.backgroundColor = 'rgba(30, 41, 59, 0.95)';
        vrContainer.style.borderRadius = '12px';
        vrContainer.style.color = 'white';
        vrContainer.style.fontFamily = 'sans-serif';
        vrContainer.style.position = 'absolute';
        vrContainer.style.left = '-9999px';
        document.body.appendChild(vrContainer);

        const title = document.createElement('h2');
        title.innerText = 'VR Controls';
        title.style.margin = '0 0 20px 0';
        title.style.textAlign = 'center';
        title.style.fontSize = '24px';
        title.style.borderBottom = '1px solid #4b5563';
        title.style.paddingBottom = '10px';
        vrContainer.appendChild(title);

        const buttonsToClone = [
            'toggle-camera-btn',
            'toggle-interaction-btn',
            'toggle-physics-btn',
            'toggle-vc-btn',
            'toggle-gizmo-mode-btn',
            'reset-object-btn',
            'reset-scene-btn',
            'load-file-btn'
        ];

        buttonsToClone.forEach(id => {
            const originalBtn = document.getElementById(id);
            if (originalBtn) {
                const vrBtn = document.createElement('button');
                vrBtn.innerText = originalBtn.innerText;
                vrBtn.style.display = originalBtn.style.display;
                vrBtn.style.width = '100%';
                vrBtn.style.padding = '12px';
                vrBtn.style.marginBottom = '10px';
                vrBtn.style.backgroundColor = originalBtn.style.backgroundColor || '#4b5563';
                vrBtn.style.color = 'white';
                vrBtn.style.border = 'none';
                vrBtn.style.borderRadius = '6px';
                vrBtn.style.fontSize = '18px';
                vrBtn.style.cursor = 'pointer';

                // Keep VR button in sync with original button
                const observer = new MutationObserver(() => {
                    vrBtn.innerText = originalBtn.innerText;
                    vrBtn.style.backgroundColor = originalBtn.style.backgroundColor;
                    vrBtn.style.display = originalBtn.style.display;
                });
                observer.observe(originalBtn, { attributes: true, childList: true, subtree: true });

                vrBtn.addEventListener('click', () => {
                    originalBtn.click();
                });
                vrContainer.appendChild(vrBtn);
            }
        });

        const exitBtn = document.createElement('button');
        exitBtn.innerText = 'Exit VR';
        exitBtn.style.display = 'block';
        exitBtn.style.width = '100%';
        exitBtn.style.padding = '12px';
        exitBtn.style.marginTop = '20px';
        exitBtn.style.backgroundColor = '#ef4444';
        exitBtn.style.color = 'white';
        exitBtn.style.border = 'none';
        exitBtn.style.borderRadius = '6px';
        exitBtn.style.fontSize = '18px';
        exitBtn.style.cursor = 'pointer';
        exitBtn.addEventListener('click', () => {
            const session = this.renderer.xr.getSession();
            if (session) {
                session.end();
            }
        });
        vrContainer.appendChild(exitBtn);

        // --- DYNAMIC PROJECT LOADER ---
        const loadModelsTitle = document.createElement('h3');
        loadModelsTitle.innerText = 'Load Projects';
        loadModelsTitle.style.marginTop = '30px';
        loadModelsTitle.style.marginBottom = '10px';
        loadModelsTitle.style.borderBottom = '1px solid #4b5563';
        loadModelsTitle.style.paddingBottom = '5px';
        loadModelsTitle.style.fontSize = '20px';
        vrContainer.appendChild(loadModelsTitle);

        const modelsContainer = document.createElement('div');
        modelsContainer.style.maxHeight = '180px';
        modelsContainer.style.overflowY = 'auto';
        vrContainer.appendChild(modelsContainer);

        const loadProjects = () => {
            modelsContainer.innerHTML = '<p>Loading folders...</p>';
            // Fetch dynamically from our new Vite plugin endpoint!
            fetch('/api/public-manifests')
                .then(res => res.json())
                .then(folders => {
                    modelsContainer.innerHTML = '';
                    if (folders.length === 0) {
                        modelsContainer.innerText = 'No local projects found in /public.';
                        return;
                    }
                    folders.forEach(folder => {
                        const btn = document.createElement('button');
                        btn.innerText = `Load ${folder}`;
                        btn.style.display = 'block';
                        btn.style.width = '100%';
                        btn.style.padding = '10px';
                        btn.style.marginBottom = '8px';
                        btn.style.backgroundColor = '#3b82f6';
                        btn.style.color = 'white';
                        btn.style.border = 'none';
                        btn.style.borderRadius = '6px';
                        btn.style.cursor = 'pointer';
                        
                        btn.addEventListener('click', () => {
                            const manifestUrl = `/${folder}/manifest.json`;
                            sessionStorage.setItem('vit_manifest_url', manifestUrl);
                            if (this.sceneBuilder) {
                                this.sceneBuilder.clearScene();
                                this.sceneBuilder.loadFromManifest();
                            }
                        });
                        modelsContainer.appendChild(btn);
                    });
                })
                .catch(err => {
                    modelsContainer.innerHTML = '<p style="color:#ef4444;">Error finding folders</p>';
                });
        };

        const refreshBtn = document.createElement('button');
        refreshBtn.innerText = 'Refresh Project List';
        refreshBtn.style.display = 'block';
        refreshBtn.style.width = '100%';
        refreshBtn.style.padding = '8px';
        refreshBtn.style.marginTop = '10px';
        refreshBtn.style.backgroundColor = '#10b981';
        refreshBtn.style.color = 'white';
        refreshBtn.style.border = 'none';
        refreshBtn.style.borderRadius = '6px';
        refreshBtn.style.cursor = 'pointer';
        refreshBtn.addEventListener('click', loadProjects);
        vrContainer.appendChild(refreshBtn);

        // Initial load of projects
        loadProjects();

        this.vrMenuMesh = new HTMLMesh(vrContainer);
        
        // Position menu in front of user
        this.vrMenuMesh.position.set(0, 1.3, -1.2);
        
        // Tilt slightly up for ergonomics
        this.vrMenuMesh.rotation.set(-0.2, 0, 0);
        this.vrMenuMesh.scale.setScalar(2);

        // --- FIX FOR PERMANENT Y-INVERSION ---
        // Since the natural state on Quest is permanently upside-down (but not mirrored left-to-right),
        // we rewrite the geometry's UV map to paint the texture right-side up. This flips Y visually
        // without turning the mesh inside out or mirroring X.
        const uvAttribute = this.vrMenuMesh.geometry.attributes.uv;
        for (let i = 0; i < uvAttribute.count; i++) {
            const v = uvAttribute.getY(i);
            uvAttribute.setY(i, 1 - v);
        }
        uvAttribute.needsUpdate = true;

        // Because we flipped the UV map, the laser pointer raycaster will return flipped coordinates.
        // We intercept the raycast events before HTMLMesh processes them and flip Y back to match the real DOM.
        const invertEvent = (event) => {
            if (event.data) {
                event.data.y = 1 - event.data.y;
            }
        };

        ['mousedown', 'mousemove', 'mouseup', 'click'].forEach(type => {
            if (this.vrMenuMesh._listeners && this.vrMenuMesh._listeners[type]) {
                this.vrMenuMesh._listeners[type].unshift(invertEvent);
            }
        });

        this.interactiveGroup.add(this.vrMenuMesh);
        
        // Hide the 3D menu in the normal desktop view
        this.vrMenuMesh.visible = false;

        // --- THE "WAKE UP" FIX ---
        // The Meta Quest browser has a graphics buffer bug where the very first CanvasTexture upload 
        // to WebXR is sometimes inverted. We listen for when the user enters VR, and forcefully 
        // trigger a few UI repaints by slightly toggling the padding. This perfectly mimics a button
        // click and forces the browser to "wake up" and render the texture in its proper orientation.
        this.renderer.xr.addEventListener('sessionstart', () => {
            // Show the menu once we are actually in VR
            this.vrMenuMesh.visible = true;
            
            let count = 0;
            const wakeUpInterval = setInterval(() => {
                if (count > 5) {
                    clearInterval(wakeUpInterval);
                    // Reset to exact original state
                    vrContainer.style.padding = '20px';
                    return;
                }
                // Toggle padding between 20px and 21px to trigger HTMLMesh's internal MutationObserver
                vrContainer.style.padding = (count % 2 === 0) ? '21px' : '20px';
                count++;
            }, 150);
        });

        // Hide the menu again when the user exits VR
        this.renderer.xr.addEventListener('sessionend', () => {
            if (this.vrMenuMesh) {
                this.vrMenuMesh.visible = false;
            }
        });
    }

    onSelectStart(event) {
        const controller = event.target;
        
        // Cast a ray from the controller exactly down the laser line
        this.tempMatrix.identity().extractRotation(controller.matrixWorld);
        this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
        this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix);
        
        // Find what movable object the laser is hitting
        const allHitboxes = Array.from(this.hitboxes.values());
        const movableHitboxes = allHitboxes.filter(h => h.userData.movable);
        
        const intersects = this.raycaster.intersectObjects(movableHitboxes, false);
        
        if (intersects.length > 0) {
            const hit = intersects[0].object;
            this.grabbedObject = hit;
            this.grabbingController = controller;
            
            // Turn off physics gravity for this object while we hold it!
            this.physicsManager.setKinematic(hit.userData.id, true);
            
            // Attach the object directly to the controller so it moves exactly with our hand
            controller.attach(hit);
        }
    }

    onSelectEnd(event) {
        const controller = event.target;
        
        if (this.grabbedObject && this.grabbingController === controller) {
            // Detach from the controller and put it back in the world
            this.scene.attach(this.grabbedObject);
            
            // Tell the physics engine exactly where we dropped it
            this.physicsManager.updateBodyTransform(
                this.grabbedObject.userData.id,
                this.grabbedObject.position,
                this.grabbedObject.quaternion
            );
            
            // Turn gravity back on so it falls!
            this.physicsManager.setKinematic(this.grabbedObject.userData.id, false);
            
            this.grabbedObject = null;
            this.grabbingController = null;
        }
    }
    
    update() {
        // While holding an object, we need to constantly update the physics engine
        // so that if you smash the object against a wall while holding it, 
        // the physics engine knows its exact position.
        if (this.grabbedObject) {
            this.physicsManager.updateBodyTransform(
                this.grabbedObject.userData.id,
                this.grabbedObject.position,
                this.grabbedObject.quaternion
            );
        }
    }
}
