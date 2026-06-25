import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';

export class VRSessionManager {
    constructor(renderer, scene, camera, hitboxesMap, physicsManager) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        this.hitboxes = hitboxesMap;
        this.physicsManager = physicsManager;
        
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
        }
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
