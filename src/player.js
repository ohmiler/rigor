import * as THREE from 'three';
import { Humanoid } from './humanoid.js';
import { traversalTiming } from './traversal.js';
import { DEG, wrapAngle, dampAngle, damp, localPoint, localDir, quatFrom } from './rig-utils.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();

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

// Unit cone, apex at the origin, opening along +Z to radius 1 at z = 1.
const BEAM_GEOMETRY = new THREE.ConeGeometry(1, 1, 40, 1, true)
  .translate(0, -0.5, 0)
  .rotateX(-Math.PI / 2);

// Fake volumetric beam: brightest along the axis and near the lens,
// fading out toward the cone's silhouette and its far end.
const BEAM_MATERIAL = new THREE.ShaderMaterial({
  uniforms: {
    opacity: { value: 0.1 },
    color: { value: new THREE.Color('#fff1d6') },
  },
  vertexShader: /* glsl */ `
    varying float vAlong;
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
      vAlong = position.z;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vNormal = normalize(normalMatrix * normal);
      vView = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float opacity;
    uniform vec3 color;
    varying float vAlong;
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
      float edge = pow(abs(dot(normalize(vNormal), normalize(vView))), 2.0);
      float fade = pow(clamp(1.0 - vAlong, 0.0, 1.0), 1.8);
      float a = opacity * edge * fade;
      gl_FragColor = vec4(color * a, a);
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
});

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
    this.reserve = params.startReserve; // spare rounds to reload from
    this.dryFire = false; // trigger pulled on an empty gun with nothing to reload
    this.fireCooldown = 0;
    this.onShot = null; // (muzzle: Vector3, dir: Vector3) => void
    this.moveMode = 'jog';
    this.aimPitch = 0;
    this.parkourHint = null; // 'vault' | 'climb' | null

    this.health = params.maxHealth;
    this.state = 'normal'; // 'normal' | 'grabbed' | 'dead'
    this.grabbedBy = null;
    this.deathPos = new THREE.Vector3();

    this._buildGun();
    this._settle();
  }

  // Stand at `position` with feet and hands settled.
  teleport(position) {
    this.pos.copy(position);
    this.vel.set(0, 0, 0);
    this._settle();
  }

  // Fresh body at `spawn` (the old one may be in pieces).
  reset(spawn = new THREE.Vector3()) {
    this.dispose();
    for (const d of this.drops) this.body.remove(d.mesh);
    this.drops = [];
    this._buildBody(PLAYER_LOOK);
    this._buildGun();
    this.pos.copy(spawn);
    this.vel.set(0, 0, 0);
    this.accel.set(0, 0, 0);
    this.lean.set(0, 0);
    this.leanVel.set(0, 0);
    Object.assign(this.recoil, { back: 0, backVel: 0, pitch: 0, pitchVel: 0, yaw: 0, yawVel: 0 });
    Object.assign(this.reload, { active: false, step: -1, t: 0, label: 'Ready' });
    this.magState = 'gun';
    this.ammo = this.params.magSize;
    this.reserve = this.params.startReserve;
    this.dryFire = false;
    this.health = this.params.maxHealth;
    this.state = 'normal';
    this.grabbedBy = null;
    this.traversal = null;
    this.traversalPose.pitch = this.traversalPose.roll = 0;
    this.vy = 0;
    this.aimPitch = 0;
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

    // Flashlight under the barrel. Parented to the gun so the beam follows
    // the aim and every bit of recoil.
    const torch = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.12, 10), m.gunAccent);
    torch.rotation.x = Math.PI / 2;
    torch.position.set(0, -0.045, 0.36);
    this.gun.add(torch);
    this.lens = new THREE.Mesh(
      new THREE.CircleGeometry(0.018, 12),
      new THREE.MeshBasicMaterial({ color: '#fff6dc' }),
    );
    this.lens.position.set(0, -0.045, 0.421);
    this.gun.add(this.lens);

    this.flashlight = new THREE.SpotLight('#fff1d6', 0, 24, 0.37, 0.55, 1.3);
    this.flashlight.position.set(0, -0.045, 0.43);
    this.flashlight.target.position.set(0, -0.045, 6);
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(1024, 1024);
    this.flashlight.shadow.camera.near = 0.2;
    this.flashlight.shadow.bias = -0.0004;
    this.flashlight.shadow.normalBias = 0.02;
    this.gun.add(this.flashlight, this.flashlight.target);

    this.beam = new THREE.Mesh(BEAM_GEOMETRY, BEAM_MATERIAL);
    this.beam.position.copy(this.flashlight.position);
    this.gun.add(this.beam);

    this.mag = box(this.body, m.mag, 0.04, 0.16, 0.07);
    this.casingGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.03, 6).rotateX(Math.PI / 2);
    this.casingMat = new THREE.MeshStandardMaterial({ color: '#d9b45a', metalness: 0.8, roughness: 0.35 });
  }

  // ---------------------------------------------------------------- update

  update(dt, input) {
    const p = this.params;
    if (this.state === 'dead') {
      this._updateDrops(dt);
      return;
    }
    const grabbed = this.state === 'grabbed' && this.grabbedBy;

    // Mid-vault or mid-climb: the path drives the body, no other input.
    if (this.traversal) {
      this._updateTraversal(dt);
      this._updateRecoil(dt);
      this._updateYaws(dt);
      this._updateLean(dt);
      this._updateDrops(dt);
      this._poseBody(dt);
      return;
    }

    _v1.set(input.x, 0, input.z);
    if (_v1.lengthSq() > 1) _v1.normalize();

    // Vault/climb toward where you're moving, or where you're facing if still.
    const canParkour = !grabbed && this.state === 'normal' && !this.reload.active && this.vy === 0;
    if (_v1.lengthSq() > 0.01) _v2.copy(_v1).normalize();
    else _v2.set(Math.sin(this.aimYaw), 0, Math.cos(this.aimYaw));
    const ledge = canParkour ? Humanoid.terrain.findLedge(this.pos, _v2) : null;
    this.parkourHint = ledge?.type ?? null;
    if (ledge && input.jump) {
      // Vault one-handed with the gun kept; climb with both hands, gun swung aside.
      this.startTraversal(ledge, traversalTiming(ledge, this.pos.y));
      this.parkourHint = null;
      // Start moving this frame; skipping it is a one-frame stall.
      this._updateTraversal(dt);
      this._updateRecoil(dt);
      this._updateYaws(dt);
      this._updateLean(dt);
      this._updateDrops(dt);
      this._poseBody(dt);
      return;
    }
    // Ctrl (walk) wins over Shift (sprint) so a careful player is never surprised.
    this.moveMode = input.walk ? 'walk' : input.sprint ? 'sprint' : 'jog';
    const topSpeed = { walk: p.walkSpeed, jog: p.jogSpeed, sprint: p.runSpeed }[this.moveMode];
    // Held in place while grabbed.
    this._locomote(dt, grabbed ? _v1.set(0, 0, 0) : _v1.multiplyScalar(topSpeed));

    let aimTarget = this.aimYaw;
    if (grabbed) {
      // Face whoever has hold of you.
      aimTarget = Math.atan2(this.grabbedBy.pos.x - this.pos.x, this.grabbedBy.pos.z - this.pos.z);
    } else if (p.faceMouse && input.aimPoint) {
      const dx = input.aimPoint.x - this.pos.x;
      const dz = input.aimPoint.z - this.pos.z;
      if (dx * dx + dz * dz > 0.16) aimTarget = Math.atan2(dx, dz);
      // From high ground, tip the gun down toward chest height at the cursor.
      const drop = this.pos.y > 0.3 ? this.pos.y + 0.25 : 0;
      this.aimPitch = damp(this.aimPitch, Math.atan2(drop, Math.max(Math.hypot(dx, dz), 1)), 10, dt);
    } else if (!p.faceMouse && this.speed > 0.3) {
      aimTarget = Math.atan2(this.vel.x, this.vel.z);
    }
    this.aimYaw = dampAngle(this.aimYaw, aimTarget, p.aimTurnRate, dt);
    this.chestYawOffset = p.gunLead * DEG;

    this._updateFiring(dt, input.fire && !grabbed);
    this._updateRecoil(dt);
    this._updateBody(dt);
    this._updateReload(dt);
    this._updateDrops(dt);
    this._poseBody(dt);
  }

  // ---------------------------------------------------------------- death

  /**
   * Torn apart. 'arms': one zombie rips off the arm nearest it and the body
   * topples away. 'halves': two or more pull the torso off the legs, each
   * half going toward the zombie that had it. `pulls` are ground directions
   * from the player toward each grabber.
   */
  die(mode, pulls, gore) {
    this.state = 'dead';
    this.grabbedBy = null;
    this.reload.active = false;
    this.deathPos.copy(this.pos);
    for (const m of this.markers) m.visible = false;
    if (this.magState !== 'gun') this.mag.visible = false;

    const up = new THREE.Vector3(0, 1, 0);
    const deg = Math.PI / 180;
    const armParts = (a) => [a.upper.mesh, a.fore.mesh, a.hand];
    const upperParts = [this.chest, this.head, this.abdomen, this.neck.mesh, this.gun, this.mag, ...this.arms.map((a) => a.shoulderMesh)];
    const lowerParts = [this.pelvis, ...this.legs.flatMap((l) => [l.thigh.mesh, l.shin.mesh, l.foot])];

    if (mode === 'halves') {
      const [pullA, pullB] = pulls;
      const waist = localPoint(new THREE.Vector3(), this.pelvisPos, this.pelvisQuat, 0, 0.1, 0);
      const top = gore.tear([...upperParts, ...this.arms.flatMap(armParts)], waist, {
        vel: pullA.clone().multiplyScalar(3.2).add(new THREE.Vector3(0, 2.2, 0)),
        angVel: new THREE.Vector3().crossVectors(up, pullA).multiplyScalar(7),
        rest: 0.13,
      });
      const legs = gore.tear(lowerParts, this.pos, {
        topple: { axis: new THREE.Vector3().crossVectors(up, pullB).normalize(), maxAngle: 85 * deg, duration: 0.8 },
      });
      gore.spray(waist, up, 50, 3);
      gore.spray(waist, up.clone().negate(), 40, 2);
      gore.wound(waist, new THREE.Vector3(0, -1, 0), { gib: top, rate: 140, duration: 4 });
      gore.wound(waist, up, { gib: legs, rate: 110, duration: 4, speed: 1.6 });
      gore.pool(this.pos, 1.1, 6);
      gore.pool(this.pos.clone().addScaledVector(pullA, 1.4), 0.8, 6);
    } else {
      const pull = pulls[0];
      // The arm on the side facing the zombie is the one it gets hold of.
      const torn = this.arms.reduce((best, a) =>
        _v1.subVectors(a.shoulder, this.chestPos).dot(pull) > new THREE.Vector3().subVectors(best.shoulder, this.chestPos).dot(pull) ? a : best,
      );
      const kept = this.arms.find((a) => a !== torn);
      const shoulder = torn.shoulder.clone();
      const outward = shoulder.clone().sub(this.chestPos).setY(0.2).normalize();

      const arm = gore.tear(armParts(torn), shoulder, {
        vel: pull.clone().multiplyScalar(4).add(new THREE.Vector3(0, 2.5, 0)),
        angVel: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(24),
        rest: 0.06,
      });
      const body = gore.tear([...upperParts, ...armParts(kept), ...lowerParts], this.pos, {
        topple: { axis: new THREE.Vector3().crossVectors(up, pull).negate().normalize(), maxAngle: 86 * deg, duration: 0.85 },
      });
      gore.spray(shoulder, outward, 60, 3);
      gore.wound(shoulder, outward, { gib: body, rate: 120, duration: 5 });
      gore.wound(shoulder, outward.clone().negate(), { gib: arm, rate: 50, duration: 2.5, speed: 1.4 });
      gore.pool(this.pos.clone().addScaledVector(pull, -0.9), 1.0, 6);
    }
  }

  // ---------------------------------------------------------------- weapon

  _updateFiring(dt, triggerHeld) {
    const p = this.params;
    this.fireCooldown = Math.max(this.fireCooldown - dt, 0);
    if (!triggerHeld || this.reload.active) return;
    this.dryFire = false;
    if (this.ammo <= 0) {
      if (p.autoReload && this.reserve > 0) this.startReload();
      else if (this.reserve <= 0) this.dryFire = true;
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
    // Lands on whatever is under it (a car roof, the sidewalk), not the road below.
    const floor = Humanoid.terrain.heightAt(casing.position.x, casing.position.z, this.pos.y + 0.6) + 0.006;
    this.drops.push({ mesh: casing, vel: vel.add(this.vel), spin: 25 + Math.random() * 20, floor, life: 3 });
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

  // Nothing to reload from, or nothing to gain: the mag stays in.
  startReload() {
    if (this.reload.active || this.reserve <= 0 || this.ammo >= this.params.magSize) return;
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
        floor: Humanoid.terrain.heightAt(drop.position.x, drop.position.z, this.pos.y + 0.6) + 0.035,
        life: 4,
      });
      this.magState = 'none';
      // Rounds left in the old mag go back to the pile (no punishing a top-up).
      this.reserve += this.ammo;
      this.ammo = 0;
    } else if (name === 'take') {
      this.magState = 'hand';
    } else if (name === 'seat') {
      this.magState = 'gun';
      const n = Math.min(this.params.magSize, this.reserve);
      this.reserve -= n;
      this.ammo = n;
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
    quatFrom(this.gunQuat, this.pitch * 0.15 - r.pitch + this.aimPitch, this.aimYaw + r.yaw, 0);
    localPoint(this.gunPos, this.chestPos, this.chestQuat, p.gunRight, p.gunUp + r.pitch * 0.05, p.gunFwd - r.back);
    // Climbing: swing the gun down to hang off the right side, muzzle low.
    if (this.gunStow > 0) {
      const s = this.gunStow;
      localPoint(_v1, this.chestPos, this.chestQuat, 0.25, -0.38, 0.06);
      this.gunPos.lerp(_v1, s);
      this.gunQuat.slerp(quatFrom(_q1, 1.25, this.chestYaw + 0.35, 0.2), s);
    }
    this.gun.position.copy(this.gunPos);
    this.gun.quaternion.copy(this.gunQuat);
    this._updateFlashlight();
  }

  _updateFlashlight() {
    const p = this.params;
    const on = p.flashlightOn;
    const angle = p.flashAngle * DEG;
    // Intensity 0 rather than visible = false: toggling lights recompiles shaders.
    this.flashlight.intensity = on ? p.flashIntensity : 0;
    this.flashlight.angle = angle;
    this.flashlight.distance = p.flashRange;
    this.flashlight.shadow.camera.far = p.flashRange;
    this.lens.material.color.set(on ? '#fff6dc' : '#3a3d44');
    this.beam.visible = on && p.beamOpacity > 0;
    BEAM_MATERIAL.uniforms.opacity.value = p.beamOpacity;
    const length = p.flashRange * 0.55;
    const radius = Math.tan(angle) * length;
    this.beam.scale.set(radius, radius, length);
  }

  toggleFlashlight() {
    this.params.flashlightOn = !this.params.flashlightOn;
  }

  _setHandTargets() {
    const { left, right } = this.hands;
    localPoint(right.target, this.gunPos, this.gunQuat, ...GRIP);
    if (this.state === 'grabbed' && this.grabbedBy) {
      // Free hand shoves against the zombie's chest.
      left.target.lerpVectors(this.chestPos, this.grabbedBy.chestPos, 0.75);
    } else if (this.reload.active) {
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
      `${this.speed.toFixed(2)} m/s · ${this.moveMode} · ${gait} · phase ${this.phase.toFixed(2)} · duty ${this.duty.toFixed(2)}`,
      `lower body ${deg(wrapAngle(this.lowerYaw - this.aimYaw))}° from aim · waist twist ${deg(this.twist)}° · gun lead ${p.gunLead}°`,
      `lean fwd ${deg(this.pitch)}° side ${deg(this.roll)}°`,
      `${foot(this.feet[0], 'L')}   ${foot(this.feet[1], 'R')}`,
      `hand error  right ${cm(this.hands.right)} cm · left ${cm(this.hands.left)} cm`,
      `ammo ${this.ammo}/${p.magSize} + ${this.reserve} · recoil back ${(this.recoil.back * 100).toFixed(1)} cm climb ${deg(this.recoil.pitch)}°`,
      `reload  ${this.reload.label}`,
      `health ${Math.max(Math.round(this.health), 0)}/${p.maxHealth} · ${this.state}`,
    ].join('\n');
  }
}
