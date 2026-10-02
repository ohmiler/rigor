import * as THREE from 'three';
import { Humanoid } from './humanoid.js';
import { DEG, wrapAngle, dampAngle, localPoint, localDir, quatFrom } from './rig-utils.js';

const _v1 = new THREE.Vector3();

// Points in gun space: (right, up, forward).
const GRIP = [0, -0.1, -0.05];
const SUPPORT = [0, -0.08, 0.24];
const MAG_SEAT = [0, -0.13, 0.08];
const MAG_IN_HAND_UP = 0.09;

// Each reload stage is a target for the left hand. The next stage only starts
// once the hand actually touches the target (contact-gated), not after a timer.
const RELOAD_STEPS = [
  { name: 'Eject the old mag', frame: 'gun', p: [0, -0.18, 0.16], start: 'eject' },
  { name: 'Reach the left hip', frame: 'pelvis', p: [-0.21, 0.02, 0.06] },
  { name: 'Grip the new mag', frame: 'pelvis', p: [-0.21, -0.02, 0.06], end: 'take', minTime: 0.12 },
  { name: 'Align below the port', frame: 'gun', p: [0, -0.4, 0.08] },
  { name: 'Seat the mag', frame: 'gun', p: [0, -0.22, 0.08], end: 'seat' },
  { name: 'Restore the support grip', frame: 'gun', p: SUPPORT },
];

const PLAYER_LOOK = {
  skin: '#e0ac86',
  shirt: '#3f86d4',
  pants: '#283447',
  shoes: '#1d2129',
  cap: '#24324f',
  brim: true,
};

export class Player extends Humanoid {
  constructor(scene, params) {
    super(scene, params, PLAYER_LOOK);

    this.gunPos = new THREE.Vector3();
    this.gunQuat = new THREE.Quaternion();
    this.reload = { active: false, step: -1, t: 0, label: 'Ready' };
    this.magState = 'gun';
    this.drops = [];

    // Recoil is a set of springs on the gun: kick back, muzzle climb, sideways yaw.
    this.recoil = { back: 0, backVel: 0, pitch: 0, pitchVel: 0, yaw: 0, yawVel: 0 };
    this.ammo = params.magSize;
    this.fireCooldown = 0;
    this.onShot = null; // (muzzle: Vector3, dir: Vector3) => void

    this._buildGun();
    this._settle();
  }

