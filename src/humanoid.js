import * as THREE from 'three';
import {
  DEG,
  Segment,
  solveTwoBone,
  springVec,
  wrapAngle,
  dampAngle,
  smoothstep,
  localPoint,
  localDir,
  quatFrom,
  rightOf,
} from './rig-utils.js';

const { clamp, lerp } = THREE.MathUtils;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

export const DIMS = {
  thigh: 0.46,
  shin: 0.45,
  ankle: 0.07,
  upperArm: 0.29,
  forearm: 0.27,
  hipX: 0.1,
  shoulderX: 0.19,
};

/**
 * A procedurally animated body: phase-driven gait with planted feet, a torso
 * spring, and two-bone IK for arms and legs. Subclasses decide where it wants
 * to go (`_locomote`), where it looks (`aimYaw`), and where its hands go
 * (`_setHandTargets`).
 */
export class Humanoid {
  constructor(scene, params, look) {
    this.params = params;
    this.scene = scene;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.accel = new THREE.Vector3();
    this.speed = 0;

    this.aimYaw = 0;
    this.lowerYaw = 0;
    this.pelvisYaw = 0;
    this.chestYaw = 0;
    this.chestYawOffset = 0;
    this.twist = 0;

    this.lean = new THREE.Vector2(); // world (x, z), radians
    this.leanVel = new THREE.Vector2();
    this.pitch = 0;
    this.roll = 0;
    // Constant body attitude on top of the physics (a zombie's hunch, a head tilt).
    this.posture = { pitch: 0, roll: 0, headPitch: 0, headRoll: 0 };
    this.heightOffset = 0; // negative crouches; IK bends the knees to match

    this.phase = 0;
    this.duty = params.dutyWalk;

    this.pelvisPos = new THREE.Vector3();
    this.pelvisQuat = new THREE.Quaternion();
    this.chestPos = new THREE.Vector3();
    this.chestQuat = new THREE.Quaternion();
    this.headPos = new THREE.Vector3();
    this.headQuat = new THREE.Quaternion();

    this.feet = [-1, 1].map((side) => ({
      side,
      offset: side < 0 ? 0 : 0.5,
      stepScale: 1,
      planted: true,
      progress: 0,
      pos: new THREE.Vector3(),
      swingStart: new THREE.Vector3(),
      target: new THREE.Vector3(),
      yaw: 0,
      pitch: 0,
    }));

    const hand = () => ({
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      target: new THREE.Vector3(),
      prevTarget: new THREE.Vector3(),
      targetVel: new THREE.Vector3(),
      error: 0,
    });
    this.hands = { left: hand(), right: hand() };

    this._buildBody(look);
  }

  // Call once the subclass has placed the body, so feet and hands start settled.
  _settle() {
    this.lowerYaw = this.pelvisYaw = this.chestYaw = this.aimYaw;
    for (const f of this.feet) {
      this._restTarget(f.pos, f);
      f.yaw = this.lowerYaw;
    }
    this._poseBody(0, true);
  }

  // ---------------------------------------------------------------- build

