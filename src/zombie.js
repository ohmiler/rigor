import * as THREE from 'three';
import { Humanoid } from './humanoid.js';
import { traversalTiming } from './traversal.js';
import { DEG, dampAngle, damp, localPoint } from './rig-utils.js';
import { Ragdoll, RAGDOLL } from './ragdoll.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _desired = new THREE.Vector3();

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const rand = (a, b) => a + Math.random() * (b - a);

const SKINS = ['#9aa58a', '#8d9a80', '#a3a08a', '#a89c8c', '#8f9c94'];
const SHIRTS = ['#6b5a4a', '#4f5d6b', '#7a3e3a', '#5a6b4f', '#8a8576', '#3d4a5c', '#6e6a5e'];
const PANTS = ['#3b3a36', '#2f3a4a', '#4a4036', '#35302b'];
const HAIR = ['#1f1b17', '#2d241c', '#4a3b2c', null];

// The kinds of zombie. Each overrides some of the shared levers (the rest
// still follow the panel) and some of the look.
export const ZOMBIE_TYPES = {
  // The common shambler.
  walker: { params: {}, health: 1, legHealth: 1, bulk: 1 },
  // Fresh and fast: outruns a jog, not a sprint. Rare, frail, terrifying.
  runner: {
    params: {
      chaseSpeed: 3.1, runSpeed: 3.6, acceleration: 9, turnRate: 6, hipTurnRate: 7, legTurnRate: 360,
      strideBase: 0.9, strideScale: 0.3, dutyRun: 0.42, stepHeight: 0.13, limp: 0.12, detectRange: 14,
      maxLean: 35, leanSpeed: 0.06, hunch: 28, grabWindup: 0.25, handStiffness: 120,
    },
    health: 0.7, legHealth: 0.7, bulk: 0.95,
    skins: ['#b9b8a4', '#aeb3a0'], shirts: ['#2b2b2b', '#5a1f1f', '#3a2f2a'],
  },
  // Huge and slow, soaks bullets. Doesn't grab: it swings, and the blow
  // throws you. You can't struggle out of that, only keep out of reach.
  brute: {
    params: { chaseSpeed: 0.95, hitShove: 0.4, footSpread: 0.17, stepHeight: 0.07, hunch: 12, limp: 0.2, armReach: 0.5, leanStiffness: 50, strideBase: 0.85 },
    health: 3.5, legHealth: 3, bulk: 1.45,
    skins: ['#8a947a', '#7f8a74'], shirts: ['#3a4a2a', '#2c2c34', '#4a3a2a'],
  },
  // When it sees you it shrieks, and every zombie in earshot comes. Kill it first.
  screamer: {
    params: { chaseSpeed: 1.1, detectRange: 15, hunch: 5, limp: 0.3 },
    health: 0.6, legHealth: 0.8, bulk: 0.9,
    skins: ['#c8cab9', '#bfc2b0'], shirts: ['#c9c4b8', '#b8a99a'],
  },
};

export const HIT_RADIUS = 0.28;

const _r1 = new THREE.Vector3();
const _r2 = new THREE.Vector3();
const _r3 = new THREE.Vector3();

// Distance along a ray (unit `dir`) to a ball, or null.
function raySphere(o, dir, c, r) {
  _r1.subVectors(c, o);
  const t = _r1.dot(dir);
  const d2 = _r1.lengthSq() - t * t;
  if (d2 > r * r) return null;
  const hit = t - Math.sqrt(r * r - d2);
  return hit >= 0 ? hit : t >= 0 ? 0 : null;
}

// Distance along a ray to a capsule from `a` to `b`, or null. Close enough
// for hit tests: the nearest approach between the ray and the segment,
// stepped back by the radius.
function rayCapsule(o, dir, a, b, r) {
  const seg = _r1.subVectors(b, a);
  const w = _r2.subVectors(o, a);
  const segLen2 = seg.lengthSq();
  const bDot = dir.dot(seg);
  const d = dir.dot(w);
  const e = seg.dot(w);
  const denom = segLen2 - bDot * bDot;
  let s = denom > 1e-8 ? (e - bDot * d) / denom : 0; // along the segment...
  s = Math.min(Math.max(s, 0), 1);
  const t = bDot * s - d; // ...and along the ray
  if (t < 0) return null;
  const closest = _r3.copy(a).addScaledVector(seg, s);
  const d2 = _r2.copy(o).addScaledVector(dir, t).distanceToSquared(closest);
  if (d2 > r * r) return null;
  return Math.max(t - Math.sqrt(r * r - d2), 0);
}

