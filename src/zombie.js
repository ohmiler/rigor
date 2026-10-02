import * as THREE from 'three';
import { Humanoid } from './humanoid.js';
import { DEG, dampAngle, damp, localPoint } from './rig-utils.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const rand = (a, b) => a + Math.random() * (b - a);

const SKINS = ['#9aa58a', '#8d9a80', '#a3a08a', '#a89c8c', '#8f9c94'];
const SHIRTS = ['#6b5a4a', '#4f5d6b', '#7a3e3a', '#5a6b4f', '#8a8576', '#3d4a5c', '#6e6a5e'];
const PANTS = ['#3b3a36', '#2f3a4a', '#4a4036', '#35302b'];
const HAIR = ['#1f1b17', '#2d241c', '#4a3b2c', null];

export const HIT_RADIUS = 0.28;
export const HIT_HEIGHT = 1.75;
const HEAD_HEIGHT = 1.42;

/**
 * Same body system as the player, tuned to look broken: a limp on one leg,
 * a hunched spine, loose arms on soft springs, and a slow turn rate.
 */
export class Zombie extends Humanoid {
  constructor(scene, params, position) {
    const hair = pick(HAIR);
    super(scene, params, {
      skin: pick(SKINS),
      shirt: pick(SHIRTS),
      pants: pick(PANTS),
      shoes: '#22201d',
      cap: hair,
      brim: false,
    });

    // Per-zombie variation so a crowd never moves in sync.
    this.quirk = {
      speed: rand(0.75, 1.2),
      limpSide: Math.random() < 0.5 ? -1 : 1,
      limp: rand(0.4, 1),
      hunch: rand(0.6, 1.3),
      headTilt: rand(-0.35, 0.35),
      seed: Math.random() * 100,
      armLift: [rand(0.7, 1.15), rand(0.7, 1.15)],
    };

    this.pos.copy(position);
    this.aimYaw = rand(-Math.PI, Math.PI);
    this.health = params.health;
    this.state = 'wander';
    this.wanderTarget = new THREE.Vector3().copy(position);
    this.wanderTimer = 0;
    this.stagger = 0;
    this.reach = 0;
    this.time = 0;
    this.player = null;

    this.dead = false;
    this.deathT = 0;
    this.fallAxis = new THREE.Vector3();
    this.removed = false;

    this._applyLimp();
    this._settle();
  }

  _applyLimp() {
    const q = this.quirk;
    const limp = q.limp * this.params.limp;
    const bad = this.feet[q.limpSide < 0 ? 0 : 1];
    bad.stepScale = 1 - limp * 0.7; // the bad leg barely lifts: it drags
    this.feet[1].offset = 0.5 + limp * 0.12 * q.limpSide; // uneven rhythm
  }

  // ---------------------------------------------------------------- update

  update(dt, world) {
    if (this.dead) {
      this._updateDeath(dt);
      return;
    }
    const p = this.params;
    this.time += dt;
    this.player = world.player;

    _v1.subVectors(world.player.pos, this.pos);
    _v1.y = 0;
    const dist = _v1.length();
    if (this.state === 'wander' && dist < p.detectRange) this.state = 'chase';

    _desired.set(0, 0, 0);
    let faceYaw = this.aimYaw;
    if (this.state === 'chase') {
      faceYaw = Math.atan2(_v1.x, _v1.z);
      if (dist > p.attackRange) _desired.copy(_v1).setLength(p.chaseSpeed * this.quirk.speed);
    } else {
      this.wanderTimer -= dt;
      _v2.subVectors(this.wanderTarget, this.pos);
      _v2.y = 0;
      if (this.wanderTimer <= 0 || _v2.length() < 0.4) {
        this.wanderTimer = rand(4, 9);
        this.wanderTarget.set(this.pos.x + rand(-5, 5), 0, this.pos.z + rand(-5, 5));
      } else if (_v2.length() > 0.4) {
        _desired.copy(_v2).setLength(p.wanderSpeed * this.quirk.speed);
        faceYaw = Math.atan2(_v2.x, _v2.z);
      }
    }

    // Keep a little personal space so a crowd doesn't merge into one body.
    for (const other of world.zombies) {
      if (other === this || other.dead) continue;
      _v2.subVectors(this.pos, other.pos);
      _v2.y = 0;
      const d = _v2.length();
      if (d > 0.001 && d < 0.75) _desired.addScaledVector(_v2, ((0.75 - d) / d) * 2);
    }

    if (this.stagger > 0) {
      this.stagger -= dt;
      _desired.multiplyScalar(0.15);
    }

    this.aimYaw = dampAngle(this.aimYaw, faceYaw, p.turnRate, dt);
    this._locomote(dt, _desired);

    // Posture: hunched forward with the head craned up to look ahead, and the
    // whole body dipping toward the bad leg while it's taking weight.
    const q = this.quirk;
    const bad = this.feet[q.limpSide < 0 ? 0 : 1];
    const dip = bad.planted && this.speed > 0.1 ? Math.sin(bad.progress * Math.PI) : 0;
    this.posture.pitch = p.hunch * DEG * q.hunch + Math.sin(this.time * 1.3 + q.seed) * 0.04;
    this.posture.roll = -q.limpSide * dip * q.limp * p.limp * 0.18;
    this.posture.headPitch = -this.posture.pitch * 0.7;
    this.posture.headRoll = q.headTilt;

    this._updateBody(dt);
    this._poseBody(dt);
  }

