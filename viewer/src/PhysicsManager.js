import * as CANNON from 'cannon-es';
import * as THREE from 'three';

export class PhysicsManager {
    constructor() {
        this.world = new CANNON.World({
            gravity: new CANNON.Vec3(0, -9.81, 0), // Gravity restored!
        });
        
        // Default material for objects
        this.defaultMaterial = new CANNON.Material('default');
        const defaultContactMaterial = new CANNON.ContactMaterial(this.defaultMaterial, this.defaultMaterial, {
            friction: 0.5,
            restitution: 0.1, // slightly bouncy
        });
        this.world.addContactMaterial(defaultContactMaterial);
        
        this.bodies = new Map(); // id -> CANNON.Body
        this.kinematicBodies = new Set(); // ids of bodies currently being dragged by user
    }

    createBodyFromMesh(id, mesh, isMovable) {
        if (!isMovable) {
            // FIX: Create a hollow room based on the bounding box of the background!
            // This prevents the explosion while keeping objects inside the boundaries.
            mesh.geometry.computeBoundingBox();
            const bbox = mesh.geometry.boundingBox;
            const size = new THREE.Vector3();
            bbox.getSize(size);
            const center = new THREE.Vector3();
            bbox.getCenter(center);
            
            const thickness = 0.5; // thickness of the invisible walls
            const body = new CANNON.Body({ mass: 0 }); // static body
            
            // Floor
            body.addShape(new CANNON.Box(new CANNON.Vec3(size.x / 2 + thickness, thickness, size.z / 2 + thickness)), new CANNON.Vec3(center.x, bbox.min.y - thickness, center.z));
            // Ceiling
            body.addShape(new CANNON.Box(new CANNON.Vec3(size.x / 2 + thickness, thickness, size.z / 2 + thickness)), new CANNON.Vec3(center.x, bbox.max.y + thickness, center.z));
            // Left Wall
            body.addShape(new CANNON.Box(new CANNON.Vec3(thickness, size.y / 2, size.z / 2)), new CANNON.Vec3(bbox.min.x - thickness, center.y, center.z));
            // Right Wall
            body.addShape(new CANNON.Box(new CANNON.Vec3(thickness, size.y / 2, size.z / 2)), new CANNON.Vec3(bbox.max.x + thickness, center.y, center.z));
            // Front Wall
            body.addShape(new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, thickness)), new CANNON.Vec3(center.x, center.y, bbox.min.z - thickness));
            // Back Wall
            body.addShape(new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, thickness)), new CANNON.Vec3(center.x, center.y, bbox.max.z + thickness));

            body.position.copy(mesh.position);
            body.quaternion.copy(mesh.quaternion);
            
            this.world.addBody(body);
            this.bodies.set(id, body);
            return body;
        }

        const geometry = mesh.geometry;
        const positionAttr = geometry.attributes.position;
        const indexAttr = geometry.index;
        
        const vertices = [];
        for (let i = 0; i < positionAttr.count; i++) {
            vertices.push(new CANNON.Vec3(
                positionAttr.getX(i),
                positionAttr.getY(i),
                positionAttr.getZ(i)
            ));
        }

        const faces = [];
        if (indexAttr) {
            for (let i = 0; i < indexAttr.count; i += 3) {
                faces.push([
                    indexAttr.getX(i),
                    indexAttr.getX(i+1),
                    indexAttr.getX(i+2)
                ]);
            }
        } else {
            for (let i = 0; i < positionAttr.count; i += 3) {
                faces.push([i, i+1, i+2]);
            }
        }

        let shape;
        try {
            // Since vr_exporter generated a strict convex hull, this should succeed perfectly.
            shape = new CANNON.ConvexPolyhedron({ vertices, faces });
        } catch(e) {
            console.warn(`[Physics] ConvexPolyhedron failed for ${id}, falling back to Box.`, e);
            geometry.computeBoundingBox();
            const bbox = geometry.boundingBox;
            const size = new THREE.Vector3();
            bbox.getSize(size);
            shape = new CANNON.Box(new CANNON.Vec3(size.x/2, size.y/2, size.z/2));
        }

        const mass = isMovable ? 1 : 0; // mass 0 makes the object completely static (like the floor)

        const body = new CANNON.Body({
            mass: mass,
            shape: shape,
            material: this.defaultMaterial,
            position: new CANNON.Vec3(mesh.position.x, mesh.position.y, mesh.position.z),
            quaternion: new CANNON.Quaternion(mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w)
        });

        // Add damping so things eventually come to rest
        if (isMovable) {
            body.linearDamping = 0.4;
            body.angularDamping = 0.4;
        }

        this.world.addBody(body);
        this.bodies.set(id, body);
        return body;
    }

    setKinematic(id, kinematic) {
        const body = this.bodies.get(id);
        if (!body) return;
        
        if (kinematic) {
            // Pause physics forces for this object so the user can drag it
            body.type = CANNON.Body.KINEMATIC;
            body.velocity.set(0, 0, 0);
            body.angularVelocity.set(0, 0, 0);
            this.kinematicBodies.add(id);
        } else {
            // Re-enable gravity
            body.type = CANNON.Body.DYNAMIC;
            body.wakeUp();
            this.kinematicBodies.delete(id);
        }
    }

    updateBodyTransform(id, position, quaternion) {
        // Sync user's manual dragging back into the physics engine
        const body = this.bodies.get(id);
        if (!body) return;
        body.position.copy(position);
        body.quaternion.copy(quaternion);
    }

    resetAll() {
        // Stop all momentum on reset
        for (const body of this.bodies.values()) {
            body.velocity.set(0,0,0);
            body.angularVelocity.set(0,0,0);
        }
    }

    update(deltaTime, hitboxesMap) {
        // Max 3 substeps for stability
        this.world.step(1/60, deltaTime, 3);

        // Sync physics engine back to the Three.js scene
        for (const [id, body] of this.bodies.entries()) {
            if (this.kinematicBodies.has(id)) continue; // skip objects currently grabbed by user
            
            const hitbox = hitboxesMap.get(id);
            if (!hitbox) continue;

            hitbox.position.copy(body.position);
            hitbox.quaternion.copy(body.quaternion);
        }
    }
}
