import './style.css';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { ViewHelper } from 'three/examples/jsm/helpers/ViewHelper.js';
import { SparkRenderer } from '@sparkjsdev/spark';
import { SceneBuilder } from './SceneBuilder.js';
import { PhysicsManager } from './PhysicsManager.js';
import { VRSessionManager } from './VRSessionManager.js';
import { VirtualCameraManager } from './VirtualCameraManager.js';
import { FPSControls } from './FPSControls.js';
import { router } from './router.js';
import { initHomePage } from './HomePage.js';
import { initPipelinePage } from './PipelinePage.js';

// ── Page controllers (always initialised — they attach listeners, not DOM) ──
initHomePage();
initPipelinePage();

// ── Nav home button ──────────────────────────────────────────────────────────
const navHomeBtn = document.getElementById('nav-home-btn');
if (navHomeBtn) navHomeBtn.addEventListener('click', () => router.goHome());

// ── Lazy renderer init ───────────────────────────────────────────────────────
// Called by the router the first time the user navigates to #/renderer.
function initRenderer() {
    const appContainer = document.getElementById('app');

    // 1. Scene, Camera, Renderer
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 1.5, 3);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.autoClear = false;
    appContainer.appendChild(renderer.domElement);

    // 2. SparkRenderer
    const spark = new SparkRenderer({ renderer });
    scene.add(spark);

    // 3. Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    // 5. Camera controls
    const orbitControls = new OrbitControls(camera, renderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.05;

    const fpsControls = new FPSControls(camera, renderer.domElement);
    fpsControls.movementSpeed = 3;
    fpsControls.lookSpeed = 0.002;
    fpsControls.enabled = false; // start with orbit active

    let activeControls = orbitControls;

    const toggleCameraBtn = document.getElementById('toggle-camera-btn');
    if (toggleCameraBtn) {
        toggleCameraBtn.addEventListener('click', () => {
            if (activeControls === orbitControls) {
                orbitControls.enabled = false;
                fpsControls.enabled = true;
                activeControls = fpsControls;
                toggleCameraBtn.innerText = 'Camera: Fly (WASD + Right-drag)';

                // Automatically find room boundaries and enable collisions when switching to Fly mode
                let roomHitbox = null;
                for (const [id, hitbox] of sceneBuilder.hitboxes.entries()) {
                    if (hitbox.userData.label.toLowerCase().includes('background') || sceneBuilder.hitboxes.size === 1) {
                        roomHitbox = hitbox;
                        break;
                    }
                }
                if (!roomHitbox && sceneBuilder.hitboxes.size > 0) {
                    roomHitbox = Array.from(sceneBuilder.hitboxes.values())[0];
                }
                
                if (roomHitbox) {
                    roomHitbox.geometry.computeBoundingBox();
                    const size = new THREE.Vector3();
                    roomHitbox.geometry.boundingBox.getSize(size);
                    
                    window.activeRoomHitbox = roomHitbox;
                    window.activeRoomSize = size;
                    window.cameraCollisionEnabled = true;
                    console.log("Enabled camera bounds collisions dynamically!", size);
                }
            } else {
                fpsControls.enabled = false;
                orbitControls.enabled = true;
                activeControls = orbitControls;
                toggleCameraBtn.innerText = 'Camera: Orbit';

                window.cameraCollisionEnabled = false;
                window.activeRoomHitbox = null;
                window.activeRoomSize = null;
            }
        });
    }

    const resetCameraBtn = document.getElementById('reset-camera-btn');
    if (resetCameraBtn) {
        resetCameraBtn.addEventListener('click', () => {
            camera.position.set(0, 1.5, 3);
            orbitControls.target.set(0, 0, 0);
            orbitControls.update();
            camera.lookAt(0, 0, 0);
        });
    }

    // 6. Transform Controls (Gizmo)
    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode('translate');
    transformControls.setSize(0.8);
    scene.add(transformControls.getHelper());

    // Grid Helper (optional, active by default)
    const gridHelper = new THREE.GridHelper(50, 50, 0x4f46e5, 0x334155);
    gridHelper.position.y = -0.01; // slightly below 0 to avoid z-fighting
    scene.add(gridHelper);

    const toggleGridBtn = document.getElementById('toggle-grid-btn');
    if (toggleGridBtn) {
        toggleGridBtn.addEventListener('click', () => {
            gridHelper.visible = !gridHelper.visible;
            toggleGridBtn.innerText = `Grid: ${gridHelper.visible ? 'ON' : 'OFF'}`;
            toggleGridBtn.style.backgroundColor = gridHelper.visible ? '#2563eb' : '#4b5563';
        });
    }

    // Room Mesh visibility configuration
    window.roomMeshVisible = false; // default off
    const toggleMeshBtn = document.getElementById('toggle-mesh-btn');
    if (toggleMeshBtn) {
        toggleMeshBtn.addEventListener('click', () => {
            window.roomMeshVisible = !window.roomMeshVisible;
            toggleMeshBtn.innerText = `Room Mesh: ${window.roomMeshVisible ? 'ON' : 'OFF'}`;
            toggleMeshBtn.style.backgroundColor = window.roomMeshVisible ? '#2563eb' : '#4b5563';

            // Toggle visibility of the room hitbox(es) and child boundary meshes
            for (const [id, hitbox] of sceneBuilder.hitboxes.entries()) {
                if (hitbox.userData.label.toLowerCase().includes('background') || sceneBuilder.hitboxes.size === 1) {
                    hitbox.material.visible = window.roomMeshVisible;
                    hitbox.material.opacity = window.roomMeshVisible ? 0.6 : 0.0;
                    if (hitbox.userData.edgeHelper) {
                        hitbox.userData.edgeHelper.visible = window.roomMeshVisible;
                    }
                    hitbox.traverse((child) => {
                        if (child !== hitbox) {
                            child.visible = window.roomMeshVisible;
                        }
                    });
                }
            }

            // Toggle visibility of Custom Mesh Placer panel on the other side
            const customMeshPanel = document.getElementById('custom-mesh-panel');
            if (customMeshPanel) {
                customMeshPanel.style.display = window.roomMeshVisible ? 'block' : 'none';
            }
        });
    }

    // Toggle 3D Gaussian Splatting model visibility (show mesh only)
    window.splatsVisible = true;
    const toggleSplatBtn = document.getElementById('toggle-splat-btn');
    if (toggleSplatBtn) {
        toggleSplatBtn.addEventListener('click', () => {
            window.splatsVisible = !window.splatsVisible;
            toggleSplatBtn.innerText = `Splat Model: ${window.splatsVisible ? 'ON' : 'OFF'}`;
            toggleSplatBtn.style.backgroundColor = window.splatsVisible ? '#2563eb' : '#4b5563';

            for (const splat of sceneBuilder.segments.values()) {
                splat.visible = window.splatsVisible;
            }
        });
    }

    // ── Navigation Area Visualizer ───────────────────────────────────────────
    let navAreaVisible = false;
    let walkablePointsMesh = null;
    let blockedPointsMesh = null;
    let baseWalkablePositions = null;
    let baseBlockedPositions = null;

    function generateNavigationGrid() {
        if (walkablePointsMesh) scene.remove(walkablePointsMesh);
        if (blockedPointsMesh) scene.remove(blockedPointsMesh);
        walkablePointsMesh = null;
        blockedPointsMesh = null;
        baseWalkablePositions = null;
        baseBlockedPositions = null;

        const bbox = new THREE.Box3();
        let hasGeometry = false;

        let roomHitbox = null;
        for (const hitbox of sceneBuilder.hitboxes.values()) {
            if (hitbox.userData.label.toLowerCase().includes('background') || sceneBuilder.hitboxes.size === 1) {
                roomHitbox = hitbox;
                break;
            }
        }
        if (!roomHitbox && sceneBuilder.hitboxes.size > 0) {
            roomHitbox = Array.from(sceneBuilder.hitboxes.values())[0];
        }

        if (roomHitbox) {
            roomHitbox.geometry.computeBoundingBox();
            bbox.copy(roomHitbox.geometry.boundingBox).applyMatrix4(roomHitbox.matrixWorld);
            hasGeometry = true;
        } else {
            for (const segment of sceneBuilder.segments.values()) {
                if (segment.geometry) {
                    if (!segment.geometry.boundingBox) segment.geometry.computeBoundingBox();
                    const segBox = segment.geometry.boundingBox.clone().applyMatrix4(segment.matrixWorld);
                    bbox.union(segBox);
                    hasGeometry = true;
                }
            }
        }

        if (!hasGeometry) {
            bbox.set(
                new THREE.Vector3(-4, -1, -4),
                new THREE.Vector3(4, 2.5, 4)
            );
        }

        const min = bbox.min;
        const max = bbox.max;
        const width = max.x - min.x;
        const depth = max.z - min.z;

        const step = 0.25;
        const cols = Math.min(50, Math.max(8, Math.floor(width / step)));
        const rows = Math.min(50, Math.max(8, Math.floor(depth / step)));
        const dx = width / cols;
        const dz = depth / rows;

        const walkablePositions = [];
        const blockedPositions = [];

        const hitboxes = Array.from(sceneBuilder.hitboxes.values());
        const floorMeshes = hitboxes.filter(h => h.userData.label.toLowerCase().includes('background') || hitboxes.length === 1);
        const obstacleMeshes = hitboxes.filter(h => !floorMeshes.includes(h));

        const raycaster = new THREE.Raycaster();
        const downDir = new THREE.Vector3(0, -1, 0);

        for (let r = 0; r <= rows; r++) {
            for (let c = 0; c <= cols; c++) {
                const x = min.x + c * dx;
                const z = min.z + r * dz;

                const rayOrigin = new THREE.Vector3(x, max.y + 0.5, z);
                raycaster.set(rayOrigin, downDir);

                let hitFloor = false;
                let floorY = min.y;

                if (floorMeshes.length > 0) {
                    const floorIntersects = raycaster.intersectObjects(floorMeshes, true);
                    if (floorIntersects.length > 0) {
                        hitFloor = true;
                        floorY = floorIntersects[0].point.y;
                    }
                } else {
                    hitFloor = true;
                }

                if (!hitFloor) {
                    blockedPositions.push(x, min.y + 0.04, z);
                    continue;
                }

                const pointHeight = floorY + 0.04;
                const point3D = new THREE.Vector3(x, pointHeight, z);
                let blocked = false;

                // 1. Raycast up to check for overhead obstructions
                raycaster.set(new THREE.Vector3(x, floorY + 0.02, z), new THREE.Vector3(0, 1, 0));
                const overheadIntersects = raycaster.intersectObjects(obstacleMeshes, true);
                if (overheadIntersects.length > 0) {
                    if (overheadIntersects[0].distance < 1.4) {
                        blocked = true;
                    }
                }

                // 2. Check proximity to obstacle hitboxes
                if (!blocked) {
                    for (const obstacle of obstacleMeshes) {
                        if (!obstacle.geometry.boundingBox) obstacle.geometry.computeBoundingBox();
                        const obstacleBbox = obstacle.geometry.boundingBox.clone().applyMatrix4(obstacle.matrixWorld);
                        
                        const expandedBox = obstacleBbox.clone();
                        expandedBox.min.x -= 0.35;
                        expandedBox.min.z -= 0.35;
                        expandedBox.max.x += 0.35;
                        expandedBox.max.z += 0.35;

                        if (expandedBox.containsPoint(point3D)) {
                            blocked = true;
                            break;
                        }
                    }
                }

                if (blocked) {
                    blockedPositions.push(x, pointHeight, z);
                } else {
                    walkablePositions.push(x, pointHeight, z);
                }
            }
        }

        function createGasTexture() {
            const canvas = document.createElement('canvas');
            canvas.width = 64;
            canvas.height = 64;
            const ctx = canvas.getContext('2d');
            const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
            grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
            grad.addColorStop(0.3, 'rgba(255, 255, 255, 0.7)');
            grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, 64, 64);
            return new THREE.CanvasTexture(canvas);
        }

        const gasTexture = createGasTexture();

        if (walkablePositions.length > 0) {
            const geom = new THREE.BufferGeometry();
            baseWalkablePositions = new Float32Array(walkablePositions);
            geom.setAttribute('position', new THREE.BufferAttribute(baseWalkablePositions.slice(), 3));
            
            const mat = new THREE.PointsMaterial({
                color: 0x00d2ff, // Cyan blue
                size: 0.35,
                map: gasTexture,
                transparent: true,
                opacity: 0.45,
                depthWrite: false,
                blending: THREE.AdditiveBlending
            });
            walkablePointsMesh = new THREE.Points(geom, mat);
            scene.add(walkablePointsMesh);
        }

        if (blockedPositions.length > 0) {
            const geom = new THREE.BufferGeometry();
            baseBlockedPositions = new Float32Array(blockedPositions);
            geom.setAttribute('position', new THREE.BufferAttribute(baseBlockedPositions.slice(), 3));
            
            const mat = new THREE.PointsMaterial({
                color: 0xff3b3b, // Red
                size: 0.35,
                map: gasTexture,
                transparent: true,
                opacity: 0.4,
                depthWrite: false,
                blending: THREE.AdditiveBlending
            });
            blockedPointsMesh = new THREE.Points(geom, mat);
            scene.add(blockedPointsMesh);
        }
    }

    const toggleNavAreaBtn = document.getElementById('toggle-nav-area-btn');
    if (toggleNavAreaBtn) {
        toggleNavAreaBtn.addEventListener('click', () => {
            navAreaVisible = !navAreaVisible;
            toggleNavAreaBtn.innerText = `Grid Nav: ${navAreaVisible ? 'ON' : 'OFF'}`;
            toggleNavAreaBtn.style.backgroundColor = navAreaVisible ? '#2563eb' : '#4b5563';

            if (navAreaVisible) {
                generateNavigationGrid();
            } else {
                if (walkablePointsMesh) scene.remove(walkablePointsMesh);
                if (blockedPointsMesh) scene.remove(blockedPointsMesh);
                walkablePointsMesh = null;
                blockedPointsMesh = null;
                baseWalkablePositions = null;
                baseBlockedPositions = null;
            }
        });
    }

    function disableControls() {
        orbitControls.enabled = false;
        fpsControls.enabled = false;
    }
    function enableControls() {
        if (activeControls === orbitControls) {
            orbitControls.enabled = true;
        } else {
            fpsControls.enabled = true;
        }
    }

    // 7. Scene Builder & Physics
    const physicsManager = new PhysicsManager();
    const sceneBuilder = new SceneBuilder(scene, camera, transformControls, disableControls, enableControls, physicsManager);
    
    // Setup alignment start hook
    sceneBuilder.onAlignmentStart = () => {
        window.cameraCollisionEnabled = false;
        window.activeRoomHitbox = null;
        window.activeRoomSize = null;
        
        // Put camera outside of the object
        camera.position.set(0, 1.5, 3);
        orbitControls.target.set(0, 0, 0);
        orbitControls.update();
        camera.lookAt(0, 0, 0);
        
        fpsControls.enabled = false;
        orbitControls.enabled = true;
        activeControls = orbitControls;
        
        const toggleCameraBtn = document.getElementById('toggle-camera-btn');
        if (toggleCameraBtn) {
            toggleCameraBtn.innerText = 'Camera: Orbit';
        }
    };

    let lastLoadedManifestUrl = null;
    async function loadCurrentManifest() {
        const manifestUrl = sessionStorage.getItem('vit_manifest_url');
        if (manifestUrl === lastLoadedManifestUrl) return;
        lastLoadedManifestUrl = manifestUrl;
        
        sceneBuilder.clearScene();
        await sceneBuilder.loadFromManifest();
    }

    loadCurrentManifest();
    window.addEventListener('route:renderer', loadCurrentManifest);

    // 8. Virtual Camera Manager
    const vcManager = new VirtualCameraManager(scene, camera, renderer, transformControls, orbitControls);
    sceneBuilder.setVirtualCameraManager(vcManager);

    // 8.1 Setup Scene Alignment Rotations
    const rotations = [
        { id: 'rot-x-plus', axis: 'x', angle: Math.PI / 2 },
        { id: 'rot-x-minus', axis: 'x', angle: -Math.PI / 2 },
        { id: 'rot-y-plus', axis: 'y', angle: Math.PI / 2 },
        { id: 'rot-y-minus', axis: 'y', angle: -Math.PI / 2 },
        { id: 'rot-z-plus', axis: 'z', angle: Math.PI / 2 },
        { id: 'rot-z-minus', axis: 'z', angle: -Math.PI / 2 },
    ];
    rotations.forEach(r => {
        const btn = document.getElementById(r.id);
        if (btn) {
            btn.addEventListener('click', () => {
                sceneBuilder.rotateScene(r.axis, r.angle);
            });
        }
    });

    const alignPanel = document.querySelector('.scene-align-panel');
    const confirmAlignBtn = document.getElementById('confirm-align-btn');
    if (confirmAlignBtn && alignPanel) {
        confirmAlignBtn.addEventListener('click', () => {
            // 1. Create collision mesh for local splat if hitboxes are empty (meaning single unsegmented PLY)
            if (sceneBuilder.hitboxes.size === 0) {
                sceneBuilder.createCollisionMeshForLocalSplat();
            }

            alignPanel.style.display = 'none';
            sceneBuilder.endAlignmentMode();

            // 2. Locate the room boundary hitbox
            let roomHitbox = null;
            for (const [id, hitbox] of sceneBuilder.hitboxes.entries()) {
                if (hitbox.userData.label.toLowerCase().includes('background') || sceneBuilder.hitboxes.size === 1) {
                    roomHitbox = hitbox;
                    break;
                }
            }
            if (!roomHitbox && sceneBuilder.hitboxes.size > 0) {
                roomHitbox = Array.from(sceneBuilder.hitboxes.values())[0];
            }

            // 3. Teleport camera inside the room and activate collision physics
            if (roomHitbox) {
                roomHitbox.geometry.computeBoundingBox();
                const size = new THREE.Vector3();
                roomHitbox.geometry.boundingBox.getSize(size);

                // Teleport camera inside: center of room
                const targetPos = roomHitbox.position.clone();
                // Add a small height offset (eye level)
                targetPos.y += 0.2;
                camera.position.copy(targetPos);

                // Switch to FPS controls
                orbitControls.enabled = false;
                fpsControls.enabled = true;
                activeControls = fpsControls;
                const toggleCameraBtn = document.getElementById('toggle-camera-btn');
                if (toggleCameraBtn) {
                    toggleCameraBtn.innerText = 'Camera: Fly (WASD + Right-drag)';
                }

                // Enable camera room boundary collision checks
                window.activeRoomHitbox = roomHitbox;
                window.activeRoomSize = size;
                window.cameraCollisionEnabled = true;

                console.log("Teleported camera inside room and enabled room boundaries!", targetPos, size);
            }
        });
    }

    // View Helper Gizmo
    const viewHelper = new ViewHelper(camera, renderer.domElement);
    
    renderer.domElement.addEventListener('pointerup', (event) => {
        viewHelper.center.copy(orbitControls.target);
        viewHelper.handleClick(event);
    });

    // 8.5. VR Manager
    const vrManager = new VRSessionManager(renderer, scene, camera, sceneBuilder.hitboxes, physicsManager, sceneBuilder);

    // 9. File Upload
    const loadFileBtn = document.getElementById('load-file-btn');
    const fileInput   = document.getElementById('file-input');
    if (loadFileBtn && fileInput) {
        loadFileBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (file) sceneBuilder.loadFromFile(file);
            fileInput.value = '';
        });
    }

    // 9.5 Camera View Animation Shortcuts (1, 2, 3)
    let isAnimatingCamera = false;
    let cameraAnimStartPosition = new THREE.Vector3();
    let cameraAnimStartQuaternion = new THREE.Quaternion();
    let cameraAnimTargetPosition = new THREE.Vector3();
    let cameraAnimTargetQuaternion = new THREE.Quaternion();
    let cameraAnimProgress = 0;
    const animDuration = 0.3; // seconds

    window.addEventListener('keydown', (event) => {
        // Ignore if typing in an input
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

        const activeObject = transformControls.object;
        const targetPos = activeObject ? activeObject.position.clone() : new THREE.Vector3().copy(orbitControls.target);
        const distance = Math.max(1.5, camera.position.distanceTo(targetPos));
        let handled = false;

        if (event.code === 'Digit1') {
            // Right View (+X)
            cameraAnimTargetPosition.set(targetPos.x + distance, targetPos.y, targetPos.z);
            handled = true;
        } else if (event.code === 'Digit2') {
            // Top View (+Y)
            cameraAnimTargetPosition.set(targetPos.x, targetPos.y + distance, targetPos.z);
            handled = true;
        } else if (event.code === 'Digit3') {
            // Front View (+Z)
            cameraAnimTargetPosition.set(targetPos.x, targetPos.y, targetPos.z + distance);
            handled = true;
        }

        if (handled) {
            // Update orbit controls target to pivot around the selected object
            orbitControls.target.copy(targetPos);

            // Calculate target quaternion to look at the center
            const dummyCamera = camera.clone();
            dummyCamera.position.copy(cameraAnimTargetPosition);
            dummyCamera.up.set(0, 1, 0);
            if (event.code === 'Digit2') dummyCamera.up.set(0, 0, -1); // Prevent gimbal lock for top view
            dummyCamera.lookAt(targetPos);
            cameraAnimTargetQuaternion.copy(dummyCamera.quaternion);

            cameraAnimStartPosition.copy(camera.position);
            cameraAnimStartQuaternion.copy(camera.quaternion);

            isAnimatingCamera = true;
            cameraAnimProgress = 0;
            
            // Force orbit controls if fly controls were active
            if (fpsControls.enabled) {
                fpsControls.enabled = false;
                activeControls = orbitControls;
                const toggleBtn = document.getElementById('toggle-camera-btn');
                if (toggleBtn) toggleBtn.innerText = 'Camera: Orbit';
            }
        }
    });

    // 9.6 Physics Toggle
    const togglePhysicsBtn = document.getElementById('toggle-physics-btn');
    window.physicsEnabled = false; // default off
    if (togglePhysicsBtn) {
        togglePhysicsBtn.addEventListener('click', () => {
            window.physicsEnabled = !window.physicsEnabled;
            togglePhysicsBtn.innerText = `Physics: ${window.physicsEnabled ? 'ON' : 'OFF'}`;
            togglePhysicsBtn.style.backgroundColor = window.physicsEnabled ? '#2563eb' : '#4b5563';

            if (window.physicsEnabled && physicsManager) {
                // Wake up all bodies so they start falling!
                for (const [id, body] of physicsManager.bodies.entries()) {
                    body.wakeUp();
                }
            } else if (physicsManager) {
                // Freeze them when turned off
                for (const [id, body] of physicsManager.bodies.entries()) {
                    if (body.mass > 0) {
                        body.velocity.set(0,0,0);
                        body.angularVelocity.set(0,0,0);
                    }
                }
            }
        });
    }

    // 10. Animation Loop & FPS counter
    const fpsCounter = document.getElementById('fps-counter');
    const clock = new THREE.Clock();
    let lastTime = performance.now();
    let frames = 0;

    function animate() {
        const delta = clock.getDelta();

        // Animate grid navigation gas particles
        if (navAreaVisible) {
            const time = clock.getElapsedTime();
            if (walkablePointsMesh && baseWalkablePositions) {
                const posAttr = walkablePointsMesh.geometry.attributes.position;
                const arr = posAttr.array;
                for (let i = 0; i < arr.length; i += 3) {
                    const x = arr[i];
                    const z = arr[i + 2];
                    const baseY = baseWalkablePositions[i + 1];
                    arr[i + 1] = baseY + Math.sin(time * 1.5 + x * 4 + z * 4) * 0.03;
                }
                posAttr.needsUpdate = true;
            }
            if (blockedPointsMesh && baseBlockedPositions) {
                const posAttr = blockedPointsMesh.geometry.attributes.position;
                const arr = posAttr.array;
                for (let i = 0; i < arr.length; i += 3) {
                    const x = arr[i];
                    const z = arr[i + 2];
                    const baseY = baseBlockedPositions[i + 1];
                    arr[i + 1] = baseY + Math.sin(time * 1.5 + x * 4 + z * 4) * 0.03;
                }
                posAttr.needsUpdate = true;
            }
        }

        if (isAnimatingCamera) {
            cameraAnimProgress += delta / animDuration;
            if (cameraAnimProgress >= 1) {
                cameraAnimProgress = 1;
                isAnimatingCamera = false;
            }
            // Ease-out cubic
            const t = 1 - Math.pow(1 - cameraAnimProgress, 3);
            camera.position.lerpVectors(cameraAnimStartPosition, cameraAnimTargetPosition, t);
            camera.quaternion.slerpQuaternions(cameraAnimStartQuaternion, cameraAnimTargetQuaternion, t);
            
            orbitControls.update();
            viewHelper.center.copy(orbitControls.target);
        } else if (activeControls === orbitControls) {
            if (viewHelper.animating) {
                viewHelper.update(delta);
            } else {
                orbitControls.update();
                viewHelper.center.copy(orbitControls.target);
            }
        } else {
            const prevCamPos = camera.position.clone();
            fpsControls.update(delta);

            // 1. Constrain camera against scene objects and detailed room geometry (raycasting in movement direction)
            if (window.cameraCollisionEnabled && sceneBuilder.hitboxes.size > 0) {
                const checkDistance = 0.35; // user collision radius
                const moveDir = new THREE.Vector3().subVectors(camera.position, prevCamPos);
                const moveDist = moveDir.length();
                
                if (moveDist > 0.0001) {
                    moveDir.normalize();
                    const raycaster = new THREE.Raycaster();
                    let collisionDetected = false;
                    let hitNormal = null;
                    let intersects = null;
                    
                    // Test at 3 heights: eye-level, table-level, and chair-level
                    const heights = [0.0, -0.4, -0.8];
                    
                    for (const hOffset of heights) {
                        const startPos = prevCamPos.clone();
                        startPos.y += hOffset;
                        
                        raycaster.set(startPos, moveDir);
                        
                        intersects = raycaster.intersectObjects(Array.from(sceneBuilder.hitboxes.values()), true);
                        if (intersects.length > 0) {
                            const hit = intersects[0];
                            if (hit.distance < checkDistance) {
                                if (hit.face && hit.face.normal) {
                                    const worldNormal = hit.face.normal.clone().applyQuaternion(hit.object.quaternion);
                                    if (worldNormal.dot(moveDir) < 0) {
                                        collisionDetected = true;
                                        hitNormal = worldNormal;
                                        break;
                                    }
                                } else {
                                    collisionDetected = true;
                                    break;
                                }
                            }
                        }
                    }
                    
                    if (collisionDetected) {
                        if (intersects && intersects.length > 0) {
                            const hit = intersects[0];
                            const norm = hit.face ? hit.face.normal.clone().applyQuaternion(hit.object.quaternion) : null;
                            console.warn("COLLISION BLOCKED:", {
                                label: hit.object.userData.label || "unknown",
                                distance: hit.distance,
                                normal: norm ? [norm.x.toFixed(2), norm.y.toFixed(2), norm.z.toFixed(2)] : null,
                                moveDir: [moveDir.x.toFixed(2), moveDir.y.toFixed(2), moveDir.z.toFixed(2)],
                                dot: norm ? norm.dot(moveDir).toFixed(2) : null,
                                camPos: [camera.position.x.toFixed(2), camera.position.y.toFixed(2), camera.position.z.toFixed(2)]
                            });
                        }
                        
                        if (hitNormal) {
                            // Slide smoothly along the wall normal
                            const moveVec = new THREE.Vector3().subVectors(camera.position, prevCamPos);
                            const penetration = moveVec.dot(hitNormal);
                            moveVec.sub(hitNormal.clone().multiplyScalar(penetration));
                            camera.position.copy(prevCamPos).add(moveVec);
                        } else {
                            camera.position.copy(prevCamPos);
                        }
                    }
                }
            }
        }

        if (window.physicsEnabled) {
            physicsManager.update(delta, sceneBuilder.hitboxes);
            sceneBuilder.syncSplatsToHitboxes();
        }
        
        // VR controller step
        vrManager.update();

        // Pause main render while VirtualCameraManager is exporting
        if (!vcManager.isExporting) {
            renderer.clear();
            renderer.render(scene, camera);
            viewHelper.render(renderer);
        }

        if (sceneBuilder.isAligning) {
            sceneBuilder.renderAlignmentGizmo();
        }

        // FPS
        const time = performance.now();
        frames++;
        if (time >= lastTime + 1000) {
            if (fpsCounter) fpsCounter.innerText = Math.round((frames * 1000) / (time - lastTime)).toString();
            lastTime = time;
            frames = 0;
        }
    }

    renderer.setAnimationLoop(animate);

    // ── Custom Collider Placement System ─────────────────────────────────────
    const customMeshList = document.getElementById('custom-mesh-list');
    const toggleCustomMeshVis = document.getElementById('toggle-custom-mesh-visibility');
    
    let customColliderCount = 0;
    let selectedCustomMesh = null;
    let customCollidersVisible = true;
    let pendingPlacementType = null;

    const transBtn = document.getElementById('custom-mesh-translate');
    const rotBtn = document.getElementById('custom-mesh-rotate');
    const scaleBtn = document.getElementById('custom-mesh-scale');

    if (transBtn) transBtn.addEventListener('click', () => {
        transformControls.setMode('translate');
        transBtn.style.backgroundColor = '#2563eb';
        if (rotBtn) rotBtn.style.backgroundColor = '';
        if (scaleBtn) scaleBtn.style.backgroundColor = '';
    });
    if (rotBtn) rotBtn.addEventListener('click', () => {
        transformControls.setMode('rotate');
        rotBtn.style.backgroundColor = '#2563eb';
        if (transBtn) transBtn.style.backgroundColor = '';
        if (scaleBtn) scaleBtn.style.backgroundColor = '';
    });
    if (scaleBtn) scaleBtn.addEventListener('click', () => {
        transformControls.setMode('scale');
        scaleBtn.style.backgroundColor = '#2563eb';
        if (transBtn) transBtn.style.backgroundColor = '';
        if (rotBtn) rotBtn.style.backgroundColor = '';
    });

    // Handle scene click to place the pending collider
    window.addEventListener('click', (event) => {
        if (!pendingPlacementType) return;
        
        // Ignore clicks on UI elements
        if (event.target.closest('#ui-overlay') || event.target.closest('#custom-mesh-panel') || event.target.tagName === 'BUTTON' || event.target.tagName === 'INPUT') {
            return;
        }

        const rect = renderer.domElement.getBoundingClientRect();
        const mouseX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const mouseY = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(mouseX, mouseY), camera);

        // Intersect with room mesh / static geometry to find placement point
        const staticHitboxes = Array.from(sceneBuilder.hitboxes.values()).filter(h => !h.userData.isCustom);
        const intersects = raycaster.intersectObjects(staticHitboxes, true);
        
        const spawnPos = new THREE.Vector3();
        const spawnQuat = new THREE.Quaternion().copy(camera.quaternion);

        if (intersects.length > 0) {
            spawnPos.copy(intersects[0].point);
            if (intersects[0].face && intersects[0].face.normal) {
                const normal = intersects[0].face.normal.clone().applyQuaternion(intersects[0].object.quaternion);
                spawnQuat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
            }
        } else {
            // Fallback: 1.5m in front of camera
            const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
            spawnPos.copy(camera.position).add(dir.multiplyScalar(1.5));
        }

        const type = pendingPlacementType;
        pendingPlacementType = null;
        document.body.style.cursor = 'default';

        event.stopPropagation();
        event.preventDefault();

        spawnCustomColliderAt(type, spawnPos, spawnQuat);
    }, true);

    function spawnCustomColliderAt(type, position, quaternion) {
        customColliderCount++;
        const id = `custom_${type}_${customColliderCount}`;
        
        let geometry;
        let label;
        if (type === 'wall') {
            geometry = new THREE.BoxGeometry(2.0, 2.5, 0.1);
            label = `Wall ${customColliderCount}`;
        } else if (type === 'circle') {
            geometry = new THREE.CylinderGeometry(1.0, 1.0, 0.1, 32);
            label = `Circle ${customColliderCount}`;
        } else if (type === 'box') {
            geometry = new THREE.BoxGeometry(1.0, 1.0, 1.0);
            label = `Box ${customColliderCount}`;
        } else if (type === 'oval') {
            geometry = new THREE.SphereGeometry(0.7, 32, 16);
            label = `Oval ${customColliderCount}`;
        }
        
        const material = new THREE.MeshBasicMaterial({
            color: 0xeab308, 
            transparent: true,
            opacity: customCollidersVisible ? 0.35 : 0.0,
            wireframe: false,
            side: THREE.DoubleSide
        });
        
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(position);
        mesh.quaternion.copy(quaternion);
        
        mesh.userData = {
            id: id,
            label: label,
            movable: true,
            isCustom: true
        };
        
        const edges = new THREE.EdgesGeometry(geometry);
        const lineMat = new THREE.LineBasicMaterial({ color: 0xeab308, opacity: 0.8, transparent: true, visible: customCollidersVisible });
        const line = new THREE.LineSegments(edges, lineMat);
        mesh.add(line);
        mesh.userData.edgeHelper = line;
        
        scene.add(mesh);
        sceneBuilder.hitboxes.set(id, mesh);
        
        sceneBuilder.originalPositions.set(id, {
            hitbox: mesh.position.clone(),
            splat: new THREE.Vector3(),
            hitboxQuat: mesh.quaternion.clone(),
            splatQuat: new THREE.Quaternion()
        });

        selectCustomCollider(mesh);
        updateCustomColliderList();
    }

    function selectCustomCollider(mesh) {
        selectedCustomMesh = mesh;
        transformControls.detach();
        transformControls.attach(mesh);
        
        // Show crop action buttons if the selected mesh is a box
        const cropActions = document.getElementById('crop-actions');
        if (cropActions) {
            cropActions.style.display = mesh.userData.label.toLowerCase().includes('box') ? 'block' : 'none';
        }
        
        updateCustomColliderList();
    }

    function deleteCustomCollider(id) {
        const mesh = sceneBuilder.hitboxes.get(id);
        if (!mesh) return;
        
        if (transformControls.object === mesh) {
            transformControls.detach();
        }
        
        scene.remove(mesh);
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) mesh.material.dispose();
        if (mesh.userData.edgeHelper) {
            mesh.userData.edgeHelper.geometry.dispose();
            mesh.userData.edgeHelper.material.dispose();
        }
        
        sceneBuilder.hitboxes.delete(id);
        sceneBuilder.originalPositions.delete(id);
        
        if (selectedCustomMesh === mesh) {
            selectedCustomMesh = null;
            const cropActions = document.getElementById('crop-actions');
            if (cropActions) cropActions.style.display = 'none';
        }
        updateCustomColliderList();
    }

    function updateCustomColliderList() {
        if (!customMeshList) return;
        
        if (pendingPlacementType) {
            customMeshList.innerHTML = `<p style="font-size: 0.8rem; color: #eab308; text-align: center; margin: 8px 0; font-weight: 500;">🎯 Click in the scene to place the ${pendingPlacementType}...</p>`;
            return;
        }

        const items = Array.from(sceneBuilder.hitboxes.values()).filter(h => h.userData.isCustom);
        
        if (items.length === 0) {
            customMeshList.innerHTML = '<p style="font-size: 0.8rem; color: #9ca3af; text-align: center; margin: 5px 0;">No custom colliders added.</p>';
            return;
        }
        
        customMeshList.innerHTML = '';
        items.forEach(mesh => {
            const isSelected = selectedCustomMesh === mesh;
            const item = document.createElement('div');
            item.style.cssText = `display: flex; align-items: center; margin-bottom: 6px; padding: 4px 8px; border-radius: 4px; background: ${isSelected ? 'rgba(37,99,235,0.2)' : 'rgba(255,255,255,0.05)'}; border: 1px solid ${isSelected ? '#2563eb' : 'transparent'};`;
            item.innerHTML = `
                <span style="font-size: 0.85rem; color: white; cursor: pointer; flex: 1;">${mesh.userData.label}</span>
                <button class="edit-btn" style="background: none; border: none; color: #60a5fa; cursor: pointer; padding: 2px 6px; font-size: 0.75rem; width:auto; min-width:0; margin:0;" title="Edit Position">Edit</button>
                <button class="del-btn" style="background: none; border: none; color: #ef4444; cursor: pointer; padding: 2px 6px; font-size: 0.75rem; width:auto; min-width:0; margin:0;" title="Delete">Del</button>
            `;
            
            item.querySelector('span').addEventListener('click', () => selectCustomCollider(mesh));
            item.querySelector('.edit-btn').addEventListener('click', () => selectCustomCollider(mesh));
            item.querySelector('.del-btn').addEventListener('click', () => deleteCustomCollider(mesh.userData.id));
            
            customMeshList.appendChild(item);
        });
    }

    const addWallBtn = document.getElementById('add-wall-btn');
    const addCircleBtn = document.getElementById('add-circle-btn');
    const addBoxBtn = document.getElementById('add-box-btn');
    const addOvalBtn = document.getElementById('add-oval-btn');

    if (addWallBtn) addWallBtn.addEventListener('click', () => {
        pendingPlacementType = 'wall';
        document.body.style.cursor = 'crosshair';
        updateCustomColliderList();
    });
    if (addCircleBtn) addCircleBtn.addEventListener('click', () => {
        pendingPlacementType = 'circle';
        document.body.style.cursor = 'crosshair';
        updateCustomColliderList();
    });
    if (addBoxBtn) addBoxBtn.addEventListener('click', () => {
        pendingPlacementType = 'box';
        document.body.style.cursor = 'crosshair';
        updateCustomColliderList();
    });
    if (addOvalBtn) addOvalBtn.addEventListener('click', () => {
        pendingPlacementType = 'oval';
        document.body.style.cursor = 'crosshair';
        updateCustomColliderList();
    });

    async function cropSelectedSplat(cropInside) {
        if (!selectedCustomMesh) return;
        
        const manifestUrl = sessionStorage.getItem('vit_manifest_url');
        if (!manifestUrl) {
            alert("No active session found. Please upload a PLY file first.");
            return;
        }
        
        const parts = manifestUrl.split('/');
        const jobIndex = parts.indexOf('jobs');
        if (jobIndex === -1) {
            alert("Could not determine Job ID from manifest URL.");
            return;
        }
        const jobId = parts[jobIndex + 1];

        const box = selectedCustomMesh;
        const center = [box.position.x, box.position.y, box.position.z];
        const quat = [box.quaternion.x, box.quaternion.y, box.quaternion.z, box.quaternion.w];
        const scale = [box.scale.x, box.scale.y, box.scale.z];

        const statusEl = document.getElementById('scene-status');
        if (statusEl) {
            statusEl.innerText = "✂️ Cropping Splat: Rebuilding collision mesh (takes ~5s)...";
        }
        
        const insideBtn = document.getElementById('crop-inside-btn');
        const outsideBtn = document.getElementById('crop-outside-btn');
        if (insideBtn) insideBtn.disabled = true;
        if (outsideBtn) outsideBtn.disabled = true;

        try {
            const host = window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname;
            const response = await fetch(`http://${host}:8000/crop-ply`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    job_id: jobId,
                    box_center: center,
                    box_rotation: quat,
                    box_scale: scale,
                    crop_inside: cropInside
                })
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || "Failed to crop PLY");
            }

            const result = await response.json();
            console.log("Crop result:", result);

            transformControls.detach();
            selectedCustomMesh = null;
            const cropActions = document.getElementById('crop-actions');
            if (cropActions) cropActions.style.display = 'none';

            deleteCustomCollider(box.userData.id);

            sceneBuilder.clearScene();
            await sceneBuilder.loadFromManifest();

            if (statusEl) {
                statusEl.innerText = `✂️ Cropping complete! Retained ${result.retained_points} points.`;
            }
        } catch (e) {
            console.error(e);
            alert("Error during cropping: " + e.message);
            if (statusEl) {
                statusEl.innerText = "Error during cropping.";
            }
        } finally {
            if (insideBtn) insideBtn.disabled = false;
            if (outsideBtn) outsideBtn.disabled = false;
        }
    }

    const cropInsideBtn = document.getElementById('crop-inside-btn');
    const cropOutsideBtn = document.getElementById('crop-outside-btn');
    
    if (cropInsideBtn) cropInsideBtn.addEventListener('click', () => cropSelectedSplat(true));
    if (cropOutsideBtn) cropOutsideBtn.addEventListener('click', () => cropSelectedSplat(false));

    if (toggleCustomMeshVis) {
        toggleCustomMeshVis.addEventListener('change', (e) => {
            customCollidersVisible = e.target.checked;
            
            for (const mesh of sceneBuilder.hitboxes.values()) {
                if (mesh.userData.isCustom) {
                    mesh.material.opacity = customCollidersVisible ? 0.35 : 0.0;
                    if (mesh.userData.edgeHelper) {
                        mesh.userData.edgeHelper.visible = customCollidersVisible;
                    }
                }
            }
        });
    }

    // 11. Handle resize
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
}

// ── Boot the router ──────────────────────────────────────────────────────────
router.onRendererNeeded(initRenderer);
router.init();
