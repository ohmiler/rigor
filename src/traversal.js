import * as THREE from 'three';
import { smoothstep, rightOf } from './rig-utils.js';

/**
 * Keyframed vaults and climbs, still driven through IK.
 *
 * Every key is written in a "ledge frame": `a` is distance along the travel
 * direction from the obstacle's near edge (negative = before it), `u` is
 * height relative to the obstacle's top, and `s` is sideways (+ = right).
 * So the same keys fit a barrier, a car or a dumpster of any height.
 *
 * Per key:
 *   pelvis: [a, u, s]          where the hips are
 *   pitch / roll / hipYaw      torso lean and how far the hips turn sideways
 *   stow                       0 = gun aimed, 1 = gun dropped to the side
 *   hands: [L, R]              [a, s, u, weight] on the ledge, or null (no grip)
 *   feet:  [L, R]              [a, s, u], 'start' (where it was), 'hang'
 *                              (dangling under the hip) or 'rest' (standing)
 * Missing fields hold the previous key's value.
 */

function climbKeys(rise, endA, endU, hip) {
  const plant = (w) => [
    [0.05, -0.21, 0.02, w],
    [0.05, 0.21, 0.02, w],
  ];
  return [
    // Settle in against the side, hands up on the edge, gun swung aside.
    { t: 0.16, pelvis: [-0.42, -rise + hip - 0.16, 0], pitch: 0.3, roll: 0, hipYaw: 0, stow: 1, hands: plant(1), feet: ['start', 'start'] },
    // Jump and pull: chest goes over the edge, lead foot finds the top.
    { t: 0.4, pelvis: [-0.3, -0.12, 0], pitch: 0.95, feet: ['hang', [0.04, 0.1, 0]] },
    // Push down through the hands; hips come up over the edge, trailing leg scrapes up the side.
    { t: 0.62, pelvis: [0.06, 0.36, 0], pitch: 0.75, feet: [[-0.1, -0.12, -0.3], [0.14, 0.1, 0]] },
    // Crouched on top, hands letting go.
    { t: 0.8, pelvis: [0.26, 0.6, 0], pitch: 0.35, stow: 0.6, hands: plant(0.5), feet: [[0.24, -0.12, 0], [0.34, 0.12, 0]] },
    // Stand up and bring the gun back.
    { t: 1, pelvis: [endA, endU + hip, 0], pitch: 0, stow: 0, hands: plant(0), feet: ['rest', 'rest'] },
  ];
}

function vaultKeys(rise, through, land, endA, hip) {
  const mid = through * 0.5;
  return [
    // Last step in: left hand plants on top, gun drops a little for clearance.
    { t: 0.22, pelvis: [-0.35, -rise + hip - 0.12, 0], pitch: 0.25, roll: 0.1, hipYaw: 0, stow: 0.5, hands: [[0.08, -0.17, 0.02, 1], null], feet: ['start', 'start'] },
    // Over the top: hips turn, both legs swing past on the right of the hand.
    { t: 0.5, pelvis: [mid, 0.3, 0.1], pitch: 0.2, roll: 0.5, hipYaw: -0.85, feet: [[mid, 0.32, 0.12], [mid + 0.12, 0.44, 0.18]] },
    // Coming down: lead foot reaches for the ground first.
    { t: 0.76, pelvis: [through + 0.25, land + hip - 0.18, 0.05], pitch: 0.15, roll: 0.15, hipYaw: -0.3, hands: [[0.08, -0.17, 0.02, 0.2], null], feet: [[through + 0.12, 0.18, land + 0.22], [through + 0.42, 0.12, land]] },
    // Land and run on.
    { t: 1, pelvis: [endA, land + hip, 0], pitch: 0, roll: 0, hipYaw: 0, stow: 0, hands: [[0.08, -0.17, 0.02, 0], null], feet: ['rest', 'rest'] },
  ];
}

