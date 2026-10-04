// The AI Director: it paces the night. It keeps a measure of how hard the
// player is having it (intensity: bites, blows, being held, things clawing
// close, kills at arm's length) and runs a loop on it, as Left 4 Dead does:
//
//   build  mobs keep coming, sooner when it's been quiet too long, and
//          now and then a horde: a howl down the street, then dozens of
//          runners all at once from one way,
//   peak   intensity tops out: nothing new for a few seconds,
//   relax  nothing at all until the player has caught their breath,
//
// then builds again. Everything it sends spawns out of sight, up the street
// past what the camera and fog show, or behind the player, and comes running.
// Its dice are the run's (Math.random is the seeded one in a step), so a
// replay gets the same night.

// What the player can see of the street, along it from where they stand: the
// camera looks up the street from behind, and the fog closes in past that.
// (A long way zoomed out shows a bit more; spawns keep clear of the default.)
export const VIEW = { ahead: 24, behind: 12 };

export const DIRECTOR = {
  startCalm: 10, // seconds of quiet at the start of a run
  peak: 0.75, // intensity that ends a build-up
  peakHold: 4, // seconds at the peak with nothing new sent
  relaxMin: 15, // a relax lasts this long at least...
  relaxMax: 25, // ...rolled up to this...
  relaxExit: 0.3, // ...and until intensity is down to here
  relaxCap: 45, // never longer than this, whatever is still about
  buildMax: 50, // a build-up the player shrugs off still ends, and they get a breather
  mobEvery: [7, 14], // seconds between mobs in a build-up
  quietAfter: 10, // seconds without a fight that count as "too quiet": mobs come twice as fast
  mobSize: [4, 8],
  runnerShare: 0.4, // a mob is runners as much as anything
  alive: 30, // most zombies up within `aliveRange` of the player (the street's own included)
  aliveRange: 45,
  aliveMax: 60, // and on the whole street
  // Where mobs come from: past the view up the street, or behind.
  ahead: [VIEW.ahead + 2, VIEW.ahead + 12],
  behind: [VIEW.behind + 1, VIEW.behind + 8],
  aheadShare: 0.7,
  despawnBehind: 30, // well behind and out of sight: gone, to make room
  // Hordes: counted in seconds of build-up, so one never lands on a breather.
  hordeFirst: [40, 70],
  hordeEvery: [80, 120],
  hordeWarn: 5, // seconds of warning (the howl) before they come
  hordeSize: [20, 40], // the street's start to its end (and a few either way)
  hordeAhead: 0.6, // from up the street; the rest come from behind
  hordeRunners: 0.85,
  // Intensity
  hurt: 1 / 60, // per point of health lost
  held: 0.25, // per second in a zombie's grip
  close: 0.05, // per second, per zombie chasing within `closeRange`
  closeRange: 5,
  kill: 0.04, // per kill within `killRange`
  killRange: 10,
  calmRange: 8, // nothing chasing this close for `decayDelay` seconds...
  decayDelay: 3,
  decay: 0.1, // ...and intensity drains at this per second
};

/** @param {number[]} range [low, high] */
const roll = ([a, b]) => a + Math.random() * (b - a);

export function inView(playerPos, x, z) {
  const dz = z - playerPos.z;
  return dz > -VIEW.behind && dz < VIEW.ahead;
}

export class Director {
  /**
   * @param {{ minZ: number, maxZ: number, edge: number }} street where spawns may go
   * @param {Partial<typeof DIRECTOR>} [tuning]
   */
  constructor(street, tuning = {}) {
    this.street = street;
    this.t = { ...DIRECTOR, ...tuning };
    this.intensity = 0;
    this.phase = 'relax';
    this.phaseTime = 0;
    this.relaxFor = this.t.startCalm;
    this.mobTimer = roll(this.t.mobEvery);
    this.calmTime = 0;
    this.quietTime = 0;
    this.lastHealth = null;
    this.queue = []; // zombies waiting to be spawned, one a step (no hitch)
    this.seenDead = new WeakSet();
    this.mobs = 0;
    this.hordeTimer = roll(this.t.hordeFirst);
    // The horde on its way: { dir: 1 ahead | -1 behind | 0 both, warn: seconds left, queue }.
    this.horde = null;
    this.hordes = 0;
  }