  _buildGun() {
    const mat = (color, roughness) => new THREE.MeshStandardMaterial({ color, roughness });
    const m = this.materials;
    m.gun = mat('#1e2024', 0.45);
    m.gunAccent = mat('#3a3d44', 0.5);
    m.mag = mat('#d39b2a', 0.6);
    const box = this.box;

    this.gun = new THREE.Group();
    box(this.gun, m.gun, 0.06, 0.09, 0.42, 0, 0, 0.08);
    box(this.gun, m.gunAccent, 0.05, 0.1, 0.18, 0, -0.02, -0.21);
    box(this.gun, m.gun, 0.035, 0.1, 0.045, 0, -0.08, -0.05).rotation.x = -0.3;
    box(this.gun, m.gun, 0.03, 0.06, 0.035, 0, -0.075, 0.24);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.22, 10), m.gunAccent);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.01, 0.4);
    barrel.castShadow = true;
    this.gun.add(barrel);
    this.body.add(this.gun);

    this.mag = box(this.body, m.mag, 0.04, 0.16, 0.07);
    this.casingGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.03, 6).rotateX(Math.PI / 2);
    this.casingMat = new THREE.MeshStandardMaterial({ color: '#d9b45a', metalness: 0.8, roughness: 0.35 });
  }

  // ---------------------------------------------------------------- update

  update(dt, input) {
    const p = this.params;

    _v1.set(input.x, 0, input.z);
    if (_v1.lengthSq() > 1) _v1.normalize();
    this._locomote(dt, _v1.multiplyScalar(input.walk ? p.walkSpeed : p.runSpeed));

    let aimTarget = this.aimYaw;
    if (p.faceMouse && input.aimPoint) {
      const dx = input.aimPoint.x - this.pos.x;
      const dz = input.aimPoint.z - this.pos.z;
      if (dx * dx + dz * dz > 0.16) aimTarget = Math.atan2(dx, dz);
    } else if (!p.faceMouse && this.speed > 0.3) {
      aimTarget = Math.atan2(this.vel.x, this.vel.z);
    }
    this.aimYaw = dampAngle(this.aimYaw, aimTarget, p.aimTurnRate, dt);
    this.chestYawOffset = p.gunLead * DEG;

    this._updateFiring(dt, input.fire);
    this._updateRecoil(dt);
    this._updateBody(dt);
    this._updateReload(dt);
    this._updateDrops(dt);
    this._poseBody(dt);
  }

  // ---------------------------------------------------------------- weapon

  _updateFiring(dt, triggerHeld) {
    const p = this.params;
    this.fireCooldown = Math.max(this.fireCooldown - dt, 0);
    if (!triggerHeld || this.reload.active) return;
    if (this.ammo <= 0) {
      if (p.autoReload) this.startReload();
      return;
    }
    while (this.fireCooldown <= 0 && this.ammo > 0) {
      this._shoot();
      this.fireCooldown += 60 / p.fireRate;
    }
  }

  _shoot() {
    const p = this.params;
    const r = this.recoil;
    this.ammo--;

    // Impulses go into velocities; the springs turn them into a kick and a settle.
    r.backVel += p.recoilKick * (0.85 + Math.random() * 0.3);
    r.pitchVel += p.recoilClimb * (0.8 + Math.random() * 0.4);
    r.yawVel += p.recoilYaw * (Math.random() * 2 - 1);

    // Rock the upper body backwards, against the aim direction.
    this.leanVel.x -= Math.sin(this.aimYaw) * p.torsoKick;
    this.leanVel.y -= Math.cos(this.aimYaw) * p.torsoKick;

    const muzzle = localPoint(new THREE.Vector3(), this.gunPos, this.gunQuat, 0, 0.01, 0.52);
    const s = p.spread * DEG;
    const dir = localDir(
      new THREE.Vector3(),
      this.gunQuat,
      (Math.random() * 2 - 1) * s,
      (Math.random() * 2 - 1) * s,
      1,
    ).normalize();
    this.onShot?.(muzzle, dir);

    // Eject a casing out of the right side of the gun.
    const casing = new THREE.Mesh(this.casingGeo, this.casingMat);
    localPoint(casing.position, this.gunPos, this.gunQuat, 0.04, 0.03, 0.1);
    casing.quaternion.copy(this.gunQuat);
    casing.castShadow = true;
    this.body.add(casing);
    const vel = localDir(new THREE.Vector3(), this.gunQuat, 1.6 + Math.random(), 1.4 + Math.random(), -0.3);
    this.drops.push({ mesh: casing, vel: vel.add(this.vel), spin: 25 + Math.random() * 20, floor: 0.006, life: 3 });
  }

  _updateRecoil(dt) {
    const p = this.params;
    const r = this.recoil;
    const k = p.recoilStiffness;
    const c = 2 * Math.sqrt(k) * p.recoilDampingRatio;
    r.backVel += (-k * r.back - c * r.backVel) * dt;
    r.pitchVel += (-k * r.pitch - c * r.pitchVel) * dt;
    r.yawVel += (-k * r.yaw - c * r.yawVel) * dt;
    r.back += r.backVel * dt;
    r.pitch = Math.min(r.pitch + r.pitchVel * dt, p.maxClimb * DEG);
    r.yaw += r.yawVel * dt;
  }

  // ---------------------------------------------------------------- reload

  startReload() {
    if (this.reload.active) return;
    this.reload.active = true;
    this._startReloadStep(0);
  }

  _startReloadStep(i) {
    const r = this.reload;
    if (i >= RELOAD_STEPS.length) {
      r.active = false;
      r.step = -1;
      r.label = 'Ready';
      return;
    }
    r.step = i;
    r.t = 0;
    r.label = `${i + 1}/${RELOAD_STEPS.length} ${RELOAD_STEPS[i].name}`;
    if (RELOAD_STEPS[i].start) this._reloadEvent(RELOAD_STEPS[i].start);
  }

  _updateReload(dt) {
    const r = this.reload;
    if (!r.active) return;
    r.t += dt;
    const step = RELOAD_STEPS[r.step];
    const touching = this.hands.left.error < this.params.contactTolerance;
    if ((touching && r.t >= (step.minTime ?? 0.06)) || r.t > 2.5) {
      if (step.end) this._reloadEvent(step.end);
      this._startReloadStep(r.step + 1);
    }
  }

  _reloadEvent(name) {
    if (name === 'eject') {
      const drop = new THREE.Mesh(this.mag.geometry, this.materials.mag);
      drop.position.copy(this.mag.position);
      drop.quaternion.copy(this.mag.quaternion);
      drop.castShadow = true;
      this.body.add(drop);
      this.drops.push({
        mesh: drop,
        vel: this.vel.clone().add(_v1.set(0, -0.5, 0)),
        spin: (Math.random() - 0.5) * 8,
        floor: 0.035,
        life: 4,
      });
      this.magState = 'none';
      this.ammo = 0;
    } else if (name === 'take') {
      this.magState = 'hand';
    } else if (name === 'seat') {
      this.magState = 'gun';
      this.ammo = this.params.magSize;
    }
  }

  _updateDrops(dt) {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.life -= dt;
      if (d.mesh.position.y > d.floor) {
        d.vel.y -= 9.8 * dt;
        d.mesh.position.addScaledVector(d.vel, dt);
        d.mesh.rotation.x += d.spin * dt;
      } else {
        d.mesh.position.y = d.floor;
        d.vel.set(0, 0, 0);
      }
      if (d.life <= 0) {
        this.body.remove(d.mesh);
        this.drops.splice(i, 1);
      }
    }
  }

  // ---------------------------------------------------------------- pose hooks

  _afterFrames() {
    // Recoil: negative pitch raises the muzzle; "back" pulls the gun toward the chest.
    const p = this.params;
    const r = this.recoil;
    quatFrom(this.gunQuat, this.pitch * 0.15 - r.pitch, this.aimYaw + r.yaw, 0);
    localPoint(this.gunPos, this.chestPos, this.chestQuat, p.gunRight, p.gunUp + r.pitch * 0.05, p.gunFwd - r.back);
    this.gun.position.copy(this.gunPos);
    this.gun.quaternion.copy(this.gunQuat);
  }

  _setHandTargets() {
    const { left, right } = this.hands;
    localPoint(right.target, this.gunPos, this.gunQuat, ...GRIP);
    if (this.reload.active) {
      const step = RELOAD_STEPS[this.reload.step];
      const [origin, quat] =
        step.frame === 'gun' ? [this.gunPos, this.gunQuat] : [this.pelvisPos, this.pelvisQuat];
      localPoint(left.target, origin, quat, ...step.p);
    } else {
      localPoint(left.target, this.gunPos, this.gunQuat, ...SUPPORT);
    }
  }

  _afterPose() {
    this.mag.visible = this.magState !== 'none';
    if (this.magState === 'gun') {
      localPoint(this.mag.position, this.gunPos, this.gunQuat, ...MAG_SEAT);
    } else if (this.magState === 'hand') {
      this.mag.position.copy(this.arms[0].wrist).add(localDir(_v1, this.gunQuat, 0, MAG_IN_HAND_UP, 0));
    }
    this.mag.quaternion.copy(this.gunQuat);
  }

  // ---------------------------------------------------------------- debug

  getDebug() {
    const p = this.params;
    const deg = (r) => Math.round(r / DEG);
    let gait = 'idle';
    if (this.speed > 0.15) {
      const rel = wrapAngle(Math.atan2(this.vel.x, this.vel.z) - this.aimYaw) / DEG;
      if (Math.abs(rel) < 35) gait = 'forward';
      else if (Math.abs(rel) > 145) gait = 'backpedal';
      else gait = rel > 0 ? 'strafe left' : 'strafe right';
    }
    const foot = (f, name) =>
      `${name} ${f.planted ? 'planted' : 'swing  '} ${String(Math.round(f.progress * 100)).padStart(3)}%`;
    const cm = (h) => (h.error * 100).toFixed(1);
    return [
      `${this.speed.toFixed(2)} m/s · ${gait} · phase ${this.phase.toFixed(2)} · duty ${this.duty.toFixed(2)}`,
      `lower body ${deg(wrapAngle(this.lowerYaw - this.aimYaw))}° from aim · waist twist ${deg(this.twist)}° · gun lead ${p.gunLead}°`,
      `lean fwd ${deg(this.pitch)}° side ${deg(this.roll)}°`,
      `${foot(this.feet[0], 'L')}   ${foot(this.feet[1], 'R')}`,
      `hand error  right ${cm(this.hands.right)} cm · left ${cm(this.hands.left)} cm`,
      `ammo ${this.ammo}/${p.magSize} · recoil back ${(this.recoil.back * 100).toFixed(1)} cm climb ${deg(this.recoil.pitch)}°`,
      `reload  ${this.reload.label}`,
    ].join('\n');
  }
}