  _buildBody(look) {
    const mat = (color, roughness = 0.8) => new THREE.MeshStandardMaterial({ color, roughness });
    const m = (this.materials = {
      skin: mat(look.skin),
      shirt: mat(look.shirt),
      pants: mat(look.pants),
      shoes: mat(look.shoes),
    });
    if (look.cap) m.cap = mat(look.cap);

    const body = (this.body = new THREE.Group());
    this.scene.add(body);
    this.box = (parent, material, w, h, d, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const box = this.box;
    const sphere = (parent, material, r, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };

    this.pelvis = new THREE.Group();
    box(this.pelvis, m.pants, 0.3, 0.18, 0.2);
    body.add(this.pelvis);

    this.chest = new THREE.Group();
    box(this.chest, m.shirt, 0.38, 0.34, 0.22);
    sphere(this.chest, m.shirt, 0.065, DIMS.shoulderX, 0.12, 0);
    sphere(this.chest, m.shirt, 0.065, -DIMS.shoulderX, 0.12, 0);
    body.add(this.chest);

    // Unit-height box stretched between pelvis and chest each frame.
    this.abdomen = box(body, m.shirt, 0.3, 1, 0.19);
    this.neck = new Segment(body, m.skin, 0.12, 0.045);

    this.head = new THREE.Group();
    sphere(this.head, m.skin, 0.11).scale.set(1, 1.1, 1);
    if (m.cap) {
      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(0.117, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        m.cap,
      );
      cap.position.y = 0.025;
      cap.castShadow = true;
      this.head.add(cap);
      if (look.brim) box(this.head, m.cap, 0.16, 0.015, 0.1, 0, 0.035, 0.12);
    }
    body.add(this.head);

    this.arms = [-1, 1].map((side) => ({
      side,
      shoulder: new THREE.Vector3(),
      elbow: new THREE.Vector3(),
      wrist: new THREE.Vector3(),
      upper: new Segment(body, m.shirt, DIMS.upperArm, 0.05),
      fore: new Segment(body, m.skin, DIMS.forearm, 0.04),
      hand: sphere(body, m.skin, 0.045),
    }));

    this.legs = [-1, 1].map((side) => {
      const foot = new THREE.Group();
      box(foot, m.shoes, 0.1, 0.07, 0.25);
      body.add(foot);
      return {
        side,
        hip: new THREE.Vector3(),
        knee: new THREE.Vector3(),
        ankle: new THREE.Vector3(),
        ankleTarget: new THREE.Vector3(),
        thigh: new Segment(body, m.pants, DIMS.thigh, 0.07),
        shin: new Segment(body, m.pants, DIMS.shin, 0.057),
        foot,
      };
    });

    // Debug joint markers drawn on top of everything.
    const markerGeo = new THREE.SphereGeometry(0.022, 10, 8);
    const jointMat = new THREE.MeshBasicMaterial({ color: '#ff5d73', depthTest: false });
    const targetMat = new THREE.MeshBasicMaterial({ color: '#5dff9b', depthTest: false });
    this.markers = [];
    const marker = (material) => {
      const mesh = new THREE.Mesh(markerGeo, material);
      mesh.renderOrder = 999;
      mesh.visible = false;
      this.scene.add(mesh);
      this.markers.push(mesh);
      return mesh;
    };
    this.markerPoints = [
      this.pelvisPos,
      this.chestPos,
      this.headPos,
      ...this.arms.flatMap((a) => [a.shoulder, a.elbow, a.wrist]),
      ...this.legs.flatMap((l) => [l.hip, l.knee, l.ankle]),
    ].map((point) => ({ point, mesh: marker(jointMat) }));
    this.markerPoints.push(
      { point: this.hands.left.target, mesh: marker(targetMat) },
      { point: this.hands.right.target, mesh: marker(targetMat) },
    );
  }

  setSkeleton(on) {
    for (const mat of Object.values(this.materials)) {
      mat.transparent = on;
      mat.opacity = on ? 0.28 : 1;
      mat.depthWrite = !on;
      mat.needsUpdate = true;
    }
    for (const m of this.markers) m.visible = on;
  }

  dispose() {
    this.scene.remove(this.body);
    for (const m of this.markers) this.scene.remove(m);
  }

  // ---------------------------------------------------------------- motion

  // Shove the torso spring along a ground direction (struggles, bites, hits).
  jolt(dir, amount) {
    this.leanVel.x += dir.x * amount;
    this.leanVel.y += dir.z * amount;
  }

  // Move toward a desired velocity with an acceleration cap.
  _locomote(dt, desired) {
    _v2.subVectors(desired, this.vel);
    _v2.y = 0;
    const maxDv = this.params.acceleration * dt;
    if (_v2.length() > maxDv) _v2.setLength(maxDv);
    this.vel.add(_v2);
    this.pos.addScaledVector(this.vel, dt);
    if (dt > 0) this.accel.lerp(_v2.divideScalar(dt), 1 - Math.exp(-10 * dt));
    this.speed = this.vel.length();
  }

  _updateBody(dt) {
    this._updateYaws(dt);
    this._updateLean(dt);
    this._updateGait(dt);
  }

  // Legs follow the movement direction, the chest follows the aim, and the
  // waist absorbs the difference (clamped so the body never corkscrews).
  _updateYaws(dt) {
    const p = this.params;
    let lowerTarget = this.lowerYaw;
    if (this.speed > 0.2) {
      let moveYaw = Math.atan2(this.vel.x, this.vel.z);
      if (Math.abs(wrapAngle(moveYaw - this.aimYaw)) > Math.PI / 2 + 0.17) {
        moveYaw = wrapAngle(moveYaw + Math.PI); // backpedal instead of turning around
      }
      lowerTarget = moveYaw;
    }
    const maxOff = p.maxHipOffset * DEG;
    const off = clamp(wrapAngle(lowerTarget - this.aimYaw), -maxOff, maxOff);
    this.lowerYaw = dampAngle(this.lowerYaw, this.aimYaw + off, p.hipTurnRate, dt);

    this.chestYaw = wrapAngle(this.aimYaw + this.chestYawOffset);
    this.twist = wrapAngle(this.chestYaw - this.lowerYaw);
    this.pelvisYaw = wrapAngle(this.lowerYaw + this.twist * p.pelvisTwistShare);
  }

  // Torso is a damped spring chasing a lean driven by acceleration and speed,
  // so it overshoots a little when you stop, change direction, or get hit.
  _updateLean(dt) {
    const p = this.params;
    const tx = this.accel.x * p.leanAccel + this.vel.x * p.leanSpeed;
    const tz = this.accel.z * p.leanAccel + this.vel.z * p.leanSpeed;
    this.leanVel.x += (p.leanStiffness * (tx - this.lean.x) - p.leanDamping * this.leanVel.x) * dt;
    this.leanVel.y += (p.leanStiffness * (tz - this.lean.y) - p.leanDamping * this.leanVel.y) * dt;
    this.lean.x += this.leanVel.x * dt;
    this.lean.y += this.leanVel.y * dt;

    const max = p.maxLean * DEG;
    const s = Math.sin(this.chestYaw);
    const c = Math.cos(this.chestYaw);
    this.pitch = clamp(this.lean.x * s + this.lean.y * c, -max, max);
    this.roll = clamp(-this.lean.x * c + this.lean.y * s, -max, max);
  }

  _restTarget(out, foot) {
    rightOf(out, this.lowerYaw).multiplyScalar(foot.side * this.params.footSpread);
    out.x += this.pos.x;
    out.z += this.pos.z;
    out.y = 0;
    return out;
  }

  // Phase-driven gait. A planted foot stays fixed in the world (no sliding);
  // a swinging foot arcs toward where it should land.
  _updateGait(dt) {
    const p = this.params;
    const speedF = clamp(this.speed / p.runSpeed, 0, 1);
    this.duty = lerp(p.dutyWalk, p.dutyRun, speedF);
    const stride = p.strideBase + p.strideScale * this.speed;

    let rateSpeed = 0;
    if (this.speed > 0.15) {
      rateSpeed = this.speed;
    } else if (
      this.feet.some(
        (f) => !f.planted || this._restTarget(_v1, f).distanceTo(f.pos) > p.settleDistance,
      )
    ) {
      rateSpeed = p.settleSpeed; // keep stepping until both feet settle under the body
    }

    const rate = rateSpeed / stride; // cycles per second
    this.phase = (this.phase + rate * dt) % 1;
    // Land the foot ahead of the body by half the distance covered during stance.
    const lead = rate > 0 ? (this.duty / rate) * 0.5 * p.footLead : 0;

    for (const f of this.feet) {
      this._restTarget(f.target, f).addScaledVector(this.vel, lead);
      f.target.y = 0;
      const local = (this.phase + f.offset) % 1;
      if (local < this.duty) {
        if (!f.planted) {
          f.planted = true;
          f.pos.y = 0;
          f.pitch = 0;
        }
        f.progress = local / this.duty;
      } else {
        if (f.planted) {
          f.planted = false;
          f.swingStart.copy(f.pos);
        }
        const t = (local - this.duty) / (1 - this.duty);
        f.progress = t;
        f.pos.lerpVectors(f.swingStart, f.target, smoothstep(t));
        f.pos.y = Math.sin(Math.PI * t) * p.stepHeight * f.stepScale * (0.6 + 0.4 * speedF);
        f.yaw = dampAngle(f.yaw, this.lowerYaw, 14, dt);
        f.pitch = -0.35 * f.stepScale * Math.sin(Math.PI * t);
      }
    }
  }

  // ---------------------------------------------------------------- pose

  // Subclass hooks.
  _afterFrames() {}
  _setHandTargets() {}
  _afterPose() {}

  _poseBody(dt, snap = false) {
    const p = this.params;
    const pose = this.posture;
    const speedF = clamp(this.speed / p.runSpeed, 0, 1);
    const pitch = this.pitch + pose.pitch;
    const roll = this.roll + pose.roll;

    const bob = p.bobAmount * speedF * (0.5 + 0.5 * Math.cos(this.phase * Math.PI * 4));
    this.pelvisPos.set(this.pos.x, p.hipHeight - p.crouch * speedF - bob + this.heightOffset, this.pos.z);
    quatFrom(this.pelvisQuat, pitch * 0.35, this.pelvisYaw, roll * 0.35);
    quatFrom(this.chestQuat, pitch, this.chestYaw, roll);
    localPoint(_v1, this.pelvisPos, this.pelvisQuat, 0, 0.08, 0);
    this.chestPos.addVectors(_v1, localDir(_v2, this.chestQuat, 0, 0.27, 0));
    quatFrom(this.headQuat, pitch * 0.3 + pose.headPitch, this.aimYaw, roll * 0.3 + pose.headRoll);
    localPoint(this.headPos, this.chestPos, this.chestQuat, 0, 0.33, 0.02);
    this._afterFrames();

    this.pelvis.position.copy(this.pelvisPos);
    this.pelvis.quaternion.copy(this.pelvisQuat);
    this.chest.position.copy(this.chestPos);
    this.chest.quaternion.copy(this.chestQuat);
    this.head.position.copy(this.headPos);
    this.head.quaternion.copy(this.headQuat);

    localPoint(_v1, this.pelvisPos, this.pelvisQuat, 0, 0.07, 0);
    localPoint(_v2, this.chestPos, this.chestQuat, 0, -0.13, 0);
    this.abdomen.position.lerpVectors(_v1, _v2, 0.5);
    this.abdomen.quaternion.slerpQuaternions(this.pelvisQuat, this.chestQuat, 0.5);
    this.abdomen.scale.y = Math.max(_v1.distanceTo(_v2), 0.01);

    this.neck.place(
      localPoint(_v1, this.chestPos, this.chestQuat, 0, 0.15, 0),
      localPoint(_v2, this.headPos, this.headQuat, 0, -0.08, 0),
    );

    // Hands chase their targets through a spring, so they carry momentum.
    this._setHandTargets(dt);
    const damping = 2 * Math.sqrt(p.handStiffness) * p.handDampingRatio;
    for (const h of [this.hands.left, this.hands.right]) {
      if (snap) {
        h.pos.copy(h.target);
        h.vel.set(0, 0, 0);
        h.targetVel.set(0, 0, 0);
      } else if (dt > 0) {
        h.targetVel.subVectors(h.target, h.prevTarget).divideScalar(dt);
        // A sudden target switch is a teleport, not motion to follow.
        if (h.targetVel.lengthSq() > 144) h.targetVel.set(0, 0, 0);
        springVec(h.pos, h.vel, h.target, h.targetVel, p.handStiffness, damping, p.handMaxAccel, dt);
      }
      h.prevTarget.copy(h.target);
      h.error = h.pos.distanceTo(h.target);
    }

    // Arms: two-bone IK from shoulder to the spring-driven hand.
    for (const arm of this.arms) {
      const hand = arm.side < 0 ? this.hands.left : this.hands.right;
      localPoint(arm.shoulder, this.chestPos, this.chestQuat, arm.side * DIMS.shoulderX, 0.12, p.roundShoulders);
      localDir(_v3, this.chestQuat, arm.side * 0.6, -1, -0.35);
      solveTwoBone(arm.shoulder, hand.pos, DIMS.upperArm, DIMS.forearm, _v3, arm.elbow, arm.wrist);
      arm.upper.place(arm.shoulder, arm.elbow);
      arm.fore.place(arm.elbow, arm.wrist);
      arm.hand.position.copy(arm.wrist);
    }

    // Legs: two-bone IK from hip to the planted or swinging foot.
    const right3 = rightOf(_v2, this.lowerYaw);
    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i];
      const f = this.feet[i];
      localPoint(leg.hip, this.pelvisPos, this.pelvisQuat, f.side * DIMS.hipX, -0.06, 0);
      leg.ankleTarget.copy(f.pos);
      leg.ankleTarget.y += DIMS.ankle;
      _v3.set(Math.sin(this.lowerYaw), 0, Math.cos(this.lowerYaw)).addScaledVector(right3, f.side * 0.15);
      solveTwoBone(leg.hip, leg.ankleTarget, DIMS.thigh, DIMS.shin, _v3, leg.knee, leg.ankle);
      leg.thigh.place(leg.hip, leg.knee);
      leg.shin.place(leg.knee, leg.ankle);
      quatFrom(leg.foot.quaternion, f.pitch, f.yaw, 0);
      leg.foot.position.copy(leg.ankle);
      leg.foot.position.y -= 0.035;
      leg.foot.position.addScaledVector(_v1.set(Math.sin(f.yaw), 0, Math.cos(f.yaw)), 0.05);
    }

    this._afterPose();

    if (this.markers[0].visible) {
      for (const { point, mesh } of this.markerPoints) mesh.position.copy(point);
    }
  }
}
