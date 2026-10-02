import * as THREE from 'three';
import { rightOf } from './rig-utils.js';
import { TRAVERSAL_KEYS } from './traversal-keys.js';

/**
 * Keyframed vaults and climbs, still driven through IK. The keys themselves
 * live in traversal-keys.js (as data, so the lab can edit them); this turns
 * them into hip, hand and foot positions for one specific obstacle.
 *
 * Two things keep it from looking robotic:
 *  - every channel is a Catmull-Rom spline through the keys, so the body
 *    flows through a key instead of easing to a stop at each one;
 *  - limbs run slightly out of phase: hands lead, feet trail, and the torso
 *    lean lags the hips (overlapping action).
 */

// How long a move takes and whether both hands go on the ledge.
export function traversalTiming(ledge, feetY) {
  const rise = ledge.top - feetY;
  return ledge.type === 'vault'
    ? { duration: 0.62, bothHands: false }
    : { duration: 0.7 + 0.35 * rise, bothHands: true };
}

// How far ahead (+) or behind (-) each channel runs, as a fraction of the move.
const LEAD = { hands: 0.035, feet: -0.03, lean: -0.025 };
// Hip joint to foot when the leg is all but straight (thigh + shin, minus a
// little, plus the ankle height). A foot can't be further than this from its hip.
const LEG_REACH = 0.9;

const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
const catmull = (v0, v1, v2, v3, t) =>
  0.5 * (2 * v1 + (-v0 + v2) * t + (2 * v0 - 5 * v1 + 4 * v2 - v3) * t * t + (-v0 + 3 * v1 - 3 * v2 + v3) * t * t * t);

export class Traversal {
  /**
   * @param ledge  from findLedge(): { type, top, edge, through, end, dir }
   * @param body   the Humanoid doing it
   * @param keys   key list to use (defaults to the live keys for this type)
   */
  constructor(ledge, body, { duration, bothHands, keys = TRAVERSAL_KEYS[ledge.type] }) {
    this.type = ledge.type;
    this.top = ledge.top;
    this.edge = ledge.edge.clone();
    this.dir = ledge.dir.clone();
    this.yaw = Math.atan2(ledge.dir.x, ledge.dir.z);
    this.right = rightOf(new THREE.Vector3(), this.yaw);
    this.end = ledge.end.clone();
    this.duration = duration;
    this.bothHands = bothHands;
    this.t = 0;
    this.body = body;
    const footStart = body.feet.map((f) => f.pos.clone());

    // Anchor values the keys are measured from.
    const hip = body.params.hipHeight;
    const through = ledge.through ?? 0;
    this.depth = through; // how far the obstacle runs along the travel direction
    const startFeet = body.pos.y;
    const anchorA = { edge: 0, mid: through / 2, far: through, end: this._along(this.end) };
    const hipU = { top: 0, start: startFeet + hip - this.top, land: this.end.y + hip - this.top };
    const footU = { top: 0, start: startFeet - this.top, land: this.end.y - this.top };

    const start = this._toLedge(body.pos.x, body.pos.y + hip, body.pos.z);
    const resolved = [{ t: 0, pelvis: start, pitch: 0, roll: 0, hipYaw: 0, stow: 0, hands: [null, null], feet: ['start', 'start'] }];
    for (const k of keys) {
      const p = k.pelvis;
      resolved.push({
        t: k.t,
        pelvis: [p.a + anchorA[p.aFrom], p.u + hipU[p.uFrom], p.s],
        pitch: k.pitch,
        roll: k.roll,
        hipYaw: k.hipYaw,
        stow: k.stow,
        hands: k.hands.map((h, i) => (h && (i === 0 || bothHands) ? [h.a, h.s, h.u, h.w] : null)),
        feet: k.feet.map((f) => (typeof f === 'string' ? f : [f.a + anchorA[f.aFrom], f.s, f.u + footU[f.uFrom]])),
      });
    }
    resolved.sort((x, y) => x.t - y.t);
    this.keys = resolved;

    // A hand that's off the ledge at a key still needs a position for the
    // spline: borrow the nearest key's hold, with zero grip.
    for (let h = 0; h < 2; h++) {
      const holds = resolved.map((k) => k.hands[h]);
      if (holds.every((x) => !x)) continue;
      resolved.forEach((k, j) => {
        if (k.hands[h]) return;
        let near = null;
        for (let d = 1; !near && d < resolved.length; d++) near = holds[j - d] ?? holds[j + d] ?? null;
        k.hands[h] = [...near.slice(0, 3), 0];
      });
    }

    // Feet as world positions per key (a dangling foot hangs under that key's hips).
    const tmp = new THREE.Vector3();
    this.keyFeet = resolved.map((k) => {
      const pelvisWorld = this.fromLedge(new THREE.Vector3(), k.pelvis[0], k.pelvis[1], k.pelvis[2]);
      return k.feet.map((spec, i) => {
        const side = body.feet[i].side;
        if (spec === 'start') return footStart[i].clone();
        if (spec === 'rest') return this.end.clone().addScaledVector(this.right, side * body.params.footSpread);
        if (spec === 'hang') {
          tmp.copy(pelvisWorld).addScaledVector(this.right, side * 0.1).addScaledVector(this.dir, -0.12);
          tmp.y = Math.max(tmp.y - 0.86, footStart[i].y);
          // While below the top, stay against the outside face, not inside the obstacle.
          if (tmp.y < this.top) {
            const inside = this._along(tmp) + 0.1;
            if (inside > 0) tmp.addScaledVector(this.dir, -inside);
          }
          return tmp.clone();
        }
        return this.fromLedge(new THREE.Vector3(), spec[0], spec[2], spec[1]);
      });
    });

    // Results of the last evaluate(), read by the Humanoid.
    this.pelvis = new THREE.Vector3();
    this.feet = [new THREE.Vector3(), new THREE.Vector3()];
    this.footAir = [0, 0]; // how far each foot is above whatever is under it
    this._hip = new THREE.Vector3();
    this.hands = [
      { pos: new THREE.Vector3(), w: 0 },
      { pos: new THREE.Vector3(), w: 0 },
    ];
    this.pose = { pitch: 0, roll: 0, hipYaw: 0, stow: 0 };
  }