  // Arms hang while wandering and reach out once it has seen you; within
  // arm's length they grab toward your chest.
  _setHandTargets(dt) {
    const p = this.params;
    const q = this.quirk;
    const chasing = this.state === 'chase' && this.stagger <= 0;
    this.reach = damp(this.reach, chasing ? 1 : 0.15, 3, dt || 0);

    const near = this.player && this.player.pos.distanceTo(this.pos) < 1.3;
    for (const [i, hand] of [this.hands.left, this.hands.right].entries()) {
      const side = i === 0 ? -1 : 1;
      const sway = Math.sin(this.time * 2.1 + q.seed + i * 1.7) * 0.05;
      // Hanging: down by the hip, swinging a little with the walk.
      localPoint(_v1, this.chestPos, this.chestQuat, side * 0.22, -0.48, 0.06 + sway);
      // Reaching: forward at shoulder height, each arm a bit different.
      localPoint(_v2, this.chestPos, this.chestQuat, side * 0.14, 0.02 + sway * q.armLift[i], p.armReach * q.armLift[i]);
      if (near && chasing) _v2.lerp(this.player.chestPos, 0.6);
      hand.target.lerpVectors(_v1, _v2, this.reach);
    }
  }

  // ---------------------------------------------------------------- damage

  // Ray vs. vertical capsule (good enough for a top-down shooter).
  raycast(origin, dir) {
    if (this.dead) return null;
    const ox = origin.x - this.pos.x;
    const oz = origin.z - this.pos.z;
    const a = dir.x * dir.x + dir.z * dir.z;
    if (a < 1e-6) return null;
    const b = 2 * (ox * dir.x + oz * dir.z);
    const c = ox * ox + oz * oz - HIT_RADIUS * HIT_RADIUS;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0) return null;
    const y = origin.y + dir.y * t;
    if (y < 0 || y > HIT_HEIGHT) return null;
    return { distance: t, headshot: y > HEAD_HEIGHT };
  }

  takeHit(dir, damage) {
    if (this.dead) return;
    this.health -= damage;
    this.state = 'chase';
    this.stagger = 0.35;
    // Shove the torso spring and throw the arms back along the bullet.
    this.leanVel.x += dir.x * this.params.hitShove;
    this.leanVel.y += dir.z * this.params.hitShove;
    for (const h of [this.hands.left, this.hands.right]) h.vel.addScaledVector(dir, 3);
    if (this.health <= 0) this._die(dir);
  }

  alert() {
    if (!this.dead) this.state = 'chase';
  }

  _die(dir) {
    this.dead = true;
    this.deathT = 0;
    // Tip over around the feet, in the direction the last bullet was going.
    _v1.set(dir.x, 0, dir.z).normalize();
    this.fallAxis.crossVectors(UP, _v1).normalize();
    this.pivot = this.pos.clone();
    this.body.matrixAutoUpdate = false;
    for (const m of this.markers) m.visible = false;
  }

  _updateDeath(dt) {
    this.deathT += dt;
    const t = Math.min(this.deathT / 0.75, 1);
    // Accelerate like a falling plank, then a small bounce on the ground.
    const fall = t * t;
    const bounce = this.deathT > 0.75 ? Math.sin((this.deathT - 0.75) * 18) * Math.exp(-(this.deathT - 0.75) * 9) * 0.08 : 0;
    const angle = (86 * fall) * DEG - bounce;
    _m1.makeTranslation(-this.pivot.x, 0, -this.pivot.z);
    _m2.makeRotationAxis(this.fallAxis, angle);
    this.body.matrix.makeTranslation(this.pivot.x, 0, this.pivot.z).multiply(_m2).multiply(_m1);
    this.body.matrixWorldNeedsUpdate = true;
    if (this.deathT > this.params.corpseTime) {
      this.dispose();
      this.removed = true;
    }
  }
}
