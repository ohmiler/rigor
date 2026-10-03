import * as THREE from 'three';
import { Humanoid } from './humanoid.js';

// Thrown bottles: they arc to where they were aimed, smash on whatever they
// hit first (the ground, a car, a wall), throw glass about, and make a noise
// that draws anything that hasn't seen you yet.

const GRAVITY = 9.8;
const glass = new THREE.MeshStandardMaterial({ color: '#3f6b3a', roughness: 0.2, transparent: true, opacity: 0.85 });
const shardGeo = new THREE.BoxGeometry(0.03, 0.006, 0.02);
const _v = new THREE.Vector3();

function bottleMesh() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.16, 10), glass);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.02, 0.08, 8), glass);
  neck.position.y = 0.12;
  body.castShadow = true;
  g.add(body, neck);
  return g;
}

export class Throwables {
  /** `onBreak(pos)` is called where a bottle smashes. */
  constructor(scene, onBreak) {
    this.scene = scene;
    this.onBreak = onBreak;
    this.flying = [];
    this.shards = [];
  }

  // Lob from `from` to land at `to`: a quicker, flatter throw for a short distance.
  lob(from, to) {
    const mesh = bottleMesh();
    mesh.position.copy(from);
    this.scene.add(mesh);
    const ground = Humanoid.terrain.heightAt(to.x, to.z, to.y + 0.5);
    const target = _v.set(to.x, ground + 0.03, to.z);
    const dist = Math.hypot(target.x - from.x, target.z - from.z);
    const t = Math.min(Math.max(dist / 9, 0.3), 0.9);
    const vel = new THREE.Vector3().subVectors(target, from).divideScalar(t);
    vel.y += 0.5 * GRAVITY * t;
    this.flying.push({ mesh, vel, spin: new THREE.Vector3(8 + Math.random() * 6, Math.random() * 3, 0), age: 0 });
  }

  update(dt) {
    if (dt <= 0) return;
    const terrain = Humanoid.terrain;
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const b = this.flying[i];
      b.age += dt;
      b.vel.y -= GRAVITY * dt;
      const p = b.mesh.position;
      p.addScaledVector(b.vel, dt);
      b.mesh.rotation.x += b.spin.x * dt;
      b.mesh.rotation.y += b.spin.y * dt;
      // Smashes on the ground or the top of something, or against a wall it flies into.
      const floor = terrain.heightAt(p.x, p.z, p.y + 0.05);
      _v.copy(p);
      terrain.collide?.(_v, 0.04, p.y - 0.04, 0.05);
      const hitWall = _v.distanceToSquared(p) > 1e-6;
      if (p.y <= floor + 0.04 || hitWall || b.age > 3) {
        if (hitWall) p.copy(_v);
        p.y = Math.max(p.y, floor + 0.04);
        this._smash(p.clone(), b.vel);
        this.scene.remove(b.mesh);
        this.flying.splice(i, 1);
      }
    }
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      s.life -= dt;
      if (!s.landed) {
        s.vel.y -= GRAVITY * dt;
        s.mesh.position.addScaledVector(s.vel, dt);
        s.mesh.rotation.x += s.spin * dt;
        const floor = terrain.heightAt(s.mesh.position.x, s.mesh.position.z, s.mesh.position.y + 0.1);
        if (s.mesh.position.y <= floor + 0.004) {
          s.mesh.position.y = floor + 0.004;
          s.mesh.rotation.set(0, Math.random() * Math.PI, 0);
          s.landed = true;
        }
      }
      if (s.life <= 0) {
        this.scene.remove(s.mesh);
        this.shards.splice(i, 1);
      }
    }
  }

  _smash(pos, vel) {
    for (let i = 0; i < 14; i++) {
      const mesh = new THREE.Mesh(shardGeo, glass);
      mesh.position.copy(pos);
      this.scene.add(mesh);
      const v = new THREE.Vector3((Math.random() - 0.5) * 3, 0.8 + Math.random() * 1.8, (Math.random() - 0.5) * 3).addScaledVector(vel, 0.15);
      this.shards.push({ mesh, vel: v, spin: (Math.random() - 0.5) * 30, life: 20 + Math.random() * 10, landed: false });
    }
    this.onBreak?.(pos);
  }

  clear() {
    for (const b of this.flying) this.scene.remove(b.mesh);
    for (const s of this.shards) this.scene.remove(s.mesh);
    this.flying = [];
    this.shards = [];
  }
}