  /**
   * Something loud (a car alarm): a horde from both ends of the street, on
   * its way now, whatever the pacing says; it's the build-up from here.
   * Nothing more if one is already coming.
   */
  panic(ctx, warn = 2) {
    if (this.horde) return;
    this.horde = { dir: 0, warn, queue: [] };
    if (this.phase !== 'build') this._enter('build');
    ctx.onHorde?.(0);
  }

  /** Seconds until a horde arrives (0 when none is coming) and which way. */
  get hordeWarning() {
    return this.horde ? { secs: Math.max(this.horde.warn, 0), dir: this.horde.dir } : null;
  }

  /**
   * One simulation step.
   * @param {number} dt
   * @param {{
   *   player: { pos: { x: number, z: number }, health: number, state: string },
   *   zombies: Array<{ pos: { x: number, z: number, distanceTo?: Function }, dead: boolean, state: string, removed?: boolean, dispose?: () => void }>,
   *   spawn: (x: number, z: number, type: string, horde?: boolean) => any,
   *   isFree: (x: number, z: number) => boolean,
   *   pickType: (along: number) => string,
   *   onHorde?: (dir: number) => void,
   * }} ctx
   */
  update(dt, ctx) {
    const { player } = ctx;
    if (player.state === 'dead' || player.state === 'escaped') return;
    this._measure(dt, ctx);
    this._pace(dt, ctx);
    this._updateHorde(dt, ctx);
    this._spawnQueued(ctx);
    this._despawn(ctx);
  }

  _measure(dt, { player, zombies }) {
    const t = this.t;
    if (this.lastHealth !== null && player.health < this.lastHealth) {
      this.intensity += (this.lastHealth - player.health) * t.hurt;
      this.quietTime = 0;
    }
    this.lastHealth = player.health;
    if (player.state === 'grabbed') this.intensity += t.held * dt;

    let close = 0;
    let calm = true;
    let fighting = player.state === 'grabbed';
    for (const z of zombies) {
      const d = Math.hypot(z.pos.x - player.pos.x, z.pos.z - player.pos.z);
      if (z.dead) {
        if (!this.seenDead.has(z)) {
          this.seenDead.add(z);
          if (d < t.killRange) this.intensity += t.kill;
        }
        continue;
      }
      const chasing = z.state !== 'wander' && z.state !== 'investigate';
      if (!chasing) continue;
      if (d < t.closeRange) close++;
      if (d < t.calmRange) calm = false;
      if (d < 15) fighting = true;
    }
    this.intensity += close * t.close * dt;
    this.calmTime = calm ? this.calmTime + dt : 0;
    if (this.calmTime > t.decayDelay) this.intensity -= t.decay * dt;
    this.intensity = Math.min(Math.max(this.intensity, 0), 1);
    this.quietTime = fighting ? 0 : this.quietTime + dt;
  }

  _pace(dt, ctx) {
    const t = this.t;
    this.phaseTime += dt;
    if (this.phase === 'build') {
      // A horde on its way is the build-up now: all of it lands before the peak.
      if (this.horde) return;
      if (this.intensity >= t.peak || this.phaseTime > t.buildMax) return this._enter('peak');
      this.hordeTimer -= dt;
      if (this.hordeTimer <= 0) {
        this.hordeTimer = roll(t.hordeEvery);
        this.horde = { dir: Math.random() < t.hordeAhead ? 1 : -1, warn: t.hordeWarn, queue: [] };
        ctx.onHorde?.(this.horde.dir);
        return;
      }
      this.mobTimer -= dt * (this.quietTime > t.quietAfter ? 2 : 1);
      if (this.mobTimer <= 0) {
        this.mobTimer = roll(t.mobEvery);
        this._sendMob(ctx);
      }
    } else if (this.phase === 'peak') {
      if (this.phaseTime > t.peakHold) {
        this.relaxFor = roll([t.relaxMin, t.relaxMax]);
        this._enter('relax');
      }
    } else if (this.phase === 'relax') {
      const rested = this.phaseTime > this.relaxFor && this.intensity <= t.relaxExit;
      if (rested || this.phaseTime > t.relaxCap) {
        this.mobTimer = Math.min(this.mobTimer, roll([2, 5])); // the first mob doesn't keep them waiting
        this._enter('build');
      }
    }
  }

  _enter(phase) {
    this.phase = phase;
    this.phaseTime = 0;
    this.queue = []; // a peak or a relax calls off what hadn't arrived yet
  }