/**
 * Same body system as the player, tuned to look broken: a limp on one leg,
 * a hunched spine, loose arms on soft springs, and a slow turn rate.
 */
export class Zombie extends Humanoid {
  constructor(scene, shared, position, type = 'walker') {
    const kind = ZOMBIE_TYPES[type] ?? ZOMBIE_TYPES.walker;
    // Its own levers: the type's overrides on top of the shared panel values.
    const params = Object.assign(Object.create(shared), kind.params);
    const hair = pick(HAIR);
    super(scene, params, {
      skin: pick(kind.skins ?? SKINS),
      shirt: pick(kind.shirts ?? SHIRTS),
      pants: pick(PANTS),
      shoes: '#22201d',
      cap: hair,
      brim: false,
      bulk: kind.bulk,
    });
    this.type = type;
    this.hitRadius = HIT_RADIUS * kind.bulk;

    // Per-zombie variation so a crowd never moves in sync.
    this.quirk = {
      speed: rand(0.75, 1.2),
      limpSide: Math.random() < 0.5 ? -1 : 1,
      limp: rand(0.4, 1),
      hunch: rand(0.6, 1.3),
      headTilt: rand(-0.35, 0.35),
      seed: Math.random() * 100,
      armLift: [rand(0.7, 1.15), rand(0.7, 1.15)],
      climbDelay: rand(0.6, 1.6),
    };

    this.pos.copy(position);
    this.aimYaw = rand(-Math.PI, Math.PI);
    this.health = params.health * kind.health;
    this.state = 'wander';
    this.wanderTarget = new THREE.Vector3().copy(position);
    this.wanderTimer = 0;
    this.stagger = 0;
    this.reach = 0;
    this.time = 0;
    this.player = null;

    this.dead = false;
    this.deathT = 0;
    this.removed = false;
    this.legHealth = (params.legHealth ?? 60) * kind.legHealth;
    this.legHealth0 = this.legHealth;
    // Each limb takes its own damage. A leg past half the leg health is
    // crippled (it hobbles on it); an arm past its health is shot off.
    this.legDamage = [0, 0];
    this.armHealth = [1, 1].map(() => (params.armHealth ?? 30) * kind.legHealth);
    this.injurySpeed = 1; // slowed by a crippled leg
    this.armLean = 0; // constant sideways lean from a missing arm
    this.slamCooldown = 0;
    this.screamCooldown = 0;
    this.screaming = 0; // seconds left of a shriek (head back, arms out)
    this.ragdoll = null; // dead, or crawling on its arms with its legs shot out
    this.crawlDelay = 0;

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

  // Wounds change how it moves. A crippled leg becomes the bad leg: it barely
  // lifts, takes weight only briefly (a hobble), the body drops onto it
  // every step, and it slows to about half. A missing arm tips the body
  // toward the side that still has its weight.
  _updateInjuries() {
    const q = this.quirk;
    const crippleAt = this.legHealth0 * 0.5;
    let worst = -1;
    this.legDamage.forEach((d, i) => {
      if (d >= crippleAt && (worst < 0 || d > this.legDamage[worst])) worst = i;
    });
    if (worst >= 0) {
      q.limpSide = worst === 0 ? -1 : 1;
      q.limp = 1;
      this.limpBoost = 2.6;
      this.feet.forEach((f, i) => {
        f.stepScale = i === worst ? 0.22 : 1;
        f.dutyScale = i === worst ? 0.62 : 1;
      });
      this.feet[1].offset = 0.5 + 0.12 * q.limpSide;
      this.injurySpeed = 0.55;
    }
    const lost = this.arms.map((a) => (a.lostUpper ? 1 : a.lostFore ? 0.5 : 0));
    this.armLean = (lost[1] - lost[0]) * 0.12; // + rolls toward the left (three.js +X)
  }

  // A dark, blood-soaked copy of one of its materials (once per kind).
  _bloodied(kind) {
    this._soaked ??= {};
    if (!this._soaked[kind]) {
      const m = this.materials[kind].clone();
      m.color.lerp(new THREE.Color('#3d0808'), 0.45);
      this._soaked[kind] = m;
    }
    return this._soaked[kind];
  }

  // Both forearms gone: nothing to grab with.
  get canGrab() {
    return !(this.arms[0].lostFore && this.arms[1].lostFore);
  }

  // ---------------------------------------------------------------- update

  update(dt, world) {
    if (this.ragdoll) {
      this._updateRagdoll(dt, world);
      return;
    }
    const p = this.params;
    this.time += dt;
    this.player = world.player;

    if (this.traversal) {
      this._updateTraversal(dt);
      this._updateYaws(dt);
      this._updateLean(dt);
      this._poseBody(dt);
      return;
    }

    const player = world.player;
    const grapple = world.grapple;
    this.grabCooldown = Math.max((this.grabCooldown ?? 0) - dt, 0);

    _v1.subVectors(player.state === 'dead' ? player.deathPos : player.pos, this.pos);
    _v1.y = 0;
    const dist = _v1.length();
    if ((this.state === 'wander' || this.state === 'investigate') && dist < p.detectRange) this.state = 'chase';
    if (player.state === 'dead' && (this.state === 'chase' || this.state === 'lunge' || this.state === 'grab')) {
      this.state = 'feed';
    }

    _desired.set(0, 0, 0);
    let faceYaw = this.aimYaw;
    let crouch = 0;
    const level = Math.abs(player.pos.y - this.pos.y) < 0.4; // same height as the player
    if (this.state === 'chase') {
      faceYaw = Math.atan2(_v1.x, _v1.z);
      if (dist > p.attackRange) _desired.copy(_v1).setLength(p.chaseSpeed * this.quirk.speed * this.injurySpeed);

      // Player is up on something: crowd below, and eventually clamber up after them.
      this.climbTimer = this.climbTimer ?? 0;
      if (player.pos.y > this.pos.y + 0.4 && dist < 2.4) {
        this.climbTimer += dt;
        if (this.climbTimer > p.climbDelay * this.quirk.climbDelay) {
          const ledge = Humanoid.terrain.findLedge(this.pos, _v2.copy(_v1).normalize());
          if (ledge?.type === 'climb') {
            const { duration } = traversalTiming(ledge, this.pos.y);
            this.startTraversal(ledge, { duration: duration * p.climbSlowness, bothHands: true });
          }
          this.climbTimer = 0;
        }
      } else {
        this.climbTimer = Math.max(this.climbTimer - dt, 0);
      }

      // A brute winds up a swing; everything else lunges to grab.
      if (this.type === 'brute') {
        if (level && dist < 1.4 && this.stagger <= 0 && this.slamCooldown <= 0 && player.state !== 'dead') {
          this.state = 'slam';
          this.slamT = 0;
        }
      } else if (level && dist < p.attackRange + 0.2 && this.stagger <= 0 && this.grabCooldown <= 0 && this.canGrab && grapple.canGrab()) {
        this.state = 'lunge';
        this.lungeT = 0;
        this.jolt(_v2.copy(_v1).normalize(), 2.5);
      }
    } else if (this.state === 'slam') {
      // Arms up, a step in, then the blow lands if you're still there.
      faceYaw = Math.atan2(_v1.x, _v1.z);
      this.slamT += dt;
      if (this.slamT >= 0.55) {
        if (level && dist < 1.75) this.onSlam?.(_v2.copy(_v1).normalize());
        this.jolt(_v2.copy(_v1).normalize(), 3);
        this.slamCooldown = 2.2;
        this.state = 'chase';
      }
    } else if (this.state === 'lunge') {
      faceYaw = Math.atan2(_v1.x, _v1.z);
      _desired.copy(_v1).setLength(p.chaseSpeed * 1.8);
      this.lungeT += dt;
      if (this.lungeT >= p.grabWindup) {
        // Only connects if you're still in reach when the lunge lands.
        if (!(level && dist < p.attackRange + 0.35 && grapple.grab(this))) {
          this.state = 'chase';
          this.grabCooldown = 1;
        }
      }
    } else if (this.state === 'grab') {
      faceYaw = Math.atan2(_v1.x, _v1.z);
      // Hang on at arm's length, pulling in close.
      _v2.copy(_v1).setLength(dist - 0.5);
      _desired.copy(_v2).multiplyScalar(6);
      if (Math.random() < dt * 1.5) this.jolt(_v2.copy(_v1).normalize(), 1.6); // gnashing lunges
    } else if (this.state === 'feed') {
      faceYaw = Math.atan2(_v1.x, _v1.z);
      if (dist > 0.75) _desired.copy(_v1).setLength(p.chaseSpeed * this.quirk.speed * this.injurySpeed);
      else crouch = -0.33; // kneel over the body
    } else if (this.state === 'investigate') {
      // Off to see what made that noise, a bit quicker than a wander; once
      // there it looks about for a while, then goes back to wandering.
      _v2.subVectors(this.noiseAt, this.pos);
      _v2.y = 0;
      if (_v2.length() > 0.8) {
        _desired.copy(_v2).setLength(p.wanderSpeed * 2 * this.quirk.speed * this.injurySpeed);
        faceYaw = Math.atan2(_v2.x, _v2.z);
      } else {
        this.investigateT += dt;
        faceYaw = this.aimYaw + Math.sin(this.investigateT * 1.3 + this.quirk.seed) * 0.8 * dt;
        if (this.investigateT > 4) {
          this.state = 'wander';
          this.wanderTimer = 0;
        }
      }
    } else {
      this.wanderTimer -= dt;
      _v2.subVectors(this.wanderTarget, this.pos);
      _v2.y = 0;
      if (this.wanderTimer <= 0 || _v2.length() < 0.4) {
        this.wanderTimer = rand(4, 9);
        this.wanderTarget.set(this.pos.x + rand(-5, 5), 0, this.pos.z + rand(-5, 5));
      } else if (_v2.length() > 0.4) {
        _desired.copy(_v2).setLength(p.wanderSpeed * this.quirk.speed * this.injurySpeed);
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
    this.slamCooldown = Math.max(this.slamCooldown - dt, 0);

    // A screamer that has seen you stops to shriek, and again every so often.
    this.screamCooldown = Math.max(this.screamCooldown - dt, 0);
    this.screaming = Math.max(this.screaming - dt, 0);
    if (this.type === 'screamer' && this.state === 'chase' && this.screamCooldown <= 0 && player.state !== 'dead') {
      this.screaming = 1.3;
      this.screamCooldown = 8;
      this.onScream?.(this);
    }
    if (this.screaming > 0) _desired.set(0, 0, 0);

    this.aimYaw = dampAngle(this.aimYaw, faceYaw, p.turnRate, dt);
    this.knockT = Math.max((this.knockT ?? 0) - dt, 0);
    this._locomote(dt, _desired, this.knockT > 0 ? 0.25 : 1);

    // Posture: hunched forward with the head craned up to look ahead, and the
    // whole body dipping toward the bad leg while it's taking weight.
    const q = this.quirk;
    const bad = this.feet[q.limpSide < 0 ? 0 : 1];
    const dip = bad.planted && this.speed > 0.1 ? Math.sin(bad.progress * Math.PI) : 0;
    this.heightOffset = damp(this.heightOffset, crouch, 4, dt);
    const feeding = crouch < 0 ? 0.5 : 0;
    this.posture.pitch = p.hunch * DEG * q.hunch + feeding + Math.sin(this.time * 1.3 + q.seed) * 0.04;
    // A crippled leg drops the body hard onto it each step (limpBoost).
    this.posture.roll = -q.limpSide * dip * q.limp * Math.max(p.limp, this.limpBoost ? 1 : 0) * 0.18 * (this.limpBoost ?? 1) + this.armLean;
    this.posture.headPitch = -this.posture.pitch * 0.7 - (this.screaming > 0 ? 0.8 : 0); // head thrown back
    this.posture.headRoll = q.headTilt;

    this._updateBody(dt);
    this._poseBody(dt);
  }

  // Arms hang while wandering and reach out once it has seen you; within
  // arm's length they grab toward your chest.
  _setHandTargets(dt) {
    const p = this.params;
    const q = this.quirk;
    const player = this.player;

    if (this.state === 'slam') {
      // Both fists raised high, then brought down as the blow lands.
      const k = Math.min(this.slamT / 0.45, 1);
      for (const [i, hand] of [this.hands.left, this.hands.right].entries()) {
        const side = i === 0 ? -1 : 1;
        localPoint(hand.target, this.chestPos, this.chestQuat, side * 0.16, 0.2 + 0.45 * k, 0.15 + 0.1 * (1 - k));
      }
      return;
    }
    if (this.screaming > 0) {
      // Arms flung out wide.
      for (const [i, hand] of [this.hands.left, this.hands.right].entries()) {
        const side = i === 0 ? -1 : 1;
        localPoint(hand.target, this.chestPos, this.chestQuat, side * 0.6, 0.05, 0.15);
      }
      return;
    }
    if (this.state === 'grab' && player) {
      // Clamp onto the player's shoulders (crossed: our left takes their right).
      // (A stump just swings.)
      this.hands.left.target.copy(player.arms[1].shoulder);
      this.hands.right.target.copy(player.arms[0].shoulder);
      return;
    }
    if (this.state === 'feed' && player && this.heightOffset < -0.15) {
      // Tearing at the body on the ground.
      for (const [i, hand] of [this.hands.left, this.hands.right].entries()) {
        const tug = Math.sin(this.time * 9 + i * Math.PI + q.seed);
        hand.target.lerpVectors(this.chestPos, player.deathPos, 0.8);
        hand.target.y = 0.12 + Math.max(tug, 0) * 0.25;
        hand.target.x += (i ? 0.12 : -0.12) * Math.cos(this.aimYaw);
        hand.target.z -= (i ? 0.12 : -0.12) * Math.sin(this.aimYaw);
      }
      return;
    }

    const chasing = (this.state === 'chase' || this.state === 'lunge' || this.state === 'feed') && this.stagger <= 0;
    this.reach = damp(this.reach, chasing ? 1 : 0.15, 3, dt || 0);

    const near = player && player.state !== 'dead' && player.pos.distanceTo(this.pos) < 1.3;
    for (const [i, hand] of [this.hands.left, this.hands.right].entries()) {
      const side = i === 0 ? -1 : 1;
      const sway = Math.sin(this.time * 2.1 + q.seed + i * 1.7) * 0.05;
      // Hanging: down by the hip, swinging a little with the walk.
      localPoint(_v1, this.chestPos, this.chestQuat, side * 0.22, -0.48, 0.06 + sway);
      // Reaching: forward at shoulder height, each arm a bit different.
      localPoint(_v2, this.chestPos, this.chestQuat, side * 0.14, 0.02 + sway * q.armLift[i], p.armReach * q.armLift[i]);
      if (near && chasing) _v2.lerp(player.chestPos, 0.6);
      hand.target.lerpVectors(_v1, _v2, this.reach);
    }
  }

  // ---------------------------------------------------------------- damage

  // Ray vs. vertical capsule (good enough for a top-down shooter); a crawler
  // lying on the road is tested limb by limb instead.
  // The upright body as its parts: a ball for the head, capsules for the
  // torso, arms and legs, all where they are this frame. So the head is only
  // as big as a head (a hunched one carries it low and forward), the legs
  // are the legs, and a steep ray from the camera picks the part under the
  // cursor rather than the top of a cylinder.
  raycast(origin, dir) {
    if (this.dead) return null;
    if (this.ragdoll) return this.ragdoll.raycast(origin, dir);
    const k = this.hitRadius / HIT_RADIUS; // bulk
    let best = null;
    const test = (t, zone, limb = null, part = null) => {
      if (t !== null && (!best || t < best.distance)) best = { distance: t, zone, limb, part };
    };
    test(raySphere(origin, dir, this.headPos, 0.13), 'head');
    _v1.copy(this.chestPos).add(_v2.set(0, 0.14, 0));
    test(rayCapsule(origin, dir, this.pelvisPos, _v1, 0.19 * k), 'body');
    this.arms.forEach((arm, i) => {
      if (!arm.lostUpper) test(rayCapsule(origin, dir, arm.shoulder, arm.elbow, 0.06 * k), 'arm', i, 'upper');
      if (!arm.lostFore) test(rayCapsule(origin, dir, arm.elbow, arm.wrist, 0.05 * k), 'arm', i, 'fore');
    });
    this.legs.forEach((leg, i) => {
      test(rayCapsule(origin, dir, leg.hip, leg.knee, 0.085 * k), 'legs', i);
      test(rayCapsule(origin, dir, leg.knee, leg.ankle, 0.07 * k), 'legs', i);
    });
    if (!best) return null;
    const y = origin.y + dir.y * best.distance;
    return {
      distance: best.distance,
      headshot: best.zone === 'head',
      leg: best.zone === 'legs',
      arm: best.zone === 'arm',
      limb: best.limb, // which arm or leg (0 left, 1 right)
      part: best.part, // 'upper' | 'fore' for an arm
      height: y,
    };
  }

  takeHit(dir, damage, hit = {}) {
    if (this.dead) return;
    this.state = 'chase';
    this.stagger = 0.35;
    if (this.ragdoll) {
      // A crawler takes it on the ground: it jerks with the bullet.
      this.health -= damage;
      this.ragdoll.impulse(_v1.copy(dir).multiplyScalar(1.2), { height: this.ragdoll.chest.y });
      this.crawlDelay = Math.max(this.crawlDelay, 0.4);
      if (this.health <= 0) this._die(dir, hit);
      return;
    }
    if (hit.leg) {
      // Legs soak the hit (half reaches the body). One leg shot up and it
      // hobbles on it; enough leg damage all told and it goes down to crawl.
      this.health -= damage * 0.5;
      this.legHealth -= damage;
      const i = hit.limb ?? (Math.random() < 0.5 ? 0 : 1);
      this.legDamage[i] += damage;
      this.legs[i].thigh.mesh.material = this.legs[i].shin.mesh.material = this._bloodied('pants');
      if (this.health <= 0) this._die(dir, hit);
      else if (this.legHealth <= 0) this._startCrawl(dir);
      else this._updateInjuries();
      return;
    }
    if (hit.arm) {
      // An arm hit: shot through, the forearm comes off; hit again on the
      // stump, the rest of the arm. Little reaches the body.
      this.health -= damage * 0.4;
      const i = hit.limb;
      this.armHealth[i] -= damage;
      const arm = this.arms[i];
      if (this.armHealth[i] <= 0 && !arm.lostFore) {
        arm.lostFore = true;
        this.onSever?.(this, i, 'fore', dir);
      } else if (this.armHealth[i] <= 0 && hit.part === 'upper' && !arm.lostUpper) {
        arm.lostUpper = true;
        this.onSever?.(this, i, 'upper', dir);
      }
      this.leanVel.x += dir.x * this.params.hitShove * 0.5;
      this.leanVel.y += dir.z * this.params.hitShove * 0.5;
      if (this.health <= 0) this._die(dir, hit);
      else this._updateInjuries();
      return;
    }
    this.health -= damage;
    // Shove the torso spring and throw the arms back along the bullet.
    this.leanVel.x += dir.x * this.params.hitShove;
    this.leanVel.y += dir.z * this.params.hitShove;
    for (const h of [this.hands.left, this.hands.right]) h.vel.addScaledVector(dir, 3);
    if (this.health <= 0) this._die(dir, hit);
  }

  // Grab struggles and bites rock the torso; on the ground, they rock the body.
  jolt(dir, amount) {
    if (this.ragdoll) {
      if (!this.dead) this.ragdoll.nudge(RAGDOLL.CHEST, _v1.set(dir.x, 0, dir.z).multiplyScalar(amount * 0.15));
      return;
    }
    super.jolt(dir, amount);
  }

  alert() {
    if (!this.dead && (this.state === 'wander' || this.state === 'investigate')) this.state = 'chase';
  }

  // A noise somewhere (a bottle smashing): if it hasn't seen you, it goes to look.
  investigate(point) {
    if (this.dead || this.ragdoll || (this.state !== 'wander' && this.state !== 'investigate')) return;
    this.state = 'investigate';
    this.noiseAt = point.clone();
    this.investigateT = 0;
  }

  // Thrown off when the player breaks free.
  shove(dir, strength) {
    this.state = 'chase';
    this.stagger = 1.4;
    this.grabCooldown = 2.5;
    if (this.ragdoll) {
      this.ragdoll.impulse(_v1.copy(dir).multiplyScalar(strength * 0.4).setY(0.6));
      this.crawlDelay = 1.2;
      return;
    }
    this.jolt(dir, strength);
    // Thrown back: it slides with the blow for a moment before its feet catch.
    this.vel.copy(dir).setY(0).multiplyScalar(strength * 0.7);
    this.knockT = 0.45;
  }

  // Dead: the body goes limp from the pose it was in, carrying its momentum,
  // and the bullet knocks it the way it was going at the height it hit.
  _die(dir, hit = {}) {
    this.dead = true;
    this.deathT = 0;
    for (const m of this.markers) m.visible = false;
    if (!this.ragdoll) this.ragdoll = new Ragdoll(this, { vel: this.vel });
    this.ragdoll.drive = null;
    for (const p of this.ragdoll.particles) p.pinned = false;
    const height = hit.height ?? this.pos.y + (hit.headshot ? 1.5 : 1.1);
    this.ragdoll.impulse(_v1.copy(dir).setY(0).normalize().multiplyScalar(hit.headshot ? 3.2 : 2.4), { height, spread: 0.45 });
  }

  // Legs shot out from under it: it drops (legs swept back along the bullet,
  // so it falls on its face), lies there a moment, then starts to crawl.
  _startCrawl(dir) {
    this.ragdoll = new Ragdoll(this, { vel: this.vel });
    _v1.copy(dir).setY(0).normalize();
    this.ragdoll.impulse(_v2.copy(_v1).multiplyScalar(2.6), { height: this.pos.y + 0.3, spread: 0.3 });
    this.ragdoll.impulse(_v2.copy(_v1).multiplyScalar(-1.4), { height: this.pos.y + 1.3, spread: 0.35 });
    this.crawlDelay = 1.3;
    this.state = 'chase';
    for (const m of this.markers) m.visible = false;
  }

  _updateRagdoll(dt, world) {
    const rd = this.ragdoll;
    this.time += dt;
    if (this.dead) {
      rd.update(dt);
      rd.apply();
      this.deathT += dt;
      if (this.deathT > this.params.corpseTime) {
        this.dispose();
        this.removed = true;
      }
      return;
    }

    // Crawling after you.
    const p = this.params;
    const player = world.player;
    this.player = player;
    this.grabCooldown = Math.max((this.grabCooldown ?? 0) - dt, 0);
    this.crawlDelay -= dt;
    const target = player.state === 'dead' ? player.deathPos : player.pos;
    if (player.state === 'dead') this.state = 'feed';
    else if (this.state !== 'grab') this.state = 'chase';
    _v1.subVectors(target, rd.chest).setY(0);
    const dist = _v1.length();

    let mode = 'idle';
    if (this.state === 'grab') mode = 'grab';
    else if (this.crawlDelay <= 0 && !(this.state === 'feed' && dist < 0.6)) mode = 'crawl';
    rd.drive = {
      mode,
      target,
      speed: p.crawlSpeed * this.quirk.speed,
      reach: [player.legs[0].ankle, player.legs[1].ankle], // grabbing at your ankles
      onPlant: (pos) => this.onFootstep?.({ pos, stepScale: 0 }), // a hand slapping the road
    };
    rd.update(dt);
    rd.apply();
    this.pos.set(rd.pelvis.x, Humanoid.terrain.heightAt(rd.pelvis.x, rd.pelvis.z, rd.pelvis.y + 0.3), rd.pelvis.z);

    // Close enough: it grabs your ankle from the ground.
    const level = Math.abs(player.pos.y - this.pos.y) < 0.4;
    if (this.state === 'chase' && level && dist < 0.8 && this.crawlDelay <= 0 && this.grabCooldown <= 0 && this.canGrab && world.grapple.canGrab()) {
      world.grapple.grab(this);
    }
  }
}