  get progress() {
    return Math.min(this.t / this.duration, 1);
  }

  get done() {
    return this.t >= this.duration;
  }

  _along(p) {
    return (p.x - this.edge.x) * this.dir.x + (p.z - this.edge.z) * this.dir.z;
  }

  // World point -> [a, u, s] in the ledge frame.
  _toLedge(x, y, z) {
    const dx = x - this.edge.x;
    const dz = z - this.edge.z;
    return [dx * this.dir.x + dz * this.dir.z, y - this.top, dx * this.right.x + dz * this.right.z];
  }

  // Ledge frame -> world.
  fromLedge(out, a, u, s) {
    return out.set(
      this.edge.x + this.dir.x * a + this.right.x * s,
      this.top + u,
      this.edge.z + this.dir.z * a + this.right.z * s,
    );
  }

  // Which pair of keys k falls between, the four spline neighbours, and t.
  _span(k) {
    const keys = this.keys;
    const n = keys.length;
    let i = 0;
    while (i < n - 2 && k > keys[i + 1].t) i++;
    const len = keys[i + 1].t - keys[i].t;
    const t = len > 0 ? clamp01((k - keys[i].t) / len) : 1;
    return { i0: Math.max(i - 1, 0), i1: i, i2: i + 1, i3: Math.min(i + 2, n - 1), t };
  }

  // Spline a number pulled out of each key by `get`.
  _spline(k, get) {
    const s = this._span(clamp01(k));
    const keys = this.keys;
    return catmull(get(keys[s.i0], s.i0), get(keys[s.i1], s.i1), get(keys[s.i2], s.i2), get(keys[s.i3], s.i3), s.t);
  }

  // Jump straight to a point in the move (the lab's timeline scrubber).
  seek(k) {
    this.t = clamp01(k) * this.duration;
    return this.evaluate(0);
  }

  evaluate(dt) {
    this.t += dt;
    const k = this.progress;
    const terrain = this.body.constructor.terrain;

    // Hips.
    this.fromLedge(
      this.pelvis,
      this._spline(k, (key) => key.pelvis[0]),
      this._spline(k, (key) => key.pelvis[1]),
      this._spline(k, (key) => key.pelvis[2]),
    );

    // Torso: the lean trails the hips a touch; the rest rides with them.
    const kl = k + LEAD.lean;
    this.pose.pitch = this._spline(kl, (key) => key.pitch);
    this.pose.roll = this._spline(kl, (key) => key.roll);
    this.pose.hipYaw = this._spline(k, (key) => key.hipYaw);
    this.pose.stow = clamp01(this._spline(k, (key) => key.stow));

    // Hands reach ahead of the body.
    const kh = k + LEAD.hands;
    for (let h = 0; h < 2; h++) {
      const out = this.hands[h];
      if (!this.keys[0].hands[h]) {
        out.w = 0;
        continue;
      }
      this.fromLedge(
        out.pos,
        this._spline(kh, (key) => key.hands[h][0]),
        this._spline(kh, (key) => key.hands[h][2]),
        this._spline(kh, (key) => key.hands[h][1]),
      );
      out.w = clamp01(this._spline(kh, (key) => key.hands[h][3]));
    }

    // Feet follow behind, lift clear while travelling, never sink into a surface.
    const kf = clamp01(k + LEAD.feet);
    const span = this._span(kf);
    for (let f = 0; f < 2; f++) {
      const p = (j) => this.keyFeet[j][f];
      const out = this.feet[f];
      for (const axis of ['x', 'y', 'z']) {
        out[axis] = catmull(p(span.i0)[axis], p(span.i1)[axis], p(span.i2)[axis], p(span.i3)[axis], span.t);
      }
      // A slight lift so a foot travelling sideways doesn't scuff along; the
      // keys already lay out the real path, so anything bigger would just
      // throw the foot up toward the hip.
      const a = p(span.i1);
      const b = p(span.i2);
      const flat = Math.hypot(b.x - a.x, b.z - a.z);
      if (flat > 0.15) out.y += Math.sin(Math.PI * span.t) * Math.min(flat * 0.1, 0.05);
      // A foot left behind (still on the ground, say) gets pulled along once
      // the hips rise out of reach, so the leg dangles instead of overstretching.
      this._hip.copy(this.pelvis).addScaledVector(this.right, this.body.feet[f].side * 0.1);
      this._hip.y -= 0.06;
      const fromHip = out.distanceTo(this._hip);
      if (fromHip > LEG_REACH) out.lerp(this._hip, 1 - LEG_REACH / fromHip);
      // Keep a foot from sinking a little way into a surface it's resting on,
      // but never pop it up a long way: a big snap reads as the leg jerking.
      // Paths that cross a lip are routed around it in the keys instead.
      const floor = terrain.heightAt(out.x, out.z, out.y + 0.25);
      if (out.y < floor) out.y = Math.min(floor, out.y + 0.06);
      this.footAir[f] = out.y - floor;
    }
    return k;
  }
}
