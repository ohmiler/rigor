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
  STEP_UP,
  UP,
} from './rig-utils.js';
import { Traversal } from './traversal.js';

const { clamp, lerp } = THREE.MathUtils;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _k1 = new THREE.Vector3();
const _k2 = new THREE.Vector3();
const _k3 = new THREE.Vector3();
const Z_AXIS = new THREE.Vector3(0, 0, 1);
// Knee swing angles tried when a knee would end up inside an obstacle. Kept
// within what a hip can actually rotate: a knee never turns to face backwards.
const KNEE_TURNS = Array.from({ length: 11 }, (_, i) => ((i - 5) * 15 * Math.PI) / 180);

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
  // The ground everyone walks on. main.js points this at the level.
  static terrain = {
    heightAt: () => 0,
    findLedge: () => null,
  };

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
    this.vy = 0; // vertical speed while falling
    this.traversal = null; // active vault or climb
    this.traversalPose = { pitch: 0, roll: 0 };
    this.gunStow = 0; // 0 = aiming, 1 = gun swung down out of the way
    this.handPlant = [0, 0]; // how flat each hand lies on a ledge

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
      heel: 0, // heel lift (radians), toes stay down
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

    this.arms = [-1, 1].map((side) => {
      // A flat hand (palm + fingers) so it can lie on a ledge or wrap a grip.
      const hand = new THREE.Group();
      box(hand, m.skin, 0.075, 0.03, 0.07, 0, 0, 0.035);
      box(hand, m.skin, 0.07, 0.024, 0.05, 0, -0.004, 0.09);
      box(hand, m.skin, 0.022, 0.024, 0.045, side * 0.04, -0.01, 0.03).rotation.y = side * 0.5; // thumb
      body.add(hand);
      return {
        side,
        shoulderBase: new THREE.Vector3(),
        shoulder: new THREE.Vector3(),
        elbow: new THREE.Vector3(),
        wrist: new THREE.Vector3(),
        // The shoulder ball rides on the clavicle, so it moves with the reach.
        shoulderMesh: sphere(body, m.shirt, 0.065),
        upper: new Segment(body, m.shirt, DIMS.upperArm, 0.05),
        fore: new Segment(body, m.skin, DIMS.forearm, 0.04),
        hand,
      };
    });

    this.legs = [-1, 1].map((side) => {
      // Heel block plus a toe block hinged at the ball, so the heel can lift
      // while the toes stay on the ground.
      const foot = new THREE.Group();
      box(foot, m.shoes, 0.1, 0.07, 0.17);
      const toe = new THREE.Group();
      toe.position.set(0, -0.01, 0.085);
      box(toe, m.shoes, 0.095, 0.05, 0.09, 0, 0, 0.045);
      foot.add(toe);
      body.add(foot);
      return {
        toe,
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
    this._updateVertical(dt);
  }

  // Walk up small steps, fall off edges.
  _updateVertical(dt) {
    const support = Humanoid.terrain.heightAt(this.pos.x, this.pos.z, this.pos.y + STEP_UP);
    if (support >= this.pos.y) {
      this.pos.y += (support - this.pos.y) * (1 - Math.exp(-25 * dt));
      if (support - this.pos.y < 0.005) this.pos.y = support;
      this.vy = 0;
    } else {
      this.vy -= 9.8 * dt;
      this.pos.y = Math.max(this.pos.y + this.vy * dt, support);
      if (this.pos.y === support) {
        // Landing knocks the torso forward a little.
        if (this.vy < -2.5) this.jolt(_v1.set(Math.sin(this.aimYaw), 0, Math.cos(this.aimYaw)), -this.vy * 0.3);
        this.vy = 0;
      }
    }
  }

  // ---------------------------------------------------------------- traversal

  /**
   * Vault over or climb onto a ledge from `findLedge`. Keyframes (see
   * traversal.js) place the hips, hands and feet relative to the real edge;
   * IK and the springs do the rest.
   */
  startTraversal(ledge, { duration, bothHands = false, keys }) {
    this.traversal = new Traversal(ledge, this, { duration, bothHands, keys });
    this.vy = 0;
    this.reach = 0;
  }

  _updateTraversal(dt) {
    const tr = this.traversal;
    const p = this.params;
    const prevX = this.pos.x;
    const prevZ = this.pos.z;
    tr.evaluate(dt);

    // The keys drive the hips; pos is the feet base under them.
    this.pos.set(tr.pelvis.x, tr.pelvis.y - p.hipHeight, tr.pelvis.z);
    if (dt > 0) this.vel.set((this.pos.x - prevX) / dt, 0, (this.pos.z - prevZ) / dt);
    this.speed = 0; // no run crouch or bob while the keys are in charge
    this.traversalPose.pitch = tr.pose.pitch;
    this.traversalPose.roll = tr.pose.roll;
    this.gunStow = tr.pose.stow;
    this.aimYaw = dampAngle(this.aimYaw, tr.yaw, 14, dt);
    this.lowerYaw = wrapAngle(tr.yaw + tr.pose.hipYaw);

    for (const [i, f] of this.feet.entries()) {
      f.planted = false;
      f.pos.copy(tr.feet[i]);
      f.yaw = this.lowerYaw;
      f.heel = 0;
      // A foot off the ground hangs toes-down.
      f.pitch = Math.min(tr.footAir[i] / 0.15, 1) * 0.55;
    }

    if (tr.done) {
      this.pos.copy(tr.end);
      this.traversal = null;
      this.traversalPose.pitch = this.traversalPose.roll = 0;
      this.gunStow = 0;
      for (const f of this.feet) {
        this._restTarget(f.pos, f);
        f.planted = true;
      }
      this.vel.copy(tr.dir).multiplyScalar(1.2);
      this.speed = 1.2;
    }
  }

  // Blend the hands onto their holds on the ledge.
  _traversalHands() {
    const tr = this.traversal;
    this.handPlant[0] = tr ? tr.hands[0].w : 0;
    this.handPlant[1] = tr ? tr.hands[1].w : 0;
    if (!tr) return;
    const [l, r] = tr.hands;
    if (l.w > 0) this.hands.left.target.lerp(l.pos, l.w);
    if (r.w > 0) this.hands.right.target.lerp(r.pos, r.w);
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
    out.y = Humanoid.terrain.heightAt(out.x, out.z, this.pos.y + STEP_UP);
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
      f.target.y = Humanoid.terrain.heightAt(f.target.x, f.target.z, this.pos.y + STEP_UP);
      const local = (this.phase + f.offset) % 1;
      if (local < this.duty) {
        if (!f.planted) {
          f.planted = true;
          f.pos.y = f.target.y;
          f.pitch = 0;
        }
        f.progress = local / this.duty;
        // Late in the stance the heel peels up before the foot leaves the ground.
        f.heel = this.speed > 0.4 ? smoothstep(clamp((f.progress - 0.55) / 0.45, 0, 1)) * (0.25 + 0.3 * speedF) : 0;
      } else {
        f.heel = 0;
        if (f.planted) {
          f.planted = false;
          f.swingStart.copy(f.pos);
        }
        const t = (local - this.duty) / (1 - this.duty);
        f.progress = t;
        f.pos.lerpVectors(f.swingStart, f.target, smoothstep(t));
        f.pos.y += Math.sin(Math.PI * t) * p.stepHeight * f.stepScale * (0.6 + 0.4 * speedF);
        f.yaw = dampAngle(f.yaw, this.lowerYaw, 14, dt);
        f.pitch = -0.35 * f.stepScale * Math.sin(Math.PI * t);
      }
    }
  }

  // ---------------------------------------------------------------- pose

  /**
   * Obstacle-aware knee: if the leg as solved would put the knee (or the
   * thigh/shin) inside something, swing the knee around the hip-ankle line
   * until it's clear. The foot and hip don't move; only the way the leg bends.
   * Prefers the normal direction, and stays close to last frame's choice so
   * the knee doesn't flick back and forth.
   */
  _clearKnee(leg, pole, dt) {
    const solid = Humanoid.terrain.solidAt;
    const axis = _k1.subVectors(leg.ankleTarget, leg.hip).normalize();
    const blocked = () =>
      solid(leg.knee) || solid(_k2.lerpVectors(leg.knee, leg.ankle, 0.5)) || solid(_k2.lerpVectors(leg.hip, leg.knee, 0.5));
    const solve = (angle) => {
      _k3.copy(pole).applyAxisAngle(axis, angle);
      solveTwoBone(leg.hip, leg.ankleTarget, DIMS.thigh, DIMS.shin, _k3, leg.knee, leg.ankle);
    };
    const prev = leg.kneeTurn ?? 0;
    let best = prev;
    let bestScore = Infinity;
    for (const angle of KNEE_TURNS) {
      solve(angle);
      if (blocked()) continue;
      const score = Math.abs(angle) + 0.6 * Math.abs(angle - prev);
      if (score < bestScore) {
        bestScore = score;
        best = angle;
      }
    }
    // In play, turn toward it quickly but not instantly; a frozen frame snaps.
    leg.kneeTurn = dt > 0 ? prev + clamp(best - prev, -7 * dt, 7 * dt) : best;
    solve(leg.kneeTurn);
  }

  // Subclass hooks.
  _afterFrames() {}
  _setHandTargets() {}
  _afterPose() {}

  _poseBody(dt, snap = false) {
    const p = this.params;
    const pose = this.posture;
    const speedF = clamp(this.speed / p.runSpeed, 0, 1);
    const pitch = this.pitch + pose.pitch + this.traversalPose.pitch;
    const roll = this.roll + pose.roll + this.traversalPose.roll;

    const bob = this.traversal ? 0 : p.bobAmount * speedF * (0.5 + 0.5 * Math.cos(this.phase * Math.PI * 4));
    this.pelvisPos.set(
      this.pos.x,
      this.pos.y + p.hipHeight - p.crouch * speedF - bob + this.heightOffset,
      this.pos.z,
    );
    // Walking hips swing forward with each leg and drop a little on the swing side.
    const gaitSway = this.traversal ? 0 : speedF * Math.sin(this.phase * Math.PI * 2);
    quatFrom(this.pelvisQuat, pitch * 0.35, this.pelvisYaw + gaitSway * 0.12, roll * 0.35 + gaitSway * 0.05);
    quatFrom(this.chestQuat, pitch, this.chestYaw, roll);
    // Three-part spine: the lower back takes half the bend, so the torso
    // curves instead of tipping over as one plank.
    _q1.slerpQuaternions(this.pelvisQuat, this.chestQuat, 0.5);
    localPoint(_v1, this.pelvisPos, this.pelvisQuat, 0, 0.08, 0);
    _v1.add(localDir(_v2, _q1, 0, 0.13, 0));
    this.chestPos.addVectors(_v1, localDir(_v2, this.chestQuat, 0, 0.15, 0));
    // While climbing the head comes up to look ahead instead of following the torso down.
    const headPitch = pitch * 0.3 + pose.headPitch - this.traversalPose.pitch * 0.9;
    quatFrom(this.headQuat, headPitch, this.aimYaw, roll * 0.3 + pose.headRoll);
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
    this._traversalHands();
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
    for (const [i, arm] of this.arms.entries()) {
      const hand = arm.side < 0 ? this.hands.left : this.hands.right;
      localPoint(arm.shoulderBase, this.chestPos, this.chestQuat, arm.side * DIMS.shoulderX, 0.12, p.roundShoulders);
      // Clavicle: a nearly straight arm drags the shoulder toward the hand,
      // and reaching overhead shrugs it up.
      _v1.subVectors(hand.pos, arm.shoulderBase);
      const dist = _v1.length();
      const reach = clamp((dist - 0.42) / 0.18, 0, 1);
      const shrug = clamp((hand.pos.y - arm.shoulderBase.y) / 0.4, 0, 1);
      arm.shoulder.copy(arm.shoulderBase).addScaledVector(_v1.divideScalar(dist || 1), 0.055 * reach);
      arm.shoulder.y += 0.04 * shrug;
      arm.shoulderMesh.position.copy(arm.shoulder);

      // Elbows hang down and out; with a hand planted on a ledge they flare
      // out and back instead of jabbing forward into the wall.
      const plant = this.handPlant[i];
      localDir(_v3, this.chestQuat, arm.side * (0.6 + 0.5 * plant), -1 + 0.6 * plant, -0.35 - 0.3 * plant);
      solveTwoBone(arm.shoulder, hand.pos, DIMS.upperArm, DIMS.forearm, _v3, arm.elbow, arm.wrist);
      arm.upper.place(arm.shoulder, arm.elbow);
      arm.fore.place(arm.elbow, arm.wrist);

      // Hand follows the forearm, or lies flat (palm down) when planted on a ledge.
      _v1.subVectors(arm.wrist, arm.elbow).normalize();
      arm.hand.quaternion.setFromUnitVectors(Z_AXIS, _v1);
      if (plant > 0) {
        _v2.set(_v1.x, 0, _v1.z);
        if (_v2.lengthSq() < 1e-4) _v2.set(Math.sin(this.aimYaw), 0, Math.cos(this.aimYaw));
        _q1.setFromUnitVectors(Z_AXIS, _v2.normalize());
        arm.hand.quaternion.slerp(_q1, plant);
      }
      arm.hand.position.copy(arm.wrist);
    }

    // Legs: two-bone IK from hip to the planted or swinging foot.
    const right3 = rightOf(_v2, this.lowerYaw);
    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i];
      const f = this.feet[i];
      localPoint(leg.hip, this.pelvisPos, this.pelvisQuat, f.side * DIMS.hipX, -0.06, 0);
      leg.ankleTarget.copy(f.pos);
      // Heel lift pivots on the ball of the foot, raising the ankle.
      leg.ankleTarget.y += DIMS.ankle + Math.sin(f.heel) * 0.12;
      _v3.set(Math.sin(this.lowerYaw), 0, Math.cos(this.lowerYaw)).addScaledVector(right3, f.side * 0.15);
      // Climbing and vaulting the legs go everywhere, so treat the knee as the
      // hinge it is: it bends around the hips' left-right axis. Bend direction =
      // hip axis × leg line: forward for a hanging leg, up for a leg raised in
      // front, down-forward for a leg trailing behind. That changes smoothly
      // with the leg, so the knee can't flip sides the way a fixed "point the
      // knee this way" hint does whenever the leg happens to line up with it.
      if (this.traversal) {
        _v3.crossVectors(right3, _k1.subVectors(leg.ankleTarget, leg.hip)).normalize();
        _v3.addScaledVector(right3, f.side * 0.4); // knees splay out, clear of the wall
      }
      solveTwoBone(leg.hip, leg.ankleTarget, DIMS.thigh, DIMS.shin, _v3, leg.knee, leg.ankle);
      if (this.traversal && Humanoid.terrain.solidAt) this._clearKnee(leg, _v3, dt);
      else leg.kneeTurn = 0;
      leg.thigh.place(leg.hip, leg.knee);
      leg.shin.place(leg.knee, leg.ankle);
      quatFrom(leg.foot.quaternion, f.pitch + f.heel, f.yaw, 0);
      leg.toe.rotation.x = -f.heel; // toes stay flat on the ground
      leg.foot.position.copy(leg.ankle);
      leg.foot.position.y -= 0.035;
      leg.foot.position.addScaledVector(_v1.set(Math.sin(f.yaw), 0, Math.cos(f.yaw)), 0.03);
    }

    this._afterPose();

    if (this.markers[0].visible) {
      for (const { point, mesh } of this.markerPoints) mesh.position.copy(point);
    }
  }
}
