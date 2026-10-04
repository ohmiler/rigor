import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Director, DIRECTOR, inView } from '../src/director.js';
import { mulberry32, fingerprint } from '../src/replay.js';
import { makeWorld, STEP } from './world.js';

const STREET = { minZ: 2, maxZ: 113, edge: 6.5 };

// A run of the Director alone, under one seed: a player walking up the
// street at `speed`, zombies that are just positions, and `hurt(t)` saying
// how much health the player loses on each step (a fight, without one).
function night(seed, { secs = 300, speed = 0.4, hurt = () => 0, isFree = () => true } = {}) {
  const real = Math.random;
  Math.random = mulberry32(seed);
  try {
    const director = new Director(STREET);
    const player = { pos: new THREE.Vector3(0, 0, 3), health: 100, state: 'normal' };
    const zombies = [];
    const spawns = [];
    const phases = [];
    const ctx = {
      player,
      zombies,
      isFree,
      pickType: () => 'walker',
      spawn(x, z, type) {
        const zombie = { pos: new THREE.Vector3(x, 0, z), dead: false, state: 'wander', type };
        zombies.push(zombie);
        spawns.push({ t: phases.length * STEP, x, z, playerZ: player.pos.z, phase: director.phase });
        return zombie;
      },
    };
    for (let s = 0; s * STEP < secs; s++) {
      const t = s * STEP;
      player.pos.z = Math.min(3 + t * speed, 110);
      player.health = Math.max(player.health - hurt(t, director), 1);
      if (player.health < 30) player.health = 100; // patched up (keeps the test going)
      director.update(STEP, ctx);
      phases.push(director.phase);
    }
    return { director, spawns, phases };
  } finally {
    Math.random = real;
  }
}

// Spans of one phase: [phase, from, to] in seconds.
function spans(phases) {
  const out = [];
  phases.forEach((p, i) => {
    if (out.length && out[out.length - 1][0] === p) out[out.length - 1][2] = (i + 1) * STEP;
    else out.push([p, i * STEP, (i + 1) * STEP]);
  });
  return out;
}

describe('the AI Director', () => {
  it('sends mobs, and every one of them spawns out of sight', () => {
    for (const seed of [1, 2, 3, 99]) {
      const { spawns } = night(seed);
      expect(spawns.length).toBeGreaterThan(10);
      for (const s of spawns) {
        expect(inView({ x: 0, z: s.playerZ }, s.x, s.z)).toBe(false);
        expect(s.z).toBeGreaterThanOrEqual(STREET.minZ - 2);
        expect(s.z).toBeLessThanOrEqual(STREET.maxZ + 2);
        expect(Math.abs(s.x)).toBeLessThan(STREET.edge);
      }
    }
  });

  it('only spawns where it is free to stand', () => {
    const isFree = (x) => x > 0; // half the street is blocked
    const { spawns } = night(5, { isFree });
    expect(spawns.length).toBeGreaterThan(5);
    for (const s of spawns) expect(s.x).toBeGreaterThan(0);
  });

  it('starts calm, then builds', () => {
    const { phases, spawns } = night(4, { secs: 60 });
    expect(phases[0]).toBe('relax');
    expect(spawns[0].t).toBeGreaterThan(DIRECTOR.startCalm);
    expect(phases).toContain('build');
  });

  it('a hard fight peaks, and then the player gets a real breather', () => {
    // Bitten every few seconds while mobs keep coming.
    const run = night(6, {
      secs: 240,
      hurt: (t, director) => (director.phase === 'build' && Math.round(t / STEP) % 360 === 0 ? 20 : 0),
    });
    const s = spans(run.phases);
    expect(s.some(([p]) => p === 'peak')).toBe(true);
    const relaxes = s.filter(([p, from]) => p === 'relax' && from > 0);
    expect(relaxes.length).toBeGreaterThan(0);
    for (const [, from, to] of relaxes) {
      if (to < 239) expect(to - from).toBeGreaterThanOrEqual(DIRECTOR.relaxMin - STEP);
      // Nothing new arrives while the player breathes.
      expect(run.spawns.filter((sp) => sp.t > from + STEP && sp.t < to)).toEqual([]);
    }
  });

  it('pain is what makes it peak', () => {
    const real = Math.random;
    Math.random = mulberry32(8);
    try {
      const d = new Director(STREET);
      const player = { pos: new THREE.Vector3(0, 0, 20), health: 100, state: 'normal' };
      const ctx = { player, zombies: [], isFree: () => true, pickType: () => 'walker', spawn: () => ({ pos: new THREE.Vector3(), state: 'wander', dead: false }) };
      d.update(STEP, ctx);
      d.phase = 'build';
      player.health = 50; // a bite and a blow
      d.update(STEP, ctx);
      expect(d.intensity).toBeGreaterThan(0.75);
      d.update(STEP, ctx);
      expect(d.phase).toBe('peak');
      // Left alone, it drains away.
      for (let t = 0; t < 15; t += STEP) d.update(STEP, ctx);
      expect(d.intensity).toBeLessThan(DIRECTOR.relaxExit);
    } finally {
      Math.random = real;
    }
  });

  it('even a player it never hurts gets a breather', () => {
    const s = spans(night(9, { secs: 200 }).phases);
    expect(s.filter(([p, from]) => p === 'relax' && from > 0).length).toBeGreaterThan(0);
  });

  it('the same seed gives the same night; another seed, another', () => {
    const a = night(11).spawns;
    expect(night(11).spawns).toEqual(a);
    expect(night(12).spawns).not.toEqual(a);
  });

  it('a fight with its mobs plays the same twice (replays stay exact)', () => {
    const fightPrints = (seed) => {
      const real = Math.random;
      Math.random = mulberry32(seed);
      try {
        const w = makeWorld();
        w.navigate({ minX: -7, maxX: 7, minZ: -2, maxZ: 60 });
        // Short calm and quick mobs, so they arrive within the test.
        const director = new Director({ minZ: 2, maxZ: 58, edge: 6.5 }, { startCalm: 1, mobEvery: [2, 3] });
        const ctx = {
          player: w.player,
          zombies: w.zombies,
          isFree: () => true,
          pickType: () => 'walker',
          spawn: (x, z, type) => w.addZombie(x, z, type),
        };
        const prints = [];
        const aim = new THREE.Vector3(0, 1.3, 30);
        w.advance(10, (t) => ({ z: t < 3 ? 1 : 0, fire: t > 6, aimPoint: aim }), (t) => {
          director.update(STEP, ctx);
          if (Math.round(t / STEP) % 120 === 0) {
            prints.push(fingerprint([w.player.pos.z, w.player.health, w.zombies.length, ...w.zombies.flatMap((z) => [z.pos.x, z.pos.z])]));
          }
        });
        return { prints, zombies: w.zombies.length };
      } finally {
        Math.random = real;
      }
    };
    const a = fightPrints(21);
    expect(a.zombies).toBeGreaterThan(3); // mobs did come
    expect(fightPrints(21).prints).toEqual(a.prints);
  });
});
