import * as THREE from 'three';
import { Humanoid, FOOT_ANKLE } from './humanoid.js';
import { localPoint, bendFront } from './rig-utils.js';

// A body gone limp: its joints become balls joined by sticks (position-based
// dynamics), falling under gravity, landing on whatever is below, and pushed
// about by anything that walks through them. The same meshes the living body
// used are laid along the sticks every frame, so a body slumps from exactly
// the pose it died in.
//
// It also does three other jobs: a crawler is a ragdoll whose arms are driven
// (crawl), dismember() tears it into pieces for the player's death, and push()
// lets feet kick and tread on corpses.

const GRAVITY = 9.8;
const STEP = 1 / 60;
const ITERATIONS = 8;

// Particle indices.
const PELVIS = 0;
const CHEST = 1;
const HEAD = 2;
const NOSE = 3; // in front of the face: which way the head points
const ARM = [
  { sh: 4, el: 5, wr: 6 },
  { sh: 7, el: 8, wr: 9 },
];
const LEG = [
  { hip: 10, knee: 11, ank: 12, toe: 13 },
  { hip: 14, knee: 15, ank: 16, toe: 17 },
];
const TOP = [CHEST, ARM[0].sh, ARM[1].sh];
const BOTTOM = [PELVIS, LEG[0].hip, LEG[1].hip];
const TORSO = [...TOP, ...BOTTOM];

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _f = new THREE.Vector3();
const _g = new THREE.Vector3();

// Orientation from a rough "left" (local +X) and "up" (local +Y).
function basis(out, left, up) {
  _y.copy(up).normalize();
  _x.copy(left).addScaledVector(_y, -left.dot(_y));
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0).addScaledVector(_y, -_y.x);
  _x.normalize();
  _z.crossVectors(_x, _y);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

