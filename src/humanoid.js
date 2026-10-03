import * as THREE from 'three';
import {
  DEG,
  Segment,
  solveTwoBone,
  springVec,
  wrapAngle,
  dampAngle,
  damp,
  smoothstep,
  localPoint,
  localDir,
  quatFrom,
  rightOf,
  STEP_UP,
  UP,
  bendFront,
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
const _f1 = new THREE.Vector3();
const _f2 = new THREE.Vector3();
const Z_AXIS = new THREE.Vector3(0, 0, 1);
// Points on the foot, in the foot block's frame (right, up, forward). A foot
// standing flat has its sole on the ground with the ankle 7 cm above, 3 cm
// behind the block's centre.
export const FOOT_ANKLE = new THREE.Vector3(0, 0.035, -0.03);
const FOOT_HEEL = new THREE.Vector3(0, -0.035, -0.085);
const FOOT_TOE_HINGE = new THREE.Vector3(0, -0.01, 0.085); // the ball, where the toes bend
const FOOT_SOLE = new THREE.Vector3(0, -0.035, -0.03); // on the sole, under the ankle
const BALL_AHEAD = FOOT_TOE_HINGE.z - FOOT_ANKLE.z; // ball of the foot ahead of the ankle
const _qf = new THREE.Quaternion();
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
  /**
   * @type {{
   *   heightAt: (x: number, z: number, maxY?: number) => number,
   *   findLedge: (pos: THREE.Vector3, dir: THREE.Vector3) => any,
   *   solidAt?: (p: THREE.Vector3) => boolean,
   *   collide?: (pos: THREE.Vector3, radius: number, bottom: number, stepUp?: number) => void,
   * }}
   */
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
    this.pivoting = false; // legs turning on the spot to catch up with the aim
    // Hooks for sound: a foot planting, landing from a drop.
    this.onFootstep = null;
    this.onLand = null;
    this.backpedal = false; // moving away from where you're aiming, legs facing the aim
    this.traversalPose = { pitch: 0, roll: 0 };
    this.gunStow = 0; // 0 = aiming, 1 = gun swung down out of the way
    this.handPlant = [0, 0]; // how flat each hand lies on a ledge

    this.phase = 0;
    this.duty = params.dutyWalk;
    this.gaitAmt = 0; // 0 standing still .. 1 stepping at walking pace or faster
    this.gaitRate = 0; // speed the stride was advanced at last frame (0 = feet at rest)
    this.hipGround = 0; // ground height the hips ride over, following the feet up and down steps
    this.hipGroundVel = 0;
    this.airborne = false; // dropped off an edge higher than a step
    this.dropLeft = 0; // height still to fall
    this.landedAt = 0; // impact speed of a landing this frame (m/s), 0 otherwise
    this.landDip = 0; // knees giving under a landing: hips pushed down (m), springs back
    this.landDipVel = 0;
    this.gaitDir = 1; // travel along the feet: 1 forward, -1 backwards, 0 sideways
    this.breath = 0; // breathing cycle (0..1)
    this.exertion = 0; // 0 rested .. 1 winded from sprinting; breathing follows it
    this.idleTime = 0;

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
      dutyScale: 1, // < 1: a hurt leg that won't bear weight long (a hobbling step)
      planted: true,
      progress: 0,
      pos: new THREE.Vector3(),
      swingStart: new THREE.Vector3(),
      target: new THREE.Vector3(),
      yaw: 0,
      pitch: 0,
      heel: 0, // heel lift (radians), toes stay down
      liftHeel: 0, // heel lift at toe-off, eased out over the early swing
      liftYaw: 0, // foot yaw at toe-off, turned to the landing yaw over the swing
      liftPitch: 0, // toes-up angle at toe-off when walking backwards, eased out early in the swing
      landPitch: 0, // toes-up angle at heel strike, rolled flat early in the stance
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
    this.hipGround = this.pos.y;
    this.hipGroundVel = 0;
    this.airborne = false;
    this.landedAt = this.landDip = this.landDipVel = 0;
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

    // Bulk widens the torso and thickens the limbs (a brute); the skeleton's
    // lengths stay the same, only the shoulders and hips spread to match.
    const k = look.bulk ?? 1;
    this.dims = { shoulderX: DIMS.shoulderX * (1 + (k - 1) * 0.8), hipX: DIMS.hipX * (1 + (k - 1) * 0.6) };

    this.pelvis = new THREE.Group();
    box(this.pelvis, m.pants, 0.3 * k, 0.18, 0.2 * k);
    body.add(this.pelvis);

    this.chest = new THREE.Group();
    box(this.chest, m.shirt, 0.38 * k, 0.34, 0.22 * k);
    body.add(this.chest);

    // A primitive wrapped in a group, so a modelled part can take its place.
    const holder = (mesh) => {
      const g = new THREE.Group();
      mesh.parent.add(g);
      g.add(mesh);
      mesh.position.set(0, 0, 0);
      return g;
    };

    // Unit-height box stretched between pelvis and chest each frame.
    this.abdomen = holder(box(body, m.shirt, 0.3 * k, 1, 0.19 * k));
    this.neck = new Segment(body, m.skin, 0.12, 0.045 * k);

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
        shoulderMesh: holder(sphere(body, m.shirt, 0.065 * k)),
        upper: new Segment(body, m.shirt, DIMS.upperArm, 0.05 * k),
        fore: new Segment(body, m.skin, DIMS.forearm, 0.04 * k),
        hand,
        lostFore: false, // shot off (zombies)
        lostUpper: false,
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
        thigh: new Segment(body, m.pants, DIMS.thigh, 0.07 * k),
        shin: new Segment(body, m.pants, DIMS.shin, 0.057 * k),
        kneeTurn: 0, // how far the knee is swung round to clear an obstacle
        foot,
      };
    });

    // Where a modelled body goes (dress): each slot, the part that fills it,
    // and the primitives it replaces.
    const kids = (g) => g.children.filter((c) => /** @type {any} */ (c).isMesh);
    // `thick` widens a part by the body's bulk, as the primitives are.
    const across = { x: k, y: 1, z: k };
    /** @type {Array<{ at: THREE.Object3D, part: string, standIns: THREE.Object3D[], thick?: { x: number, y: number, z: number }, mirror?: boolean }>} */
    this.slots = [
      { at: this.pelvis, part: 'pelvis', standIns: kids(this.pelvis), thick: across },
      { at: this.chest, part: 'chest', standIns: kids(this.chest), thick: across },
      { at: this.abdomen, part: 'abdomen', standIns: kids(this.abdomen), thick: across },
      { at: this.neck.mesh, part: 'neck', standIns: [this.neck.capsule], thick: across },
      { at: this.head, part: 'head', standIns: kids(this.head) },
      ...this.arms.flatMap((a) => [
        { at: a.shoulderMesh, part: 'shoulder', standIns: kids(a.shoulderMesh), thick: { x: k, y: k, z: k } },
        { at: a.upper.mesh, part: 'upperArm', standIns: [a.upper.capsule], thick: across },
        { at: a.fore.mesh, part: 'forearm', standIns: [a.fore.capsule], thick: across },
        { at: a.hand, part: 'hand', standIns: kids(a.hand), mirror: a.side < 0 },
      ]),
      ...this.legs.flatMap((l) => [
        { at: l.thigh.mesh, part: 'thigh', standIns: [l.thigh.capsule], thick: across },
        { at: l.shin.mesh, part: 'shin', standIns: [l.shin.capsule], thick: across },
        { at: l.foot, part: 'foot', standIns: kids(l.foot) },
        { at: l.toe, part: 'toe', standIns: kids(l.toe) },
      ]),
    ];
    this.dressed = false;

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

  /**
   * Swap the primitives for a modelled body (characters.js): every part
   * found in `model` by name goes in its slot, modelled in that slot's own
   * frame; a part the model lacks keeps its primitive. With a `kind`, a
   * part named "<kind>_<slot>" is worn in place of the shared one.
   * Materials named like this body's own (Skin, Shirt, Pants, Shoes, Cap)
   * become those, so the look's colours, blood and the skeleton view all
   * still apply; a look without one (a bald zombie: no Cap) hides what
   * wears it. Any other material is this body's own copy.
   * @param {THREE.Object3D} model
   * @param {string} [kind]
   */
  dress(model, kind) {
    if (this.dressed) return;
    this.dressed = true;
    const own = ['skin', 'shirt', 'pants', 'shoes', 'cap'];
    const materialFor = (src) => {
      const key = src.name.toLowerCase();
      if (own.includes(key)) return this.materials[key] ?? null;
      this.materials[key] ??= src.clone();
      return this.materials[key];
    };
    for (const slot of this.slots) {
      const part = (kind && model.getObjectByName(`${kind}_${slot.part}`)) || model.getObjectByName(slot.part);
      if (!part) continue;
      const copy = part.clone(true);
      copy.position.set(0, 0, 0);
      copy.quaternion.identity();
      if (slot.thick) copy.scale.set(slot.thick.x, slot.thick.y, slot.thick.z);
      if (slot.mirror) copy.scale.x *= -1; // a left hand from the right one
      copy.traverse((o) => {
        if (!(/** @type {any} */ (o).isMesh)) return;
        const mesh = /** @type {THREE.Mesh} */ (o);
        const material = materialFor(mesh.material);
        if (material) mesh.material = material;
        else mesh.visible = false;
        mesh.castShadow = true;
      });
      slot.at.add(copy);
      for (const s of slot.standIns) s.visible = false;
    }
  }

  // Swap one of this body's materials for another on every part that wears
  // it (blood soaking into the trousers).
  repaint(root, kind, material) {
    const from = this.materials[kind];
    root.traverse((o) => {
      const mesh = /** @type {THREE.Mesh} */ (o);
      if (mesh.isMesh && mesh.material === from) mesh.material = material;
    });
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

  // Move toward a desired velocity with an acceleration cap (scaled down to
  // let a knock-back carry).
  _locomote(dt, desired, grip = 1) {
    _v2.subVectors(desired, this.vel);
    _v2.y = 0;
    const maxDv = this.params.acceleration * grip * dt;
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
      // More than a step's drop: the feet leave the ground (see _airFeet).
      if (!this.airborne && this.pos.y - support > 0.18) this.airborne = true;
      this.vy -= 9.8 * dt;
      this.pos.y = Math.max(this.pos.y + this.vy * dt, support);
      this.dropLeft = this.pos.y - support;
      if (this.pos.y === support) {
        // Landing knocks the torso forward a little.
        if (this.vy < -2.5) this.jolt(_v1.set(Math.sin(this.aimYaw), 0, Math.cos(this.aimYaw)), -this.vy * 0.3);
        if (this.airborne) this.landedAt = -this.vy;
        this.airborne = false;
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
  startTraversal(ledge, { duration, bothHands = false, keys = undefined }) {
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
      this.hipGround = this.pos.y;
    this.hipGroundVel = 0;
      this.traversal = null;
      this.traversalPose.pitch = this.traversalPose.roll = 0;
      this.gunStow = 0;
      for (const f of this.feet) {
        this._restTarget(f.pos, f);
        f.planted = true;
      }
      // Carry on at the speed the move ended with, and restart the stride with
      // both feet in stance so the gait doesn't pick up mid-swing and pop a foot.
      const exit = THREE.MathUtils.clamp(this.vel.dot(tr.dir), 1.2, p.jogSpeed ?? 2.6);
      this.vel.copy(tr.dir).multiplyScalar(exit);
      this.speed = exit;
      this.phase = 0;
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
    const maxOff = p.maxHipOffset * DEG;
    if (this.speed > 0.2 || this.traversal) {
      this.pivoting = false;
      let lowerTarget = this.lowerYaw;
      if (this.speed > 0.2) {
        let moveYaw = Math.atan2(this.vel.x, this.vel.z);
        // Backpedal instead of turning around. The band either side of a pure
        // strafe keeps the legs from flipping round every time the direction
        // wobbles across 90°.
        const rel = Math.abs(wrapAngle(moveYaw - this.aimYaw));
        if (this.backpedal ? rel < Math.PI / 2 - 0.26 : rel > Math.PI / 2 + 0.26) this.backpedal = !this.backpedal;
        if (this.backpedal) moveYaw = wrapAngle(moveYaw + Math.PI);
        lowerTarget = moveYaw;
      }
      const off = clamp(wrapAngle(lowerTarget - this.aimYaw), -maxOff, maxOff);
      const next = dampAngle(this.lowerYaw, this.aimYaw + off, p.hipTurnRate, dt);
      // Legs swing round only as fast as the feet can step them round.
      const maxStep = this.traversal ? Infinity : (p.legTurnRate ?? 360) * DEG * dt;
      this.lowerYaw = wrapAngle(this.lowerYaw + clamp(wrapAngle(next - this.lowerYaw), -maxStep, maxStep));
    } else {
      this._pivot(dt);
    }

    this.chestYaw = wrapAngle(this.aimYaw + this.chestYawOffset);
    this.twist = wrapAngle(this.chestYaw - this.lowerYaw);
    this.pelvisYaw = wrapAngle(this.lowerYaw + this.twist * p.pelvisTwistShare);
  }

  // Standing still, the waist twists freely up to a point; past it the legs
  // turn to catch up at a steady rate, and the gait (see _updateGait) steps the
  // feet around with them, like a person turning on the spot.
  _pivot(dt) {
    const p = this.params;
    const gap = wrapAngle(this.aimYaw - this.lowerYaw);
    if (!this.pivoting && Math.abs(gap) > (p.pivotStart ?? 45) * DEG) this.pivoting = true;
    else if (this.pivoting && Math.abs(gap) < 8 * DEG) this.pivoting = false;
    if (this.pivoting) {
      // Full speed through the middle of the turn, easing out as the legs line up.
      const rate = Math.min((p.pivotRate ?? 180) * DEG, Math.abs(gap) * 6);
      this.lowerYaw = wrapAngle(this.lowerYaw + Math.sign(gap) * Math.min(rate * dt, Math.abs(gap)));
    }
    // The waist can only twist so far: past that the legs get dragged along.
    const lim = (p.maxTwist ?? 80) * DEG;
    const off = wrapAngle(this.lowerYaw - this.aimYaw);
    if (Math.abs(off) > lim) this.lowerYaw = dampAngle(this.lowerYaw, this.aimYaw + Math.sign(off) * lim, 25, dt);
  }

  // Torso is a damped spring chasing a lean driven by acceleration and speed,
  // so it overshoots a little when you stop, change direction, or get hit.
  _updateLean(dt) {
    const p = this.params;
    let tx = this.accel.x * p.leanAccel + this.vel.x * p.leanSpeed;
    let tz = this.accel.z * p.leanAccel + this.vel.z * p.leanSpeed;
    // Running a curve, bank into it: the sideways part of the acceleration
    // (what pulls you round the bend) leans the body further than speeding up
    // or slowing down does. Fades in with speed, so a slow turn stays upright.
    if (this.speed > 0.5 && p.leanTurn) {
      const ux = this.vel.x / this.speed;
      const uz = this.vel.z / this.speed;
      const along = this.accel.x * ux + this.accel.z * uz;
      const k = (p.leanTurn - p.leanAccel) * smoothstep(clamp((this.speed - 0.5) / 2, 0, 1));
      tx += (this.accel.x - along * ux) * k;
      tz += (this.accel.z - along * uz) * k;
    }
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

  _restTarget(out, foot, yaw = this.lowerYaw) {
    rightOf(out, yaw).multiplyScalar(foot.side * this.params.footSpread);
    out.x += this.pos.x;
    out.z += this.pos.z;
    out.y = Humanoid.terrain.heightAt(out.x, out.z, this.pos.y + STEP_UP);
    return out;
  }

  // Phase-driven gait. A planted foot stays fixed in the world (no sliding);
  // a swinging foot arcs toward where it should land.
  _updateGait(dt) {
    const p = this.params;
    this._updateLandDip(dt);
    if (this.airborne) {
      this._airFeet(dt);
      return;
    }
    if (this.landedAt > 0) this._land();
    const speedF = clamp(this.speed / p.runSpeed, 0, 1);
    // Moving at an angle to the legs (strafing), take shorter, quicker steps:
    // feet can't pass each other sideways, so long strides would straddle.
    const sideways = this.speed > 0.2 ? Math.abs(Math.sin(Math.atan2(this.vel.x, this.vel.z) - this.lowerYaw)) : 0;
    const stride = (p.strideBase + p.strideScale * this.speed) * (1 - 0.6 * sideways);

    const unsettled = this.feet.some(
      (f) =>
        !f.planted ||
        this._restTarget(_v1, f).distanceTo(f.pos) > p.settleDistance ||
        Math.abs(wrapAngle(f.yaw - this.lowerYaw)) > 0.4, // toes pointing the wrong way
    );
    let rateSpeed = 0;
    if (this.pivoting) {
      rateSpeed = Math.max(p.settleSpeed, 1.7); // step around, don't skate around
    } else if (this.speed > 0.15) {
      // Moving slowly (setting off, coming to a stop) still takes real steps
      // rather than leaving a foot planted far behind the body.
      rateSpeed = Math.max(this.speed, unsettled ? p.settleSpeed : 0);
    } else if (unsettled) {
      rateSpeed = p.settleSpeed; // keep stepping until both feet settle under the body
    }

    // From a standstill the first step goes straight away, with the foot that
    // makes sense: the one on the side you're turning toward, or the one the
    // body is about to leave behind. Put the stride exactly at its toe-off; the
    // other foot is then mid-stance.
    if (rateSpeed > 0 && this.gaitRate === 0 && this.feet.every((f) => f.planted)) {
      let lead;
      if (this.pivoting) {
        lead = this.feet[wrapAngle(this.aimYaw - this.lowerYaw) > 0 ? 0 : 1];
      } else {
        const behind = (f) => (f.pos.x - this.pos.x) * this.vel.x + (f.pos.z - this.pos.z) * this.vel.z;
        lead = behind(this.feet[0]) <= behind(this.feet[1]) ? this.feet[0] : this.feet[1];
      }
      this.phase = (this.duty - lead.offset + 1.001) % 1;
    }
    this.gaitRate = rateSpeed;

    const rate = rateSpeed / stride; // cycles per second
    // The stance share follows speed, but no faster than the stride turns
    // over: changing it instantly re-times every foot at once, which freezes a
    // foot mid-stance (or mid-swing) whenever you brake or set off.
    const dutyStep = 0.3 * rate * dt;
    this.duty += clamp(lerp(p.dutyWalk, p.dutyRun, speedF) - this.duty, -dutyStep, dutyStep);
    this.phase = (this.phase + rate * dt) % 1;
    // Braking stretches the stance (the duty grows as speed drops), which can
    // leave the back foot planted out of the leg's reach. If it's nearly due to
    // lift anyway and the other foot is down, lift it now rather than drag it.
    if (rateSpeed > 0 && this.feet.every((f) => f.planted)) {
      for (const [i, f] of this.feet.entries()) {
        const local = (this.phase + f.offset) % 1;
        const hip = this.legs[i].hip;
        const reachSq = (hip.x - f.pos.x) ** 2 + (hip.y - f.pos.y - DIMS.ankle) ** 2 + (hip.z - f.pos.z) ** 2;
        if (local > this.duty - 0.2 && reachSq > (0.97 * (DIMS.thigh + DIMS.shin)) ** 2) {
          this.phase = (this.duty - f.offset + 1.001) % 1;
          break;
        }
      }
    }
    // Land the foot ahead of the body by half the distance covered during stance,
    // allowing for speeding up or braking, so a stopping body doesn't plant a
    // foot out where it will never get to.
    const lead = rate > 0 ? (this.duty / rate) * 0.5 * p.footLead : 0;
    const reach = _v3.copy(this.vel).multiplyScalar(lead).addScaledVector(this.accel, 0.5 * lead * lead);
    reach.y = 0;
    if (reach.dot(this.vel) < 0) reach.set(0, 0, 0);
    // Smoothed so the hips ease into the weight shift when stepping starts or stops.
    this.gaitAmt = damp(this.gaitAmt, clamp(rateSpeed / 1.2, 0, 1), 6, dt);
    const runF = this._runFactor();
    // Turning on the spot, a stepping foot reaches toward where the legs are
    // heading and lands turned out, instead of being dragged round afterwards.
    const stepYaw = this.pivoting
      ? wrapAngle(this.lowerYaw + clamp(wrapAngle(this.aimYaw - this.lowerYaw), -0.7, 0.7))
      : this.lowerYaw;
    // Push off harder the faster you go; fades in so the heel never pops up.
    const push = smoothstep(clamp((this.speed - 0.2) / 0.6, 0, 1)) * (0.25 + 0.3 * speedF);
    // Which way the feet travel relative to where they point. Forwards the foot
    // lands on the heel and pushes off the toes; backwards it's the reverse
    // (toes first, rolling back onto the heel, toes lifting to leave); side on,
    // it steps flat.
    const along = this.speed > 0.2 ? (this.vel.x * Math.sin(this.lowerYaw) + this.vel.z * Math.cos(this.lowerYaw)) / this.speed : 1;
    this.gaitDir = damp(this.gaitDir, along, 8, dt);
    const fwdRoll = Math.max(this.gaitDir, 0);
    const backRoll = Math.max(-this.gaitDir, 0);

    for (const f of this.feet) {
      this._restTarget(f.target, f, stepYaw).add(reach);
      // Never land across the other foot. Moving at an angle to the legs
      // (strafing, turning) the trailing foot would otherwise step over the
      // lead one and the legs scissor through each other; instead it closes up
      // beside it, and the lead foot steps out: a side-shuffle.
      // Checked against where the other foot is and, if it's in the air, where
      // it's going to land, so neither foot's path crosses the other's.
      const other = this.feet[f.side < 0 ? 1 : 0];
      rightOf(_v1, stepYaw);
      const minGap = p.footSpread * 1.3;
      const gapTo = (q) => ((f.target.x - q.x) * _v1.x + (f.target.z - q.z) * _v1.z) * f.side;
      let gap = gapTo(other.pos);
      if (!other.planted) gap = Math.min(gap, gapTo(other.target));
      if (gap < minGap) f.target.addScaledVector(_v1, (minGap - gap) * f.side);
      f.target.y = Humanoid.terrain.heightAt(f.target.x, f.target.z, this.pos.y + STEP_UP);
      // Don't plant with the toes stuck into the face of a step or curb: stop
      // just short of it (the next step goes up onto it).
      const fx = Math.sin(stepYaw);
      const fz = Math.cos(stepYaw);
      for (let back = 0; back < 0.3; back += 0.03) {
        const toe = Humanoid.terrain.heightAt(f.target.x + fx * 0.22, f.target.z + fz * 0.22, this.pos.y + STEP_UP);
        if (toe <= f.target.y + 0.02) break;
        f.target.x -= fx * 0.03;
        f.target.z -= fz * 0.03;
        f.target.y = Humanoid.terrain.heightAt(f.target.x, f.target.z, this.pos.y + STEP_UP);
      }
      // Nor reach down off a drop deeper than a step: the last step lands at
      // the edge, heel on solid ground, and the body goes over it from there.
      for (let back = 0; back < 0.6 && this.vy === 0; back += 0.03) {
        const heel = Humanoid.terrain.heightAt(f.target.x - fx * 0.06, f.target.z - fz * 0.06, this.pos.y + STEP_UP);
        if (Math.min(f.target.y, heel) >= this.pos.y - 0.18) break;
        f.target.x -= fx * 0.03;
        f.target.z -= fz * 0.03;
        f.target.y = Humanoid.terrain.heightAt(f.target.x, f.target.z, this.pos.y + STEP_UP);
      }
      const local = (this.phase + f.offset) % 1;
      // A hurt leg spends less of the stride on the ground: a hobble.
      const duty = this.duty * f.dutyScale;
      if (local < duty) {
        if (!f.planted) {
          f.planted = true;
          f.pos.y = Humanoid.terrain.heightAt(f.pos.x, f.pos.z, Math.max(f.pos.y, f.target.y) + 0.05);
          f.landPitch = f.pitch;
          this.onFootstep?.(f);
        }
        // A foot left twisted by a turn pivots on its ball to follow the legs;
        // past what an ankle can take it gets dragged round.
        const twistErr = wrapAngle(f.yaw - this.lowerYaw);
        if (Math.abs(twistErr) > 1.2) {
          this._turnOnBall(f, wrapAngle(this.lowerYaw + Math.sign(twistErr) * 1.2));
        } else if (Math.abs(twistErr) > 0.5 && rateSpeed > 0) {
          this._turnOnBall(f, wrapAngle(f.yaw - Math.sign(twistErr) * Math.min(Math.abs(twistErr) - 0.5, (p.footPivotRate ?? 4) * dt)));
        }
        f.progress = local / duty;
        // The landing angle rolls onto a flat foot early in the stance...
        f.pitch = f.landPitch * (1 - smoothstep(clamp(f.progress / 0.18, 0, 1)));
        // ...and late in the stance the heel peels up before the foot leaves the
        // ground (or, walking backwards, the toes do).
        const late = push * smoothstep(clamp((f.progress - 0.55) / 0.45, 0, 1));
        f.heel = late * fwdRoll;
        f.pitch -= late * backRoll * 0.7;
      } else {
        if (f.planted) {
          f.planted = false;
          f.swingStart.copy(f.pos);
          f.liftHeel = f.heel;
          f.liftYaw = f.yaw;
          f.liftPitch = Math.min(f.pitch, 0);
        }
        const t = (local - duty) / (1 - duty);
        f.progress = t;
        // Stepping up, the foot rises to the new height first and only then
        // reaches forward onto it; stepping down, it reaches out over the edge
        // first and drops late. Either way it clears the edge instead of
        // ploughing through it.
        const rise = f.target.y - f.swingStart.y;
        const up = smoothstep(clamp(rise / 0.08, 0, 1));
        const down = smoothstep(clamp(-rise / 0.08, 0, 1));
        const along = smoothstep(clamp((t - 0.25 * up) / (1 - 0.25 * up), 0, 1));
        const ease = lerp(
          lerp(smoothstep(t), smoothstep(clamp(t / 0.45, 0, 1)), up),
          smoothstep(clamp((t - 0.5) / 0.5, 0, 1)),
          down,
        );
        f.pos.lerpVectors(f.swingStart, f.target, along);
        f.pos.y = f.swingStart.y + rise * ease;
        // Running, the heel kicks up early while the foot is still behind the
        // body, then reaches forward low; walking, the arc is nearly symmetric.
        const skew = 0.6 * runF;
        const lift = t + skew * t * (1 - t); // peaks at t = 0.5 walking, ~0.36 running
        const height = p.stepHeight * f.stepScale * (0.6 + 0.4 * speedF) * (1 + 1.2 * runF) + 0.04 * up;
        f.pos.y += Math.sin(Math.PI * lift) * height;
        // Whatever the curve says, keep the sole (heel to toe) above the ground under it.
        if (Math.abs(rise) > 0.02) {
          const top = Math.max(f.swingStart.y, f.target.y) + 0.05;
          const fx = Math.sin(f.yaw);
          const fz = Math.cos(f.yaw);
          const floor = Math.max(
            Humanoid.terrain.heightAt(f.pos.x + fx * 0.2, f.pos.z + fz * 0.2, top),
            Humanoid.terrain.heightAt(f.pos.x - fx * 0.06, f.pos.z - fz * 0.06, top),
          );
          f.pos.y = Math.max(f.pos.y, floor + 0.02 * (1 - smoothstep(clamp((t - 0.85) / 0.15, 0, 1))));
        }
        // The foot turns over the swing, done by the time it lands.
        f.yaw = wrapAngle(f.liftYaw + wrapAngle(stepYaw - f.liftYaw) * smoothstep(clamp(t / 0.8, 0, 1)));
        // The toe-off heel lift eases out instead of snapping flat.
        f.heel = f.liftHeel * (1 - smoothstep(clamp(t / 0.35, 0, 1)));
        // Toes come up to clear the ground, then the foot reaches heel-first.
        // Toes up for heel strike going forwards, toes down to land on going backwards.
        const strike = 0.3 * this.gaitAmt * (1 - 0.6 * runF) * f.stepScale * (fwdRoll - 0.8 * backRoll);
        const clear = 0.15 * f.stepScale * Math.sin(Math.PI * t);
        f.pitch = -lerp(clear, strike, smoothstep(clamp((t - 0.4) / 0.6, 0, 1)));
        f.pitch += f.liftPitch * (1 - smoothstep(clamp(t / 0.35, 0, 1)));
      }
    }

    // The hips ride at the height of the lowest foot holding weight, so going
    // up a step they rise as the back foot leaves the lower level, not the
    // instant the body's centre crosses the edge. Never above where the body
    // actually is (walking off an edge, they drop with it).
    let ground = Infinity;
    for (const f of this.feet) if (f.planted) ground = Math.min(ground, f.pos.y);
    if (ground === Infinity) ground = Math.min(this.feet[0].target.y, this.feet[1].target.y);
    ground = Math.min(ground, this.pos.y);
    // A critically damped spring: the hips ease into a step rather than lurch.
    if (dt > 0) {
      const k = 160;
      this.hipGroundVel += (k * (ground - this.hipGround) - 2 * Math.sqrt(k) * this.hipGroundVel) * dt;
      this.hipGround += this.hipGroundVel * dt;
      // Falling, the hips never hang above where the body is.
      if (this.vy < 0 && this.hipGround > this.pos.y) {
        this.hipGround = this.pos.y;
        this.hipGroundVel = this.vy;
      }
    } else {
      this.hipGround = ground;
      this.hipGroundVel = 0;
    }
  }

  // In the air the legs let go of the ground: the feet come up under the hips,
  // the left reaching ahead to land on (further the faster you're going), toes
  // hanging, and reach down again as the ground comes up to meet them.
  _airFeet(dt) {
    // 0 = legs reaching for the ground (fully so in the last few centimetres), 1 = tucked.
    const reach = smoothstep(clamp((this.dropLeft - 0.25) / 0.5, 0, 1));
    const fwdX = Math.sin(this.lowerYaw);
    const fwdZ = Math.cos(this.lowerYaw);
    for (const f of this.feet) {
      f.planted = false;
      this._restTarget(_v1, f);
      const lead = f.side < 0;
      _v1.x += fwdX * (lead ? 0.08 : -0.1) + this.vel.x * (lead ? 0.15 : 0.02);
      _v1.z += fwdZ * (lead ? 0.08 : -0.1) + this.vel.z * (lead ? 0.15 : 0.02);
      _v1.y = this.pos.y + 0.03 + (lead ? 0.17 : 0.23) * reach;
      // Carried along with the body, and eased over from wherever the foot
      // was, so stepping off doesn't pop.
      f.pos.x += this.vel.x * dt;
      f.pos.y += this.vy * dt;
      f.pos.z += this.vel.z * dt;
      const k = 1 - Math.exp(-8 * dt);
      f.pos.x += (_v1.x - f.pos.x) * k;
      f.pos.z += (_v1.z - f.pos.z) * k;
      f.pos.y = Math.max(f.pos.y + (_v1.y - f.pos.y) * (1 - Math.exp(-25 * dt)), this.pos.y + 0.01);
      f.swingStart.copy(f.pos);
      f.target.copy(_v1);
      f.progress = 0.5;
      f.yaw = dampAngle(f.yaw, this.lowerYaw, 10, dt);
      f.heel = damp(f.heel, 0, 12, dt);
      f.pitch = damp(f.pitch, 0.3 * reach, 10, dt);
    }
    this.hipGround = this.pos.y;
    this.hipGroundVel = this.vy;
    this.gaitAmt = damp(this.gaitAmt, 0, 6, dt);
  }

  // Touchdown: both feet take the ground where they are (flat), the stride
  // picks up from there, and the knees give with the impact.
  _land() {
    for (const f of this.feet) {
      f.pos.y = Humanoid.terrain.heightAt(f.pos.x, f.pos.z, this.pos.y + 0.05);
      f.planted = true;
      f.pitch = f.landPitch = 0;
      f.heel = 0;
    }
    // Landing puts both feet down for a moment even out of a run: lengthen the
    // stance (it eases back) and start on the left (the foot reached out to
    // land on) with the right about to step through.
    this.duty = Math.max(this.duty, 0.52);
    this.phase = (this.duty + 1 - this.feet[1].offset - 0.001) % 1;
    this.landDipVel -= Math.max(this.landedAt - 1.5, 0) * 0.9;
    this.onLand?.(this.landedAt);
    this.landedAt = 0;
  }

  _updateLandDip(dt) {
    if (dt <= 0) return;
    const k = 120;
    this.landDipVel += (-k * this.landDip - 2 * Math.sqrt(k) * 0.8 * this.landDipVel) * dt;
    this.landDip = Math.max(this.landDip + this.landDipVel * dt, -0.3);
  }

  // Turn a planted foot about the ball of the foot, which stays where it is
  // on the ground, rather than about the ankle (which would skid the sole).
  _turnOnBall(f, yaw) {
    f.pos.x += (Math.sin(f.yaw) - Math.sin(yaw)) * BALL_AHEAD;
    f.pos.z += (Math.cos(f.yaw) - Math.cos(yaw)) * BALL_AHEAD;
    f.yaw = yaw;
  }

  // 0 for a walk (always a foot on the ground), 1 for a run with a flight phase.
  _runFactor() {
    return smoothstep(clamp((0.55 - this.duty) / 0.2, 0, 1));
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
  _setHandTargets(dt) {}
  _afterPose() {}

  _poseBody(dt, snap = false) {
    const p = this.params;
    const pose = this.posture;
    const speedF = clamp(this.speed / p.runSpeed, 0, 1);
    const pitch = this.pitch + pose.pitch + this.traversalPose.pitch;
    const roll = this.roll + pose.roll + this.traversalPose.roll;

    // Gait motion of the hips, read off the feet rather than a clock, so it
    // stays in step through starts, stops, turns and limps.
    let bob = 0;
    let sway = 0;
    let hipYaw = 0;
    let hipRoll = 0;
    if (!this.traversal) {
      let arc = 0; // how squarely a foot is under the body: 1 at mid-stance
      let side = 0; // which side carries the weight: -1 left .. 1 right
      for (const f of this.feet) {
        if (!f.planted) continue;
        const a = Math.sin(Math.PI * f.progress);
        arc = Math.max(arc, a);
        side += f.side * a;
      }
      const runF = this._runFactor();
      const g = this.gaitAmt;
      // Walking vaults over a straight stance leg (highest mid-stance, lowest
      // with both feet down); running sinks into it (lowest mid-stance,
      // highest in flight).
      bob = g * p.bobAmount * lerp(0.7 * (1 - arc), 1.3 * arc, runF);
      // Weight shifts over the stance foot, and the hip on the swing side drops.
      sway = g * p.hipSway * (1 - 0.6 * runF) * side;
      hipRoll = -g * 0.06 * (1 - 0.5 * runF) * side;
      // Standing, the weight drifts slowly from foot to foot.
      if (dt > 0) this.idleTime += dt;
      const drift = (1 - g) * Math.sin(this.idleTime * 0.7) * Math.sin(this.idleTime * 0.23 + 1);
      sway += drift * 0.014;
      hipRoll -= drift * 0.02;
      // The hips turn to follow the legs: the leading foot's hip comes forward.
      _v1.subVectors(this.feet[1].pos, this.feet[0].pos);
      hipYaw = clamp((_v1.x * Math.sin(this.lowerYaw) + _v1.z * Math.cos(this.lowerYaw)) * p.hipSwing, -0.3, 0.3);
    }
    rightOf(_v3, this.lowerYaw);
    this.pelvisPos.set(
      this.pos.x + _v3.x * sway,
      (this.traversal ? this.pos.y : this.hipGround + this.landDip) + p.hipHeight - p.crouch * speedF - bob + this.heightOffset,
      this.pos.z + _v3.z * sway,
    );
    quatFrom(this.pelvisQuat, pitch * 0.35, this.pelvisYaw + hipYaw, roll * 0.35 + hipRoll);
    // Breathing: the chest rises and opens a touch. Slow at rest, quicker and
    // deeper after a sprint, settling back over several seconds.
    if (dt > 0) {
      this.exertion = clamp(this.exertion + (speedF > 0.8 ? 0.12 : -0.08) * dt, 0, 1);
      this.breath = (this.breath + (0.25 + 0.35 * this.exertion) * dt) % 1;
    }
    const breath = this.traversal ? 0 : Math.sin(this.breath * Math.PI * 2) * (1 + this.exertion) * (1 - 0.5 * this.gaitAmt);
    // Shoulders counter-rotate against the hips, keeping the head and gun steady.
    quatFrom(this.chestQuat, pitch - breath * 0.015, this.chestYaw - hipYaw * 0.4, roll - hipRoll * 0.5);
    // Three-part spine: the lower back takes half the bend, so the torso
    // curves instead of tipping over as one plank.
    _q1.slerpQuaternions(this.pelvisQuat, this.chestQuat, 0.5);
    localPoint(_v1, this.pelvisPos, this.pelvisQuat, 0, 0.08, 0);
    _v1.add(localDir(_v2, _q1, 0, 0.13, 0));
    this.chestPos.addVectors(_v1, localDir(_v2, this.chestQuat, 0, 0.15, 0));
    this.chestPos.y += breath * 0.005;
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
      localDir(_f2, this.chestQuat, 0, 0, 1),
    );

    // Hands chase their targets through a spring, so they carry momentum.
    this._setHandTargets(dt);
    this._traversalHands();
    // Mid-vault the body moves far faster than a walking arm, so the hands get
    // a stiffer, stronger spring or the gun hand lags and swings up past the gun.
    const grip = this.traversal ? 3 : 1;
    const stiffness = p.handStiffness * grip;
    const maxAccel = p.handMaxAccel * grip * grip;
    const damping = 2 * Math.sqrt(stiffness) * p.handDampingRatio;
    for (const h of [this.hands.left, this.hands.right]) {
      if (snap) {
        h.pos.copy(h.target);
        h.vel.set(0, 0, 0);
        h.targetVel.set(0, 0, 0);
      } else if (dt > 0) {
        h.targetVel.subVectors(h.target, h.prevTarget).divideScalar(dt);
        // A sudden target switch is a teleport, not motion to follow.
        if (h.targetVel.lengthSq() > 144) h.targetVel.set(0, 0, 0);
        springVec(h.pos, h.vel, h.target, h.targetVel, stiffness, damping, maxAccel, dt);
      }
      h.prevTarget.copy(h.target);
      h.error = h.pos.distanceTo(h.target);
    }

    // Arms: two-bone IK from shoulder to the spring-driven hand.
    for (const [i, arm] of this.arms.entries()) {
      const hand = arm.side < 0 ? this.hands.left : this.hands.right;
      localPoint(arm.shoulderBase, this.chestPos, this.chestQuat, arm.side * this.dims.shoulderX, 0.12, p.roundShoulders);
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
      // A part shot off has gone with the gore; nothing to lay out.
      // The arm's front faces away from the way the elbow points.
      bendFront(_f1, arm.shoulder, arm.elbow, arm.wrist, localDir(_f2, this.chestQuat, 0, 0, -1)).negate();
      if (!arm.lostUpper) arm.upper.place(arm.shoulder, arm.elbow, _f1);
      if (arm.lostFore) continue;
      arm.fore.place(arm.elbow, arm.wrist, _f1);

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
      localPoint(leg.hip, this.pelvisPos, this.pelvisQuat, f.side * this.dims.hipX, -0.06, 0);
      // The foot rocks on whichever end touches the ground: on the heel with
      // the toes up (heel strike), on the toe joint with the heel up (push-off;
      // the toes stay flat). That point stays put and the ankle goes where the
      // tilted foot puts it, so the sole never skids or sinks.
      const footPitch = f.pitch + f.heel;
      // Feet point a little outward, as they naturally do.
      const footYaw = this.traversal ? f.yaw : f.yaw - f.side * 0.12;
      quatFrom(_qf, footPitch, footYaw, 0);
      if (this.traversal) {
        leg.ankleTarget.copy(f.pos);
        leg.ankleTarget.y += DIMS.ankle;
      } else {
        const pivot = footPitch >= 0 ? FOOT_TOE_HINGE : FOOT_HEEL;
        // Where that point sits with the foot flat, then back up to the ankle.
        leg.ankleTarget.copy(pivot).sub(FOOT_SOLE).applyAxisAngle(UP, footYaw).add(f.pos);
        leg.ankleTarget.sub(_v1.copy(pivot).sub(FOOT_ANKLE).applyQuaternion(_qf));
      }
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
      // Climbing, or a knee that has walked into something (stepping up beside
      // a high ledge): swing it clear around the hip-ankle line.
      const solid = Humanoid.terrain.solidAt;
      if (solid && (this.traversal || leg.kneeTurn || solid(leg.knee) || solid(_k2.lerpVectors(leg.knee, leg.ankle, 0.3)))) {
        this._clearKnee(leg, _v3, dt);
      } else leg.kneeTurn = 0;
      // The leg's front faces where the knee points (the foot's way when straight).
      bendFront(_f1, leg.hip, leg.knee, leg.ankle, _f2.set(0, 0, 1).applyQuaternion(_qf));
      leg.thigh.place(leg.hip, leg.knee, _f1);
      leg.shin.place(leg.knee, leg.ankle, _f1);
      // Running, a foot in the air hangs off the shin (roughly square to it,
      // toes a little pointed) instead of staying level with the ground: the
      // shin swinging up behind would otherwise fold the foot back on itself.
      // Walking keeps the toes up to clear the ground, so it stays as it is.
      if (!f.planted && !this.traversal) {
        const t = f.progress;
        const w =
          this._runFactor() * smoothstep(clamp(t / 0.3, 0, 1)) * (1 - smoothstep(clamp((t - 0.6) / 0.4, 0, 1)));
        if (w > 0) {
          _v3.subVectors(leg.ankle, leg.knee);
          const shinLean = Math.atan2(_v3.x * Math.sin(f.yaw) + _v3.z * Math.cos(f.yaw), -_v3.y);
          let hang = lerp(footPitch, clamp(-shinLean + 0.25, -0.4, 1.6), w);
          // Never point the toes into the ground.
          const clearance = leg.ankle.y - Math.max(f.swingStart.y, f.target.y) - 0.045;
          hang = Math.min(hang, Math.asin(clamp(clearance / 0.21, -1, 1)));
          quatFrom(_qf, Math.max(hang, Math.min(footPitch, 0)), footYaw, 0);
        }
      }
      leg.foot.quaternion.copy(_qf);
      // Toes stay flat on the ground: behind a lifted heel, and under a foot
      // landing toes-first (walking backwards) as it comes down.
      const toesDown = this.traversal ? 0 : Math.max(f.pitch, 0) * (f.planted ? 1 : smoothstep(clamp((f.progress - 0.6) / 0.3, 0, 1)));
      leg.toe.rotation.x = -(f.heel + toesDown);
      // The foot hangs rigidly off the ankle the leg actually reached.
      leg.foot.position.copy(leg.ankle).sub(_v1.copy(FOOT_ANKLE).applyQuaternion(_qf));
    }

    this._afterPose();

    if (this.markers[0].visible) {
      for (const { point, mesh } of this.markerPoints) mesh.position.copy(point);
    }
  }
}