  _sendMob({ player, zombies, isFree, pickType }) {
    const t = this.t;
    const up = zombies.filter((z) => !z.dead);
    const near = up.filter((z) => Math.hypot(z.pos.x - player.pos.x, z.pos.z - player.pos.z) < t.aliveRange).length;
    const size = Math.min(Math.round(roll(t.mobSize)), t.alive - near, t.aliveMax - up.length);
    if (size <= 0) return;
    const at = this.spawnPoint(player.pos, isFree);
    if (!at) return;
    for (let i = 0; i < size; i++) {
      // Bunched round the spot, as a group would come.
      for (let tries = 0; tries < 8; tries++) {
        const x = Math.min(Math.max(at.x + (Math.random() - 0.5) * 4, -this.street.edge + 0.5), this.street.edge - 0.5);
        const z = at.z + (Math.random() - 0.5) * 4;
        if (!isFree(x, z) || inView(player.pos, x, z) || z < this.street.minZ || z > this.street.maxZ) continue;
        const type = Math.random() < t.runnerShare ? 'runner' : pickType(z);
        this.queue.push({ x, z, type });
        break;
      }
    }
    this.mobs++;
  }

  // The howl, then the horde: fanned across the street, all from one way,
  // coming one a step. Once warned it comes, peak or not.
  _updateHorde(dt, { player, zombies, isFree, pickType }) {
    const h = this.horde;
    if (!h) return;
    const t = this.t;
    if (h.warn > 0) {
      h.warn -= dt;
      if (h.warn > 0) return;
      const along = Math.min(Math.max(player.pos.z / this.street.maxZ, 0), 1);
      const [lo, hi] = t.hordeSize;
      const room = t.aliveMax - zombies.filter((z) => !z.dead).length;
      const size = Math.min(Math.round(lo + (hi - lo) * along + (Math.random() - 0.5) * 6), room);
      // Where they come from: one way, or both (half each). Nowhere that way
      // (the end of the street)? The other way, then.
      const ways = (h.dir ? [h.dir] : [1, -1]).map((dir) => this.spawnPoint(player.pos, isFree, dir));
      const other = ways.length === 1 && !ways[0] ? this.spawnPoint(player.pos, isFree, -h.dir) : null;
      const spots = [...ways, other].filter(Boolean);
      for (let i = 0; spots.length && i < size; i++) {
        const at = spots[i % spots.length];
        for (let tries = 0; tries < 8; tries++) {
          const x = (Math.random() * 2 - 1) * (this.street.edge - 0.5);
          const z = at.z + (Math.random() - 0.5) * 8;
          if (!isFree(x, z) || inView(player.pos, x, z) || z < this.street.minZ || z > this.street.maxZ) continue;
          h.queue.push({ x, z, type: Math.random() < t.hordeRunners ? 'runner' : pickType(z), horde: true });
          break;
        }
      }
      this.hordes++;
    }
    if (!h.queue.length) this.horde = null;
  }

  /**
   * A free spot out of sight, ahead of the player mostly (or `dir`: 1 ahead,
   * -1 behind); null if none.
   */
  spawnPoint(playerPos, isFree, dir = 0) {
    const t = this.t;
    const { minZ, maxZ, edge } = this.street;
    for (let tries = 0; tries < 30; tries++) {
      const ahead = dir ? dir > 0 : Math.random() < t.aheadShare;
      const z = ahead ? playerPos.z + roll(t.ahead) : playerPos.z - roll(t.behind);
      if (z < minZ || z > maxZ) continue;
      const x = (Math.random() * 2 - 1) * (edge - 0.5);
      if (isFree(x, z) && !inView(playerPos, x, z)) return { x, z };
    }
    return null;
  }

  // One a step (a horde has its own line). Seen by now (the player came on
  // fast)? It doesn't appear.
  _spawnQueued({ player, spawn }) {
    for (const s of [this.queue.shift(), this.horde?.warn <= 0 ? this.horde.queue.shift() : null]) {
      if (!s || inView(player.pos, s.x, s.z)) continue;
      const z = spawn(s.x, s.z, s.type, !!s.horde);
      z.state = 'chase'; // it knows where you are
    }
  }

  // Stragglers left far behind, out of sight, go: room for what's ahead.
  _despawn({ player, zombies }) {
    for (const z of zombies) {
      if (z.removed || z.state === 'grab' || z.state === 'feed') continue;
      if (player.pos.z - z.pos.z > this.t.despawnBehind && !inView(player.pos, z.pos.x, z.pos.z)) {
        z.dispose?.();
        z.removed = true;
      }
    }
  }
}
