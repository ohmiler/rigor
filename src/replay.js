import * as THREE from 'three';

// Replays: a run is its seed plus what the player did on every simulation
// step. The game steps at a fixed rate and all of its dice come from one
// seeded generator, so feeding the same seed and inputs back plays the run
// out again exactly: the same zombies in the same places, every shot landing
// where it did. Seeds also pin down the street a run gets (one seed, one
// street) once streets are random.
//
// The file stores input only when it changes (held keys and the aim point
// are the same for many steps in a row), plus one-off commands (reload,
// switch weapon, throw...) on the step they happened, and a fingerprint of
// the world every second so a replay that drifts says where.

export const REPLAY_VERSION = 8; // 2: the street itself is seeded; 3: whole-storey buildings; 4: the AI Director; 5: hordes; 6: car alarms; 7: Yaowarat stalls; 8: the gate and the helicopter finale

// A small, fast, seedable generator (good enough for dice, not for secrets).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const newSeed = () => (Math.random() * 2 ** 32) >>> 0;

// Aim points are kept to the centimetre, live as in the file, so what's
// played and what's saved are the same numbers.
export const round = (v) => Math.round(v * 100) / 100;

const FLAGS = ['walk', 'sprint', 'fire', 'jump'];

function pack(input) {
  let flags = 0;
  FLAGS.forEach((f, i) => input[f] && (flags |= 1 << i));
  const a = input.aimPoint;
  return a ? [input.x, input.z, flags, a.x, a.y, a.z] : [input.x, input.z, flags];
}

function same(a, b) {
  if (!b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class Recorder {
  /** @param {number} seed @param {object} [settings] the levers in force */
  constructor(seed, settings = {}) {
    this.seed = seed;
    this.settings = settings;
    this.step = 0;
    this.dts = []; // [step, dt] whenever the step length changes (slow motion)
    this.inputs = []; // [step, x, z, flags, aimX?, aimY?, aimZ?] on change
    this.cmds = []; // [step, name, ...args]
    this.checks = []; // [step, fingerprint]
    this._dt = null;
    this._in = null;
  }

  /** One simulation step: its length, the input, and any commands. */
  record(dt, input, cmds) {
    if (dt !== this._dt) this.dts.push([this.step, (this._dt = dt)]);
    const p = pack(input);
    if (!same(p, this._in)) this.inputs.push([this.step, ...(this._in = p)]);
    for (const c of cmds) this.cmds.push([this.step, ...c]);
    this.step++;
  }

  check(fingerprint) {
    this.checks.push([this.step, fingerprint]);
  }

  toJSON() {
    return {
      game: 'rigor',
      version: REPLAY_VERSION,
      seed: this.seed,
      steps: this.step,
      settings: this.settings,
      dts: this.dts,
      inputs: this.inputs,
      cmds: this.cmds,
      checks: this.checks,
    };
  }
}

export class Playback {
  /** @param {ReturnType<Recorder['toJSON']>} data */
  constructor(data) {
    if (data?.game !== 'rigor' || !Array.isArray(data.inputs)) throw new Error('Not a RIGOR replay');
    if (data.version !== REPLAY_VERSION) throw new Error(`Replay version ${data.version}; this build plays ${REPLAY_VERSION}`);
    this.data = data;
    this.seed = data.seed;
    this.step = 0;
    this.input = { x: 0, z: 0, walk: false, sprint: false, fire: false, jump: false, aimPoint: null };
    this._aim = new THREE.Vector3();
    this.dt = 1 / 120;
    this._i = { dts: 0, inputs: 0, cmds: 0, checks: 0 };
    this.desync = null; // the step where the world stopped matching, if it did
  }

  get done() {
    return this.step >= this.data.steps;
  }

  get progress() {
    return this.data.steps ? this.step / this.data.steps : 1;
  }

  /** The next step's length, input and commands. */
  next() {
    const d = this.data;
    const i = this._i;
    while (i.dts < d.dts.length && d.dts[i.dts][0] <= this.step) this.dt = d.dts[i.dts++][1];
    while (i.inputs < d.inputs.length && d.inputs[i.inputs][0] <= this.step) {
      const [, x, z, flags, ax, ay, az] = d.inputs[i.inputs++];
      const inp = this.input;
      inp.x = x;
      inp.z = z;
      FLAGS.forEach((f, k) => (inp[f] = !!(flags & (1 << k))));
      inp.aimPoint = ax === undefined ? null : this._aim.set(ax, ay, az);
    }
    const cmds = [];
    while (i.cmds < d.cmds.length && d.cmds[i.cmds][0] <= this.step) cmds.push(d.cmds[i.cmds++].slice(1));
    this.step++;
    return { dt: this.dt, input: this.input, cmds };
  }

  /** Compare the world with the recording's fingerprint for this step. */
  verify(fingerprint) {
    const d = this.data;
    const i = this._i;
    while (i.checks < d.checks.length && d.checks[i.checks][0] < this.step) i.checks++;
    const c = d.checks[i.checks];
    if (c && c[0] === this.step && c[1] !== fingerprint && this.desync === null) this.desync = this.step;
  }
}

// A short, stable fingerprint of numbers (positions, health...).
export function fingerprint(values) {
  let h = 2166136261;
  for (const v of values) {
    const n = Math.round(v * 1000);
    h = Math.imul(h ^ (n & 0xffff), 16777619);
    h = Math.imul(h ^ (n >>> 16), 16777619);
  }
  return (h >>> 0).toString(36);
}
