import './style.css';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
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

    // 4. Grid helper
    const gridHelper = new THREE.GridHelper(10, 10, 0x4f46e5, 0x4f46e5);
    gridHelper.material.opacity = 0.2;
    gridHelper.material.transparent = true;
    scene.add(gridHelper);

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
            } else {
                fpsControls.enabled = false;
                orbitControls.enabled = true;
                activeControls = orbitControls;
                toggleCameraBtn.innerText = 'Camera: Orbit';
            }
        });
    }

    // 6. Transform Controls (Gizmo)
    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode('translate');
    transformControls.setSize(0.8);
    scene.add(transformControls.getHelper());

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
    sceneBuilder.loadFromManifest();

    // 8. Virtual Camera Manager
    const vcManager = new VirtualCameraManager(scene, camera, renderer, transformControls);

    // 8.5. VR Manager
    const vrManager = new VRSessionManager(renderer, scene, camera, sceneBuilder.hitboxes, physicsManager);

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

    // 9.5 Physics Toggle
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

        if (activeControls === orbitControls) {
            orbitControls.update();
        } else {
            fpsControls.update(delta);
        }

        if (window.physicsEnabled) {
            physicsManager.update(delta, sceneBuilder.hitboxes);
            sceneBuilder.syncSplatsToHitboxes();
        }
        
        // VR controller step
        vrManager.update();

        // Pause main render while VirtualCameraManager is exporting
        if (!vcManager.isExporting) {
            renderer.render(scene, camera);
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