export class Traversal {
  /**
   * @param ledge  from findLedge(): { type, top, edge, through, end, dir }
   * @param body   the Humanoid doing it
   */
  constructor(ledge, body, { duration, bothHands }) {
    this.type = ledge.type;
    this.top = ledge.top;
    this.edge = ledge.edge.clone();
    this.dir = ledge.dir.clone();
    this.right = rightOf(new THREE.Vector3(), Math.atan2(ledge.dir.x, ledge.dir.z));
    this.end = ledge.end.clone();
    this.yaw = Math.atan2(ledge.dir.x, ledge.dir.z);
    this.duration = duration;
    this.bothHands = bothHands;
    this.t = 0;
    this.body = body;
    this.footStart = body.feet.map((f) => f.pos.clone());

    const hip = body.params.hipHeight;
    const start = this.toLedge(body.pos.clone().setY(body.pos.y + hip));
    const rise = this.top - body.pos.y;
    const endA = this.toLedge(this.end)[0];
    const endU = this.end.y - this.top;
    const keys =
      this.type === 'vault'
        ? vaultKeys(rise, ledge.through, endU, endA, hip)
        : climbKeys(rise, endA, endU, hip);
    // Key 0 is wherever the body actually is right now.
    keys.unshift({ t: 0, pelvis: start, pitch: 0, roll: 0, hipYaw: 0, stow: 0, hands: [null, null], feet: ['start', 'start'] });
    if (!bothHands) for (const k of keys) if (k.hands) k.hands = [k.hands[0], null];
    // Fill in held values so every key is complete.
    for (let i = 1; i < keys.length; i++) {
      for (const field of ['pelvis', 'pitch', 'roll', 'hipYaw', 'stow', 'hands', 'feet']) {
        if (keys[i][field] === undefined) keys[i][field] = keys[i - 1][field];
      }
    }
    this.keys = keys;

    // Results of the last evaluate(), read by the Humanoid.
    this.pelvis = new THREE.Vector3();
    this.feet = [new THREE.Vector3(), new THREE.Vector3()];
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

  // World point -> [a, u, s] in the ledge frame.
  toLedge(p) {
    const dx = p.x - this.edge.x;
    const dz = p.z - this.edge.z;
    return [dx * this.dir.x + dz * this.dir.z, p.y - this.top, dx * this.right.x + dz * this.right.z];
  }

  // Ledge frame -> world.
  fromLedge(out, a, u, s) {
    return out.set(
      this.edge.x + this.dir.x * a + this.right.x * s,
      this.top + u,
      this.edge.z + this.dir.z * a + this.right.z * s,
    );
  }

  _segment(k) {
    const keys = this.keys;
    let i = 0;
    while (i < keys.length - 2 && k > keys[i + 1].t) i++;
    const span = keys[i + 1].t - keys[i].t;
    return [i, span > 0 ? THREE.MathUtils.clamp((k - keys[i].t) / span, 0, 1) : 1];
  }

  _footWorld(out, spec, i) {
    const body = this.body;
    if (spec === 'start') return out.copy(this.footStart[i]);
    if (spec === 'rest') {
      const side = body.feet[i].side;
      return out.copy(this.end).addScaledVector(this.right, side * body.params.footSpread);
    }
    if (spec === 'hang') {
      // Dangling under the hip, toes down; never through the floor.
      out.copy(this.pelvis).addScaledVector(this.right, body.feet[i].side * 0.1).addScaledVector(this.dir, -0.12);
      out.y -= 0.86;
      return out.setY(Math.max(out.y, this.footStart[i].y));
    }
    return this.fromLedge(out, spec[0], spec[2], spec[1]);
  }

  evaluate(dt) {
    this.t += dt;
    const k = this.progress;
    const [i, local] = this._segment(k);
    const a = this.keys[i];
    const b = this.keys[i + 1];
    const s = smoothstep(local);

    // Hips: Catmull-Rom through the keys for a continuous, unbroken arc.
    const p0 = this.keys[Math.max(i - 1, 0)].pelvis;
    const p3 = this.keys[Math.min(i + 2, this.keys.length - 1)].pelvis;
    const cr = (j) => {
      const t = local;
      const v0 = p0[j];
      const v1 = a.pelvis[j];
      const v2 = b.pelvis[j];
      const v3 = p3[j];
      return 0.5 * (2 * v1 + (-v0 + v2) * t + (2 * v0 - 5 * v1 + 4 * v2 - v3) * t * t + (-v0 + 3 * v1 - 3 * v2 + v3) * t * t * t);
    };
    this.fromLedge(this.pelvis, cr(0), cr(1), cr(2));

    for (const f of ['pitch', 'roll', 'hipYaw', 'stow']) this.pose[f] = THREE.MathUtils.lerp(a[f], b[f], s);

    for (let h = 0; h < 2; h++) {
      const ha = a.hands[h];
      const hb = b.hands[h];
      const out = this.hands[h];
      if (!ha && !hb) {
        out.w = 0;
        continue;
      }
      const from = ha ?? [...hb.slice(0, 3), 0];
      const to = hb ?? [...ha.slice(0, 3), 0];
      this.fromLedge(
        out.pos,
        THREE.MathUtils.lerp(from[0], to[0], s),
        THREE.MathUtils.lerp(from[2], to[2], s),
        THREE.MathUtils.lerp(from[1], to[1], s),
      );
      out.w = THREE.MathUtils.lerp(from[3], to[3], s);
    }

    const fa = new THREE.Vector3();
    const fb = new THREE.Vector3();
    for (let f = 0; f < 2; f++) {
      this._footWorld(fa, a.feet[f], f);
      this._footWorld(fb, b.feet[f], f);
      this.feet[f].lerpVectors(fa, fb, s);
      // A foot travelling between holds lifts clear instead of sliding.
      const travel = fa.distanceTo(fb);
      if (travel > 0.15) this.feet[f].y += Math.sin(Math.PI * s) * Math.min(travel * 0.3, 0.2);
    }
    return k;
  }
}
