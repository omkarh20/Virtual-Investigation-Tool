/**
 * FPSControls — Right-click-drag to look, WASD to move, R/F for up/down.
 *
 * Unlike Three.js FlyControls which tracks absolute cursor position (causing
 * the camera to snap to wherever you click), this uses movementX/Y deltas
 * from pointer events, giving smooth and predictable orientation changes.
 */
import * as THREE from 'three';

export class FPSControls {
    /**
     * @param {THREE.Camera} camera
     * @param {HTMLElement} domElement
     */
    constructor(camera, domElement) {
        this.camera = camera;
        this.domElement = domElement;
        this.enabled = true;

        // Speeds
        this.movementSpeed = 3;
        this.lookSpeed = 0.002;

        // Internal state
        this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
        this._moveState = { forward: 0, back: 0, left: 0, right: 0, up: 0, down: 0 };
        this._moveVector = new THREE.Vector3();
        this._isDragging = false;

        // Bind handlers
        this._onKeyDown = this._handleKeyDown.bind(this);
        this._onKeyUp = this._handleKeyUp.bind(this);
        this._onPointerDown = this._handlePointerDown.bind(this);
        this._onPointerMove = this._handlePointerMove.bind(this);
        this._onPointerUp = this._handlePointerUp.bind(this);
        this._onContextMenu = (e) => e.preventDefault();

        // Attach listeners
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
        this.domElement.addEventListener('pointerdown', this._onPointerDown);
        this.domElement.addEventListener('pointermove', this._onPointerMove);
        this.domElement.addEventListener('pointerup', this._onPointerUp);
        this.domElement.addEventListener('contextmenu', this._onContextMenu);
    }

    update(delta) {
        if (!this.enabled) return;

        const speed = this.movementSpeed * delta;

        // Update movement vector from key state
        this._moveVector.set(
            (-this._moveState.left + this._moveState.right),
            (-this._moveState.down + this._moveState.up),
            (-this._moveState.forward + this._moveState.back)
        );

        // Move relative to camera orientation
        this.camera.translateX(this._moveVector.x * speed);
        this.camera.translateY(this._moveVector.y * speed);
        this.camera.translateZ(this._moveVector.z * speed);
    }

    _handleKeyDown(event) {
        if (!this.enabled || event.altKey) return;

        switch (event.code) {
            case 'KeyW': this._moveState.forward = 1; break;
            case 'KeyS': this._moveState.back = 1; break;
            case 'KeyA': this._moveState.left = 1; break;
            case 'KeyD': this._moveState.right = 1; break;
            case 'KeyR': this._moveState.up = 1; break;
            case 'KeyF': this._moveState.down = 1; break;
        }
    }

    _handleKeyUp(event) {
        if (!this.enabled) return;

        switch (event.code) {
            case 'KeyW': this._moveState.forward = 0; break;
            case 'KeyS': this._moveState.back = 0; break;
            case 'KeyA': this._moveState.left = 0; break;
            case 'KeyD': this._moveState.right = 0; break;
            case 'KeyR': this._moveState.up = 0; break;
            case 'KeyF': this._moveState.down = 0; break;
        }
    }

    _handlePointerDown(event) {
        if (!this.enabled) return;

        // Right-click (button 2) to look around
        if (event.button === 2) {
            this._isDragging = true;
            this.domElement.setPointerCapture(event.pointerId);
        }
    }

    _handlePointerMove(event) {
        if (!this.enabled || !this._isDragging) return;

        // Use movementX/Y — smooth deltas, no snapping
        const movementX = event.movementX || 0;
        const movementY = event.movementY || 0;

        this._euler.setFromQuaternion(this.camera.quaternion);
        this._euler.y -= movementX * this.lookSpeed;
        this._euler.x -= movementY * this.lookSpeed;

        // Clamp pitch to avoid flipping
        this._euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this._euler.x));

        this.camera.quaternion.setFromEuler(this._euler);
    }

    _handlePointerUp(event) {
        if (!this.enabled) return;

        if (event.button === 2) {
            this._isDragging = false;
            this.domElement.releasePointerCapture(event.pointerId);
        }
    }

    dispose() {
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
        this.domElement.removeEventListener('pointerdown', this._onPointerDown);
        this.domElement.removeEventListener('pointermove', this._onPointerMove);
        this.domElement.removeEventListener('pointerup', this._onPointerUp);
        this.domElement.removeEventListener('contextmenu', this._onContextMenu);
    }
}
