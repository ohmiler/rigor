import * as THREE from 'three';
import { smoothstep, rightOf } from './rig-utils.js';
import { TRAVERSAL_KEYS } from './traversal-keys.js';

/**
 * Keyframed vaults and climbs, still driven through IK. The keys themselves
 * live in traversal-keys.js (as data, so the lab can edit them); this turns
 * them into hip, hand and foot positions for one specific obstacle.
 */

// How long a move takes and whether both hands go on the ledge.
export function traversalTiming(ledge, feetY) {
  const rise = ledge.top - feetY;
  return ledge.type === 'vault'
    ? { duration: 0.62, bothHands: false }
    : { duration: 0.85 + 0.4 * rise, bothHands: true };
}

const lerp = THREE.MathUtils.lerp;

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
    this.footStart = body.feet.map((f) => f.pos.clone());

    // Anchor values the keys are measured from.
    const hip = body.params.hipHeight;
    const through = ledge.through ?? 0;
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
      return out.copy(this.end).addScaledVector(this.right, body.feet[i].side * body.params.footSpread);
    }
    if (spec === 'hang') {
      // Dangling under the hip; never through the floor.
      out.copy(this.pelvis).addScaledVector(this.right, body.feet[i].side * 0.1).addScaledVector(this.dir, -0.12);
      out.y -= 0.86;
      return out.setY(Math.max(out.y, this.footStart[i].y));
    }
    return this.fromLedge(out, spec[0], spec[2], spec[1]);
  }

  // Jump straight to a point in the move (the lab's timeline scrubber).
  seek(k) {
    this.t = THREE.MathUtils.clamp(k, 0, 1) * this.duration;
    return this.evaluate(0);
  }

  evaluate(dt) {
    this.t += dt;
    const k = this.progress;
    const [i, local] = this._segment(k);
    const a = this.keys[i];
    const b = this.keys[i + 1];
    const s = smoothstep(local);

    // Hips: Catmull-Rom through the keys for a continuous arc.
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

    for (const f of ['pitch', 'roll', 'hipYaw', 'stow']) this.pose[f] = lerp(a[f], b[f], s);

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
      this.fromLedge(out.pos, lerp(from[0], to[0], s), lerp(from[2], to[2], s), lerp(from[1], to[1], s));
      out.w = lerp(from[3], to[3], s);
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
