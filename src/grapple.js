import * as THREE from 'three';

const _dir = new THREE.Vector3();
const MAX_GRABBERS = 3;

/**
 * The grab / struggle / bite loop between the player and zombies.
 * Mash to fill the struggle meter before the bite timer runs out; every
 * extra zombie hanging on makes each press count for less.
 */
export class Grapple {
  constructor(player, gore, params, hooks = {}) {
    this.player = player;
    this.gore = gore;
    this.params = params;
    this.hooks = hooks;
    this.reset();
  }

  reset() {
    this.grabbers = [];
    this.struggle = 0;
    this.biteTimer = 0;
    this.biteTime = 1;
    this.round = 0;
    this.grace = 0;
  }

  get active() {
    return this.grabbers.length > 0;
  }

  canGrab() {
    const s = this.player.state;
    if (this.player.traversal) return false; // mid-vault or mid-climb
    if (s === 'normal') return this.grace <= 0;
    return s === 'grabbed' && this.grabbers.length < MAX_GRABBERS;
  }

  grab(zombie) {
    if (!this.canGrab() || this.grabbers.includes(zombie)) return false;
    this.grabbers.push(zombie);
    zombie.state = 'grab';
    if (this.grabbers.length === 1) {
      this.player.state = 'grabbed';
      this.struggle = 0;
      this.round = 0;
      this.biteTime = this.params.biteTime;
      this.biteTimer = this.biteTime;
    }
    this.player.grabbedBy = this.grabbers[0];
    this.player.jolt(this._dirTo(zombie, _dir).negate(), 1.5);
    return true;
  }

  update(dt, presses) {
    const p = this.params;
    this.grace = Math.max(this.grace - dt, 0);
    if (!this.active) return;

    this.grabbers = this.grabbers.filter((z) => !z.dead && z.state === 'grab');
    if (!this.active) {
      this._release(0.6);
      return;
    }
    this.player.grabbedBy = this.grabbers[0];

    const gain = p.struggleGain / Math.pow(this.grabbers.length, 0.8);
    this.struggle = THREE.MathUtils.clamp(this.struggle + presses * gain - p.struggleDecay * dt, 0, 1);
    for (let i = 0; i < presses; i++) {
      // Every press is a visible wrench against whoever is holding on.
      const z = this.grabbers[Math.floor(Math.random() * this.grabbers.length)];
      this._dirTo(z, _dir);
      this.player.jolt(_dir.clone().negate().applyAxisAngle(THREE.Object3D.DEFAULT_UP, (Math.random() - 0.5) * 2), 1.2);
      z.jolt(_dir, 1.5);
    }
    if (this.struggle >= 1) {
      this._breakFree();
      return;
    }

    this.biteTimer -= dt;
    if (this.biteTimer <= 0) this._bite();
  }

  get biteProgress() {
    return this.active ? 1 - this.biteTimer / this.biteTime : 0;
  }

  _bite() {
    const p = this.params;
    const player = this.player;
    const biter = this.grabbers[Math.floor(Math.random() * this.grabbers.length)];
    player.health -= p.biteDamage * (1 + 0.3 * (this.grabbers.length - 1));

    // Blood out of the neck and shoulder, away from the biter.
    this._dirTo(biter, _dir);
    const neck = player.headPos.clone().add(new THREE.Vector3(0, -0.15, 0));
    this.gore.spray(neck, _dir.clone().negate().setY(0.8), 30, 2.4);
    player.jolt(_dir.clone().negate(), 2.5);
    biter.jolt(_dir, -2); // lunges in for the bite
    this.hooks.onBite?.();

    if (player.health <= 0) {
      this._kill();
      return;
    }
    // Each round comes faster and the meter only half survives.
    this.round++;
    this.biteTime = p.biteTime * Math.pow(0.85, this.round);
    this.biteTimer = this.biteTime;
    this.struggle *= 0.5;
  }

  _breakFree() {
    for (const z of this.grabbers) z.shove(this._dirTo(z, new THREE.Vector3()), this.params.breakFreeShove);
    this.grabbers = [];
    this._release(this.params.graceTime);
    this.hooks.onBreakFree?.();
  }

  _release(grace) {
    this.player.state = this.player.state === 'dead' ? 'dead' : 'normal';
    this.player.grabbedBy = null;
    this.grace = grace;
    this.struggle = 0;
  }

  _kill() {
    const pulls = this.grabbers.map((z) => this._dirTo(z, new THREE.Vector3()));
    const mode = this.grabbers.length >= 2 ? 'halves' : 'arms';
    this.player.die(mode, pulls, this.gore);
    for (const z of this.grabbers) z.state = 'feed';
    this.grabbers = [];
    this.hooks.onDeath?.(mode);
  }

  // Unit vector on the ground from the player toward a zombie.
  _dirTo(zombie, out) {
    out.subVectors(zombie.pos, this.player.pos).setY(0);
    if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
    return out.normalize();
  }
}
