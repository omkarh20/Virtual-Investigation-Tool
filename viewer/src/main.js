import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FlyControls } from 'three/examples/jsm/controls/FlyControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { SparkRenderer } from '@sparkjsdev/spark';
import { SceneBuilder } from './SceneBuilder.js';
import { VirtualCameraManager } from './VirtualCameraManager.js';

// 1. Initialize Scene, Camera, Renderer
const appContainer = document.getElementById('app');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f172a); // dark slate

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 1.5, 3); // Slightly elevated

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
appContainer.appendChild(renderer.domElement);

// 2. Initialize SparkRenderer
const spark = new SparkRenderer({ renderer });
scene.add(spark);

// 3. Lighting (Useful for dummy objects, less so for splats which are emissive)
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 1);
dirLight.position.set(5, 10, 7);
scene.add(dirLight);

// Add a grid helper for grounding
const gridHelper = new THREE.GridHelper(10, 10, 0x4f46e5, 0x4f46e5);
gridHelper.material.opacity = 0.2;
gridHelper.material.transparent = true;
scene.add(gridHelper);

// 4. Camera Controls
const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;
orbitControls.dampingFactor = 0.05;

const flyControls = new FlyControls(camera, renderer.domElement);
flyControls.movementSpeed = 3;
flyControls.rollSpeed = Math.PI / 10;
flyControls.dragToLook = true;

// Fix FlyControls getting stuck in drag mode if mouse is released outside the canvas
renderer.domElement.addEventListener('pointerdown', (event) => {
    renderer.domElement.setPointerCapture(event.pointerId);
});
renderer.domElement.addEventListener('pointerup', (event) => {
    renderer.domElement.releasePointerCapture(event.pointerId);
});

let activeControls = orbitControls;

const toggleCameraBtn = document.getElementById('toggle-camera-btn');
if (toggleCameraBtn) {
    toggleCameraBtn.addEventListener('click', () => {
        if (activeControls === orbitControls) {
            activeControls = flyControls;
            toggleCameraBtn.innerText = "Camera: Fly (WASD)";
        } else {
            activeControls = orbitControls;
            toggleCameraBtn.innerText = "Camera: Orbit";
        }
    });
}

// 5. Transform Controls (Gizmo)
const transformControls = new TransformControls(camera, renderer.domElement);
transformControls.setMode('translate'); // translate mode by default
transformControls.setSize(0.8); // slightly smaller gizmo
scene.add(transformControls.getHelper()); // Must use getHelper() to add the visual gizmo to the scene

// Functions to disable/enable camera controls while dragging gizmo
function disableControls() {
    orbitControls.enabled = false;
    flyControls.enabled = false;
}
function enableControls() {
    orbitControls.enabled = true;
    flyControls.enabled = true;
}

// 6. Build Scene — pass gizmo and control functions to SceneBuilder
const sceneBuilder = new SceneBuilder(scene, camera, transformControls, disableControls, enableControls);
sceneBuilder.loadFromManifest();

// 6.2 Virtual Camera Manager
const vcManager = new VirtualCameraManager(scene, camera, renderer, transformControls);

// 6.5 File Upload Logic
const loadFileBtn = document.getElementById('load-file-btn');
const fileInput = document.getElementById('file-input');

if (loadFileBtn && fileInput) {
    loadFileBtn.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (file) {
            sceneBuilder.loadFromFile(file);
        }
        fileInput.value = '';
    });
}

// 7. Animation Loop & FPS counter
const fpsCounter = document.getElementById('fps-counter');
const clock = new THREE.Clock();
let lastTime = performance.now();
let frames = 0;

function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();

    if (activeControls === orbitControls) {
        orbitControls.update();
    } else {
        flyControls.update(delta);
    }
    
    // Pause rendering to the main canvas if VirtualCameraManager is currently exporting
    // This prevents the main loop from overriding the WebWorker's splat sorting for the export cameras!
    if (!vcManager.isExporting) {
        renderer.render(scene, camera);
    }

    // Calculate FPS
    const time = performance.now();
    frames++;
    if (time >= lastTime + 1000) {
        if (fpsCounter) {
            fpsCounter.innerText = Math.round((frames * 1000) / (time - lastTime)).toString();
        }
        lastTime = time;
        frames = 0;
    }
}

animate();

// Handle Window Resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
