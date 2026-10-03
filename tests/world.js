import * as THREE from 'three';
import { Humanoid } from '../src/humanoid.js';
import { Player } from '../src/player.js';
import { Zombie } from '../src/zombie.js';
import { Gore } from '../src/gore.js';
import { Grapple } from '../src/grapple.js';
import { DEFAULTS, ZOMBIE_DEFAULTS } from '../src/params.js';
import { heightAt, solidAt, findLedge, collideCircle } from '../src/level.js';

// A headless world for tests: the game's own bodies, guns and gore on a
// flat floor (plus any boxes a test adds), stepped at the game's 120 Hz.
// No renderer, no sound.

export const STEP = 1 / 120;

export function makeWorld({ params = {}, zparams = {} } = {}) {
  const level = { colliders: [] };
  Humanoid.terrain = {
    heightAt: (x, z, maxY) => heightAt(level, x, z, maxY),
    findLedge: (pos, dir) => findLedge(level, pos, dir),
    solidAt: (p) => solidAt(level, p),
    collide: (pos, r, bottom, stepUp) => collideCircle(level, pos, r, bottom, stepUp),
  };
  const scene = new THREE.Scene();
  const p = { ...DEFAULTS, flashlightOn: false, ...params };
  const zp = { ...ZOMBIE_DEFAULTS, ...zparams };
  const gore = new Gore(scene);
  const player = new Player(scene, p);
  const grapple = new Grapple(player, gore, p);
  const zombies = [];
  const world = { player, zombies, grapple };

  const w = {
    scene,
    level,
    params: p,
    zparams: zp,
    gore,
    player,
    grapple,
    zombies,
    world,
    // A box on the floor: top height `top`, half-sizes hx, hz.
    box(x, z, hx, hz, top, opts = {}) {
      level.colliders.push({ x, z, hx, hz, cos: 1, sin: 0, top, climb: false, vault: false, ...opts });
    },
    addZombie(x, z, type = 'walker') {
      const zombie = new Zombie(scene, zp, new THREE.Vector3(x, 0, z), type);
      zombies.push(zombie);
      return zombie;
    },
    // A zombie that stands where it's put and never notices you: a target.
    dummy(x, z, type = 'walker') {
      const t = w.addZombie(x, z, type);
      t.aimYaw = Math.PI;
      t._settle();
      t.params = Object.assign(Object.create(t.params), { detectRange: 0, wanderSpeed: 0, chaseSpeed: 0 });
      t.state = 'wander';
      t.wanderTimer = 1e9;
      t.wanderTarget.copy(t.pos);
      return t;
    },
    // Run the world. `input` is the player's (or a function of time).
    advance(secs, input = {}, each = null) {
      for (let t = 0; t < secs; t += STEP) {
        const inp = typeof input === 'function' ? input(t) : input;
        player.update(STEP, { x: 0, z: 0, ...inp });
        for (const z of zombies) z.update(STEP, world);
        grapple.update(STEP, 0);
        gore.update(STEP);
        each?.(t);
      }
    },
  };
  return w;
}

// The bottom of a foot (heel, ball, toe tip) in world space.
const HEEL = new THREE.Vector3(0, -0.035, -0.085);
const BALL = new THREE.Vector3(0, -0.035, 0.085);
const TIP = new THREE.Vector3(0, -0.025, 0.09);
export function soles(body) {
  body.body.updateMatrixWorld(true);
  return body.legs.map((l) => [l.foot.localToWorld(HEEL.clone()), l.foot.localToWorld(BALL.clone()), l.toe.localToWorld(TIP.clone())]);
}

export const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
