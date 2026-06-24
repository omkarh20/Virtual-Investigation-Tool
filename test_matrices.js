const pc = require('playcanvas');

const camPos = new pc.Vec3(0, 0, 5);
const camTarget = new pc.Vec3(0, 0, 0);
const up = new pc.Vec3(0, 1, 0);

const viewMat = new pc.Mat4();
viewMat.setLookAt(camPos, camTarget, up);

console.log("PlayCanvas viewMat data:");
console.log(viewMat.data);

const THREE = require('three');
const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
cam.position.set(0, 0, 5);
cam.lookAt(0, 0, 0);
cam.updateMatrixWorld();

console.log("Three.js matrixWorldInverse elements:");
console.log(cam.matrixWorldInverse.elements);