// Orientation from a "forward" (local +Z) and a rough "up".
function basisFwd(out, fwd, up) {
  _z.copy(fwd).normalize();
  _y.copy(up).addScaledVector(_z, -up.dot(_z));
  if (_y.lengthSq() < 1e-8) _y.set(0, 1, 0).addScaledVector(_z, -_z.y);
  _y.normalize();
  _x.crossVectors(_y, _z);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

export class Ragdoll {
  constructor(body, { vel = null } = {}) {
    this.body = body;
    this.particles = [];
    this.constraints = [];
    this.accum = 0;
    this.still = 0;
    this.asleep = false;
    this.waistCut = false;
    this.neckCut = false;
    this.hingesOn = { knees: [true, true], elbows: [true, true] };
    // Which particles each limb's meshes run between (a cut gives the torn-off
    // piece its own copy of the joint, so these can change).
    this.map = {
      arms: ARM.map((a) => ({ sh: a.sh, el: a.el, fore: a.el, wr: a.wr })),
      legs: LEG.map((l) => ({ hip: l.hip, knee: l.knee, shin: l.knee, ank: l.ank, toe: l.toe })),
    };
    this.crawlState = null;
    this.crawlDir = null; // the way a crawler faces, turning gradually
    this.poseIn = 0;
    this.drive = null; // { mode: 'crawl' | 'grab' | 'idle', target, reach: [Vector3, Vector3] }

    const P = (pos, r, mass, friction = 6) => {
      this.particles.push({
        pos: pos.clone(),
        pred: pos.clone(),
        vel: vel ? vel.clone().setY(Math.min(vel.y, 0)) : new THREE.Vector3(),
        r,
        w: 1 / mass,
        friction,
        grounded: false,
        pinned: false,
        ground: 0,
      });
    };
    P(body.pelvisPos, 0.13, 3);
    P(body.chestPos, 0.14, 3);
    P(body.headPos, 0.11, 1.4);
    P(localPoint(_a, body.headPos, body.headQuat, 0, 0, 0.1), 0.05, 0.3);
    for (const arm of body.arms) {
      P(arm.shoulder, 0.06, 1);
      P(arm.elbow, 0.045, 0.7);
      P(arm.wrist, 0.045, 0.4);
    }
    for (const leg of body.legs) {
      P(leg.hip, 0.08, 1.5);
      P(leg.knee, 0.06, 1);
      P(leg.ankle, 0.05, 0.6, 8);
      // Toe tip, from the foot's current orientation.
      P(_a.set(0, -0.02, 0.15).applyQuaternion(leg.foot.quaternion).add(leg.foot.position), 0.04, 0.3, 8);
    }

    // The torso's shape in its own frame (left, up, front), around its middle:
    // a crawler's torso is held to this shape in a prone pose (_poseCrawler).
    {
      const p = (i) => this.particles[i].pos;
      const up = new THREE.Vector3().addVectors(p(ARM[0].sh), p(ARM[1].sh)).sub(p(LEG[0].hip)).sub(p(LEG[1].hip)).normalize();
      const left = new THREE.Vector3().subVectors(p(LEG[0].hip), p(LEG[1].hip));
      left.addScaledVector(up, -left.dot(up)).normalize();
      const front = new THREE.Vector3().crossVectors(left, up);
      const mid = new THREE.Vector3();
      for (const i of TORSO) mid.add(p(i));
      mid.divideScalar(TORSO.length);
      this.neckLength = p(CHEST).distanceTo(p(HEAD));
      this.torsoShape = TORSO.map((i) => {
        const o = new THREE.Vector3().subVectors(p(i), mid);
        return [o.dot(left), o.dot(up), o.dot(front)];
      });
    }

    const link = (a, b, { min = false, stiff = 1, rest = undefined } = {}) =>
      this.constraints.push({ a, b, rest: rest ?? this.particles[a].pos.distanceTo(this.particles[b].pos), min, stiff });
    // The torso is one rigid block: every pair of its six points is held.
    const torso = [...TOP, ...BOTTOM];
    for (let i = 0; i < torso.length; i++) for (let j = i + 1; j < torso.length; j++) link(torso[i], torso[j]);
    link(CHEST, HEAD);
    link(HEAD, NOSE);
    link(CHEST, NOSE, { stiff: 0.4 }); // the head can loll, but it stays facing roughly forward
    link(ARM[0].sh, HEAD, { min: true });
    link(ARM[1].sh, HEAD, { min: true });
    for (const a of ARM) {
      link(a.sh, a.el);
      link(a.el, a.wr);
      link(a.sh, a.wr, { min: true, rest: 0.14 });
    }
    for (const l of LEG) {
      link(l.hip, l.knee);
      link(l.knee, l.ank);
      link(l.ank, l.toe);
      link(l.knee, l.toe); // holds the foot at its angle to the shin
      link(l.hip, l.ank, { min: true, rest: 0.3 });
    }
  }

  // ------------------------------------------------------------ forces

  // A kick to every particle (whole body), or to those near a height.
  impulse(v, { height = null, spread = 0.4 } = {}) {
    this.asleep = false;
    for (const p of this.particles) {
      let k = 1;
      if (height !== null) {
        const dy = p.pos.y - height;
        k = Math.exp(-(dy * dy) / (spread * spread));
      }
      p.vel.addScaledVector(v, k);
    }
  }

  nudge(index, v) {
    this.asleep = false;
    this.particles[index].vel.add(v);
  }

  /**
   * Something solid passing through: a foot, a shin. Balls inside `radius`
   * of `point` are shoved out and pick up some of its velocity.
   */
  push(point, radius, vel) {
    let hit = false;
    for (const p of this.particles) {
      _a.subVectors(p.pos, point);
      const min = radius + p.r;
      const d2 = _a.lengthSq();
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2);
      if (d > 1e-5) _a.divideScalar(d);
      else _a.set(0, 1, 0);
      // Mostly sideways: a body on the road can't go down.
      _a.y *= 0.3;
      _a.normalize();
      // A nudge and a roll, not a bulldozer: a foot treading through a body
      // shifts the limb it lands on a little and lets the rest settle.
      const depth = min - d;
      p.pos.addScaledVector(_a, depth * 0.25);
      p.vel.addScaledVector(vel, 0.06).addScaledVector(_a, depth * 2.5);
      const hv = Math.hypot(p.vel.x, p.vel.z);
      if (hv > 1.2) {
        p.vel.x *= 1.2 / hv;
        p.vel.z *= 1.2 / hv;
      }
      hit = true;
    }
    if (hit) this.asleep = false;
    return hit;
  }

  // ------------------------------------------------------------ simulation

  update(dt) {
    if (dt <= 0) return;
    if (this.asleep && !this.drive) return;
    this.accum = Math.min(this.accum + dt, STEP * 4);
    while (this.accum >= STEP) {
      this.accum -= STEP;
      this._step(STEP);
    }
  }

  _step(h) {
    const terrain = Humanoid.terrain;
    // How far into holding the crawl pose (eases in over half a second).
    this.poseIn = this.drive && this.drive.mode !== 'idle' ? Math.min((this.poseIn ?? 0) + h * 2, 1) : 0;
    if (this.drive) this._drive(h);

    for (const p of this.particles) {
      if (p.pinned) {
        p.pred.copy(p.pos);
        continue;
      }
      p.vel.y -= GRAVITY * h;
      p.vel.multiplyScalar(1 - 0.3 * h);
      p.pred.copy(p.pos).addScaledVector(p.vel, h);
      // The ground under each ball, looked up once per step.
      p.ground = terrain.heightAt(p.pred.x, p.pred.z, p.pred.y + 0.25);
      p.grounded = false;
    }

    for (let it = 0; it < ITERATIONS; it++) {
      for (const c of this.constraints) this._solve(c);
      this._hinges();
      if (this.drive && this.drive.mode !== 'idle') this._poseCrawler();
      else this.poseIn = 0;
      for (const p of this.particles) {
        if (p.pinned) continue;
        if (p.pred.y - p.r < p.ground) {
          p.pred.y = p.ground + p.r;
          p.grounded = true;
        }
      }
    }

    let fastest = 0;
    for (const p of this.particles) {
      if (p.pinned) {
        p.vel.set(0, 0, 0);
        continue;
      }
      // Walls, kerbs, the sides of cars: anything taller than a step.
      terrain.collide?.(p.pred, p.r, p.pred.y - p.r, 0.2);
      p.vel.subVectors(p.pred, p.pos).divideScalar(h);
      if (p.grounded) {
        // Friction: sliding on the road stops quickly.
        const k = Math.max(1 - p.friction * h, 0);
        p.vel.x *= k;
        p.vel.z *= k;
        if (p.vel.y < 0) p.vel.y = 0;
      }
      p.pos.copy(p.pred);
      fastest = Math.max(fastest, p.vel.lengthSq());
    }
    // A crawler drags itself; it never glides faster than its hauling pace.
    if (this.drive?.mode === 'crawl') {
      const cap = this.drive.speed * 1.3;
      for (const i of [...TORSO, HEAD, NOSE]) {
        const v = this.particles[i].vel;
        const hv = Math.hypot(v.x, v.z);
        if (hv > cap) {
          v.x *= cap / hv;
          v.z *= cap / hv;
        }
      }
    }
    // Lying still for a moment: stop simulating until something disturbs it.
    this.still = fastest < 0.0025 ? this.still + h : 0;
    if (this.still > 1 && !this.drive) this.asleep = true;
  }

  _solve(c) {
    const pa = this.particles[c.a];
    const pb = this.particles[c.b];
    _a.subVectors(pb.pred, pa.pred);
    const len = _a.length();
    if (len < 1e-6 || (c.min && len >= c.rest)) return;
    const wa = pa.pinned ? 0 : pa.w;
    const wb = pb.pinned ? 0 : pb.w;
    const wsum = wa + wb;
    if (wsum === 0) return;
    const diff = ((len - c.rest) / len) * c.stiff;
    pa.pred.addScaledVector(_a, (diff * wa) / wsum);
    pb.pred.addScaledVector(_a, (-diff * wb) / wsum);
  }

  // Knees only bend forward and elbows only back, measured against the torso.
  _hinges() {
    const P = this.particles;
    _a.addVectors(P[ARM[0].sh].pred, P[ARM[1].sh].pred).multiplyScalar(0.5);
    _b.addVectors(P[LEG[0].hip].pred, P[LEG[1].hip].pred).multiplyScalar(0.5);
    _c.subVectors(_a, _b).normalize(); // torso up
    _d.subVectors(P[LEG[0].hip].pred, P[LEG[1].hip].pred).normalize(); // torso left
    const fwd = _d.cross(_c); // left x up = forward
    const hinge = (root, mid, end, sign, min) => {
      _a.addVectors(P[root].pred, P[end].pred).multiplyScalar(0.5);
      _b.subVectors(P[mid].pred, _a);
      const s = _b.dot(fwd) * sign;
      if (s >= min) return;
      const fix = (min - s) * sign;
      P[mid].pred.addScaledVector(fwd, fix * 0.7);
      P[root].pred.addScaledVector(fwd, -fix * 0.15);
      P[end].pred.addScaledVector(fwd, -fix * 0.15);
    };
    LEG.forEach((l, i) => this.hingesOn.knees[i] && hinge(l.hip, l.knee, l.ank, 1, 0.03));
    ARM.forEach((a, i) => this.hingesOn.elbows[i] && hinge(a.sh, a.el, a.wr, -1, 0));
  }

  // ------------------------------------------------------------ crawling

  /**
   * A crawler pulls itself along by its arms: one hand reaches ahead and
   * plants, the body is dragged up to it, then the other hand. The legs are
   * just along for the ride. In 'grab' mode both hands clutch at `reach`.
   */
  _drive(h) {
    const d = this.drive;
    const P = this.particles;
    const chest = P[CHEST];
    const st = (this.crawlState ??= { hand: 0, phase: 'pull', t: 0, from: new THREE.Vector3(), to: new THREE.Vector3() });

    // The torso slides when hauled; the legs drag. (Its pose: _poseCrawler.)
    for (const i of [PELVIS, CHEST, ...TOP, ...BOTTOM]) P[i].friction = d.mode === 'idle' ? 6 : 2.5;

    _a.subVectors(d.target, chest.pos).setY(0);
    const dist = _a.length();
    const dir = dist > 1e-4 ? _a.divideScalar(dist) : _a.set(0, 0, 1);
    // The way it faces turns toward the target gradually, not in a snap.
    this.crawlDir ??= dir.clone();
    this.crawlDir.lerp(dir, 1 - Math.exp(-3 * h)).setY(0).normalize();

    if (d.mode === 'grab') {
      for (let i = 0; i < 2; i++) {
        const wr = P[this.map.arms[i].wr];
        const sh = P[ARM[i].sh];
        // Clutch at the target, but no further than an arm's length.
        _b.subVectors(d.reach[i], sh.pos);
        if (_b.length() > 0.5) _b.setLength(0.5);
        wr.pinned = true;
        wr.pos.lerp(_c.addVectors(sh.pos, _b), 1 - Math.exp(-12 * h));
      }
      if (dist > 0.45) chest.vel.addScaledVector(dir, 2 * h);
      return;
    }
    if (d.mode === 'idle') {
      for (const a of this.map.arms) P[a.wr].pinned = false;
      st.phase = 'pull';
      return;
    }

    const i = st.hand;
    const wr = P[this.map.arms[i].wr];
    st.t += h;
    if (st.phase === 'reach') {
      // Lift the hand over the ground to the next hold.
      const k = Math.min(st.t / 0.45, 1);
      const s = k * k * (3 - 2 * k);
      wr.pinned = true;
      wr.pos.lerpVectors(st.from, st.to, s);
      wr.pos.y += Math.sin(Math.PI * k) * 0.14;
      if (k >= 1) {
        st.phase = 'pull';
        st.t = 0;
        d.onPlant?.(wr.pos);
      }
    } else {
      // Haul the body up to the planted hand (a hand that isn't planted yet,
      // at the start, goes straight to reaching).
      const hv = Math.hypot(chest.vel.x, chest.vel.z);
      if (hv < d.speed) {
        chest.vel.addScaledVector(dir, 4.5 * h);
        P[PELVIS].vel.addScaledVector(dir, 2.5 * h);
      }
      _b.subVectors(chest.pos, wr.pos).setY(0);
      if (st.t > 0.6 || _b.dot(dir) > -0.05 || !wr.pinned) {
        // Let go and reach out with the other hand.
        wr.pinned = false;
        st.hand = 1 - i;
        const next = P[this.map.arms[st.hand].wr];
        const sh = P[ARM[st.hand].sh];
        const side = st.hand === 0 ? 1 : -1; // left hand on the left
        _c.crossVectors(WORLD_UP, dir); // to the left of the way it's going
        st.from.copy(next.pos);
        st.to.copy(sh.pos).addScaledVector(dir, 0.48).addScaledVector(_c, side * 0.1);
        st.to.y = Humanoid.terrain.heightAt(st.to.x, st.to.z, st.to.y + 0.3) + 0.045;
        st.phase = 'reach';
        st.t = 0;
      }
    }
  }

  /**
   * A crawler isn't a free ragdoll: it holds itself in a pose and drags
   * itself along. Each solver pass pulls (softly) the torso toward its own
   * shape lying face down, shoulders a little higher than the hips (propped
   * on its arms), facing the way it's crawling; the head up looking ahead;
   * the legs trailing out behind, not folding or crossing. The torso keeps
   * wherever the hands have hauled it: only its turn and height are steered.
   */
  _poseCrawler() {
    const P = this.particles;
    const fwd = this.crawlDir ?? _a.set(0, 0, 1);
    // The prone frame: up (hips to shoulders) along the crawl, tilted up a
    // little; left to the left of it; front (the chest) facing the road.
    const up = _x.copy(fwd).multiplyScalar(Math.cos(0.32)).addScaledVector(WORLD_UP, Math.sin(0.32)).normalize();
    const left = _y.crossVectors(WORLD_UP, fwd).normalize();
    const front = _z.crossVectors(left, up);
    const mid = _b.set(0, 0, 0);
    for (const i of TORSO) mid.add(P[i].pred);
    mid.divideScalar(TORSO.length);
    const k = 0.18 * this.poseIn;
    TORSO.forEach((i, n) => {
      const [l, u, f] = this.torsoShape[n];
      _c.copy(mid).addScaledVector(left, l).addScaledVector(up, u).addScaledVector(front, f);
      P[i].pred.lerp(_c, k);
    });
    // Head up and looking ahead (at the neck's own length from the chest, so
    // it doesn't fight the neck and shove the body back); nose in front of it.
    const chest = P[CHEST].pred;
    _c.copy(up).addScaledVector(front, -0.3).normalize();
    _c.multiplyScalar(this.neckLength).add(chest);
    P[HEAD].pred.lerp(_c, this.poseIn * 0.15);
    _c.copy(P[HEAD].pred).addScaledVector(fwd, 0.1).addScaledVector(front, 0.02);
    P[NOSE].pred.lerp(_c, this.poseIn * 0.15);
    // The shot-out legs are dead weight: they trail out straight behind along
    // the body, a little apart, knees and toes on the road.
    const lk = 0.1 * this.poseIn;
    LEG.forEach((l, n) => {
      const hip = P[l.hip].pred;
      const splay = n === 0 ? 1 : -1; // left leg to the left
      _c.copy(hip).addScaledVector(fwd, -0.45).addScaledVector(left, splay * 0.06);
      _c.y = P[l.knee].ground + 0.06;
      P[l.knee].pred.lerp(_c, lk);
      _c.copy(hip).addScaledVector(fwd, -0.88).addScaledVector(left, splay * 0.12);
      _c.y = P[l.ank].ground + 0.06;
      P[l.ank].pred.lerp(_c, lk);
    });
  }

  // ------------------------------------------------------------ tearing apart

  // Give the piece holding `child` particles its own copy of joint `orig`.
  _detach(orig, children) {
    const src = this.particles[orig];
    const n = this.particles.length;
    this.particles.push({ ...src, pos: src.pos.clone(), pred: src.pred.clone(), vel: src.vel.clone(), w: src.w * 1.5 });
    for (const c of this.constraints) {
      if (c.a === orig && children.includes(c.b)) c.a = n;
      if (c.b === orig && children.includes(c.a)) c.b = n;
    }
    return n;
  }

  _cut(groupA, groupB) {
    this.constraints = this.constraints.filter(
      (c) => !((groupA.includes(c.a) && groupB.includes(c.b)) || (groupA.includes(c.b) && groupB.includes(c.a))),
    );
  }

  /**
   * Tear the body to pieces: head, chest, hips, both arms (sometimes split at
   * the elbow) and both legs (sometimes split at the knee). Returns the wounds:
   * [{ index, from }] where `index` is the torn end and `from` the particle
   * it points away from (for the direction blood sprays).
   */
  dismember({ elbows = [false, false], knees = [false, false] } = {}) {
    this.asleep = false;
    const wounds = [];
    this._cut([HEAD, NOSE], [CHEST, ...TOP, ...BOTTOM]);
    this.neckCut = true;
    wounds.push({ index: HEAD, from: NOSE }, { index: CHEST, from: PELVIS });
    this._cut(TOP, BOTTOM);
    this.waistCut = true;
    wounds.push({ index: PELVIS, from: CHEST });
    ARM.forEach((a, i) => {
      const sh = this._detach(a.sh, [a.el, a.wr]);
      this.map.arms[i].sh = sh;
      this.hingesOn.elbows[i] = false;
      wounds.push({ index: sh, from: a.el });
      if (elbows[i]) {
        const el = this._detach(a.el, [a.wr]);
        this.map.arms[i].fore = el;
        wounds.push({ index: el, from: a.wr });
      }
    });
    LEG.forEach((l, i) => {
      const hip = this._detach(l.hip, [l.knee, l.ank, l.toe]);
      this.map.legs[i].hip = hip;
      this.hingesOn.knees[i] = false;
      wounds.push({ index: hip, from: l.knee });
      if (knees[i]) {
        const knee = this._detach(l.knee, [l.ank, l.toe]);
        this.map.legs[i].shin = knee;
        wounds.push({ index: knee, from: l.ank });
      }
    });
    return wounds;
  }

  // Piece-by-piece blast: each torn piece flies off on its own heading.
  scatter(center, pulls, strength) {
    this.asleep = false;
    const pieces = this._pieces();
    for (const piece of pieces) {
      _a.set(0, 0, 0);
      for (const i of piece) _a.add(this.particles[i].pos);
      _a.divideScalar(piece.length);
      // Away from the middle of the body, toward whichever zombie pulled hardest that way.
      _b.subVectors(_a, center).setY(0);
      if (_b.lengthSq() < 1e-4) _b.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      _b.normalize();
      let best = null;
      let bestDot = -2;
      for (const p of pulls) {
        const dt = p.dot(_b);
        if (dt > bestDot) {
          bestDot = dt;
          best = p;
        }
      }
      if (best) _b.lerp(best, 0.5).normalize();
      const speed = strength * (0.5 + Math.random() * 0.6);
      _b.multiplyScalar(speed).setY(strength * (0.35 + Math.random() * 0.4));
      // A little spin: one end of the piece gets more than the other.
      _c.set(Math.random() - 0.5, Math.random() * 0.5, Math.random() - 0.5).multiplyScalar(strength * 0.6);
      piece.forEach((i, k) => {
        const v = this.particles[i].vel.add(_b);
        if (k % 2) v.add(_c);
        else v.sub(_c);
      });
    }
  }

  // Groups of particles still joined to each other.
  _pieces() {
    const n = this.particles.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (const c of this.constraints) if (!c.min) parent[find(c.a)] = find(c.b);
    const groups = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(i);
    }
    return [...groups.values()];
  }

  // A sphere test against the body (crawlers are shot through this).
  raycast(origin, dir) {
    let best = null;
    this.particles.forEach((p, i) => {
      if (i === NOSE) return;
      const r = i === CHEST || i === PELVIS ? 0.2 : i === HEAD ? 0.13 : 0.1;
      _a.subVectors(p.pos, origin);
      const t = _a.dot(dir);
      if (t < 0) return;
      const d2 = _a.lengthSq() - t * t;
      if (d2 > r * r) return;
      const dist = t - Math.sqrt(r * r - d2);
      if (!best || dist < best.distance) best = { distance: dist, headshot: i === HEAD, leg: false };
    });
    return best;
  }

  // ------------------------------------------------------------ drawing

  get pelvis() {
    return this.particles[PELVIS].pos;
  }
  get chest() {
    return this.particles[CHEST].pos;
  }
  get head() {
    return this.particles[HEAD].pos;
  }
  wrist(i) {
    return this.particles[this.map.arms[i].wr].pos;
  }
  particle(i) {
    return this.particles[i].pos;
  }

  // Lay the body's meshes along the particles.
  apply() {
    const b = this.body;
    const P = (i) => this.particles[i].pos;
    const midSh = _a.addVectors(P(ARM[0].sh), P(ARM[1].sh)).multiplyScalar(0.5);
    const midHip = _b.addVectors(P(LEG[0].hip), P(LEG[1].hip)).multiplyScalar(0.5);

    // Pelvis and chest: up along the spine (or, torn apart, each piece on its own).
    basis(b.pelvisQuat, _c.subVectors(P(LEG[0].hip), P(LEG[1].hip)), this.waistCut ? _d.subVectors(P(PELVIS), midHip) : _d.subVectors(P(CHEST), P(PELVIS)));
    basis(b.chestQuat, _c.subVectors(P(ARM[0].sh), P(ARM[1].sh)), this.waistCut ? _d.subVectors(midSh, P(CHEST)) : _d.subVectors(P(CHEST), P(PELVIS)));
    b.pelvisPos.copy(P(PELVIS));
    b.chestPos.copy(P(CHEST));
    b.pelvis.position.copy(b.pelvisPos);
    b.pelvis.quaternion.copy(b.pelvisQuat);
    b.chest.position.copy(b.chestPos);
    b.chest.quaternion.copy(b.chestQuat);

    // Head: facing its nose, upright against the neck while it has one.
    basisFwd(b.headQuat, _c.subVectors(P(NOSE), P(HEAD)), this.neckCut ? WORLD_UP : _d.subVectors(P(HEAD), P(CHEST)));
    b.headPos.copy(P(HEAD));
    b.head.position.copy(b.headPos);
    b.head.quaternion.copy(b.headQuat);

    if (this.waistCut) {
      // The belly stays with the chest, a torn stump.
      localPoint(b.abdomen.position, b.chestPos, b.chestQuat, 0, -0.2, 0);
      b.abdomen.quaternion.copy(b.chestQuat);
      b.abdomen.scale.y = 0.14;
    } else {
      localPoint(_c, b.pelvisPos, b.pelvisQuat, 0, 0.07, 0);
      localPoint(_d, b.chestPos, b.chestQuat, 0, -0.13, 0);
      b.abdomen.position.lerpVectors(_c, _d, 0.5);
      b.abdomen.quaternion.slerpQuaternions(b.pelvisQuat, b.chestQuat, 0.5);
      b.abdomen.scale.y = Math.max(_c.distanceTo(_d), 0.01);
    }
    if (this.neckCut) {
      b.neck.place(localPoint(_c, b.chestPos, b.chestQuat, 0, 0.15, 0), localPoint(_d, b.chestPos, b.chestQuat, 0, 0.21, 0), _g.set(0, 0, 1).applyQuaternion(b.chestQuat));
    } else {
      b.neck.place(localPoint(_c, b.chestPos, b.chestQuat, 0, 0.15, 0), localPoint(_d, b.headPos, b.headQuat, 0, -0.08, 0), _g.set(0, 0, 1).applyQuaternion(b.chestQuat));
    }

    b.arms.forEach((arm, i) => {
      const m = this.map.arms[i];
      arm.shoulder.copy(P(ARM[i].sh));
      arm.elbow.copy(P(m.el));
      arm.wrist.copy(P(m.wr));
      arm.shoulderMesh.position.copy(arm.shoulder);
      bendFront(_f, P(m.sh), P(m.el), P(m.wr), _g.set(0, 0, -1).applyQuaternion(b.chestQuat)).negate();
      if (!arm.lostUpper) arm.upper.place(P(m.sh), P(m.el), _f);
      if (arm.lostFore) return; // shot off earlier
      arm.fore.place(P(m.fore), P(m.wr), _f);
      _c.subVectors(P(m.wr), P(m.fore)).normalize();
      arm.hand.quaternion.setFromUnitVectors(Z_AXIS, _c);
      arm.hand.position.copy(P(m.wr));
    });

    b.legs.forEach((leg, i) => {
      const m = this.map.legs[i];
      leg.hip.copy(P(m.hip));
      leg.knee.copy(P(m.knee));
      leg.ankle.copy(P(m.ank));
      bendFront(_f, P(m.hip), P(m.knee), P(m.ank), _g.subVectors(P(m.toe), P(m.ank)));
      leg.thigh.place(P(m.hip), P(m.knee), _f);
      leg.shin.place(P(m.shin), P(m.ank), _f);
      basisFwd(_q, _c.subVectors(P(m.toe), P(m.ank)), _d.subVectors(P(m.shin), P(m.ank)));
      leg.foot.quaternion.copy(_q);
      leg.foot.position.copy(P(m.ank)).sub(_c.copy(FOOT_ANKLE).applyQuaternion(_q));
      leg.toe.rotation.x = 0;
    });
  }
}

export const RAGDOLL = { PELVIS, CHEST, HEAD, NOSE, ARM, LEG };
