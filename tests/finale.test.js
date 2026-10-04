import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Finale, FINALE } from '../src/finale.js';
import { Director } from '../src/director.js';
import { mulberry32 } from '../src/replay.js';

const STEP = 1 / 120;
const goal = { pos: new THREE.Vector3(0, 0, 110), radius: 2.6 };
const player = (x, z, state = 'normal') => ({ pos: new THREE.Vector3(x, 0, z), state });
const run = (finale, p, secs) => {
  let rescued = false;
  for (let t = 0; t < secs; t += STEP) rescued = finale.update(STEP, p) || rescued;
  return rescued;
};

describe('the finale', () => {
  it('the radio only works from the extraction point, and only once', () => {
    const f = new Finale(goal);
    let calls = 0;
    f.onCall = () => calls++;
    expect(f.call(player(0, 100))).toBe(false); // ten metres short
    expect(f.call(player(0, 110, 'grabbed'))).toBe(false);
    expect(f.phase).toBe('waiting');
    expect(f.call(player(1, 109))).toBe(true);
    expect(f.phase).toBe('holdout');
    expect(f.call(player(1, 109))).toBe(false);
    expect(calls).toBe(1);
  });

  it('reaching the point does not end the run; holding out, then the helicopter, does', () => {
    const f = new Finale(goal);
    const p = player(0, 110);
    expect(run(f, p, 5)).toBe(false); // standing there without the radio
    f.call(p);
    expect(run(f, p, FINALE.holdout - 1)).toBe(false); // standing in it all the holdout
    expect(f.timeLeft).toBeGreaterThan(0.5);
    expect(run(f, p, 1.1)).toBe(false);
    expect(f.phase).toBe('arriving');
    expect(run(f, p, FINALE.arrive + 0.1)).toBe(true); // the moment it's down
    expect(f.phase).toBe('rescued');
  });

  it('once it is down you have to get under it, standing', () => {
    const f = new Finale(goal);
    f.call(player(0, 110));
    const away = player(0, 90);
    run(f, away, FINALE.holdout + FINALE.arrive + 0.1);
    expect(f.phase).toBe('landed');
    expect(run(f, player(0, 110, 'grabbed'), 1)).toBe(false);
    expect(run(f, player(0, 110, 'dead'), 1)).toBe(false);
    expect(run(f, player(0.5, 111), 0.1)).toBe(true);
  });

  it('the helicopter comes from beyond the gate and settles where it hangs', () => {
    const f = new Finale(goal);
    const at = new THREE.Vector3();
    expect(f.heliPose(at)).toBe(false);
    f.call(player(0, 110));
    run(f, player(0, 50), FINALE.holdout + 0.01);
    expect(f.heliPose(at)).toBe(true);
    expect(at.y).toBeGreaterThan(FINALE.hover.y + 10);
    expect(at.z).toBeGreaterThan(goal.pos.z + 30);
    run(f, player(0, 50), FINALE.arrive + 1);
    f.heliPose(at);
    expect(at.y).toBeCloseTo(FINALE.hover.y, 5);
    expect(at.z).toBeCloseTo(goal.pos.z + FINALE.hover.ahead, 5);
  });

  it('the Director in the finale: no peaks, no breathers, hordes coming', () => {
    const real = Math.random;
    Math.random = mulberry32(5);
    try {
      const d = new Director({ minZ: 2, maxZ: 113, edge: 6.5 });
      const p = { pos: new THREE.Vector3(0, 0, 110), health: 100, state: 'normal' };
      const zombies = [];
      const warned = [];
      const ctx = {
        onHorde: (dir) => warned.push(dir),
        player: p,
        zombies,
        isFree: () => true,
        pickType: () => 'walker',
        spawn(x, z) {
          const zombie = { pos: new THREE.Vector3(x, 0, z), dead: false, state: 'wander' };
          zombies.push(zombie);
          return zombie;
        },
      };
      d.startFinale();
      const phases = new Set();
      for (let t = 0; t < FINALE.holdout; t += STEP) {
        p.health = 100 - (Math.floor(t) % 10) * 8; // hurt over and over: it would peak, normally
        d.update(STEP, ctx);
        phases.add(d.phase);
        // Keep the street from filling: the dead are cleared.
        for (const z of zombies) if (Math.random() < 0.01) z.dead = true;
      }
      expect([...phases]).toEqual(['build']);
      expect(d.hordes).toBeGreaterThanOrEqual(4);
      // At the end of the street they can only come from behind the player,
      // and the warnings say so.
      expect(zombies.every((z) => z.pos.z < p.pos.z)).toBe(true);
      expect(warned.length).toBe(d.hordes);
      expect(new Set(warned)).toEqual(new Set([-1]));
    } finally {
      Math.random = real;
    }
  });
});
