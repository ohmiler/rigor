import * as THREE from 'three';

export const UP = new THREE.Vector3(0, 1, 0);
export const DEG = Math.PI / 180;
// Highest ledge you walk up without climbing (car hood to roof is ~0.55 m).
export const STEP_UP = 0.6;

const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

// Character-local axes are (right, up, forward). Facing +Z, "right" is three.js -X.
export function localPoint(out, origin, quat, right, up, fwd) {
  return out.set(-right, up, fwd).applyQuaternion(quat).add(origin);
}

export function localDir(out, quat, right, up, fwd) {
  return out.set(-right, up, fwd).applyQuaternion(quat);
}

export function quatFrom(out, pitch, yaw, roll) {
  _e.set(pitch, yaw, roll, 'YXZ');
  return out.setFromEuler(_e);
}

export function rightOf(out, yaw) {
  return out.set(-Math.cos(yaw), 0, Math.sin(yaw));
}

export function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// Frame-rate independent exponential smoothing.
export function damp(a, b, lambda, dt) {
  return a + (b - a) * (1 - Math.exp(-lambda * dt));
}

export function dampAngle(a, b, lambda, dt) {
  return wrapAngle(a + wrapAngle(b - a) * (1 - Math.exp(-lambda * dt)));
}

export function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

// Spring that pulls pos toward target, with acceleration capped at maxAccel.
// This is what makes hands feel like they have mass instead of snapping.
// Damping acts on velocity relative to the target, so a target moving at
// constant speed (the gun while running) is tracked without lagging behind.
export function springVec(pos, vel, target, targetVel, stiffness, damping, maxAccel, dt) {
  _a.subVectors(target, pos).multiplyScalar(stiffness);
  _a.x -= damping * (vel.x - targetVel.x);
  _a.y -= damping * (vel.y - targetVel.y);
  _a.z -= damping * (vel.z - targetVel.z);
  if (_a.length() > maxAccel) _a.setLength(maxAccel);
  vel.addScaledVector(_a, dt);
  pos.addScaledVector(vel, dt);
}

/**
 * Analytic two-bone IK (shoulder-elbow-wrist, hip-knee-ankle).
 * Writes the middle joint into outMid and the reachable end point into outEnd.
 * `pole` is a direction the middle joint should bend toward.
 */
export function solveTwoBone(root, target, lenA, lenB, pole, outMid, outEnd) {
  _d.subVectors(target, root);
  const dist = THREE.MathUtils.clamp(
    _d.length(),
    Math.abs(lenA - lenB) + 1e-4,
    (lenA + lenB) * 0.999,
  );
  _d.normalize();
  outEnd.copy(root).addScaledVector(_d, dist);

  // Law of cosines: how far along the root->end line the middle joint projects.
  const along = (lenA * lenA - lenB * lenB + dist * dist) / (2 * dist);
  const height = Math.sqrt(Math.max(lenA * lenA - along * along, 0));

  _p.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_p.lengthSq() < 1e-8) _p.set(0, 0, 1).addScaledVector(_d, -_d.z);
  _p.normalize();

  outMid.copy(root).addScaledVector(_d, along).addScaledVector(_p, height);
  return dist;
}

// A capsule limb placed between two joint positions each frame.
export class Segment {
  constructor(parent, material, length, radius) {
    const geometry = new THREE.CapsuleGeometry(radius, Math.max(length - radius * 2, 0.001), 4, 12);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.castShadow = true;
    parent.add(this.mesh);
  }

  place(a, b) {
    _d.subVectors(b, a);
    const len = _d.length();
    if (len < 1e-6) return;
    this.mesh.position.addVectors(a, b).multiplyScalar(0.5);
    this.mesh.quaternion.setFromUnitVectors(UP, _d.divideScalar(len));
  }
}
