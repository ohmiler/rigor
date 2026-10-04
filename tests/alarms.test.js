import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CarAlarms } from '../src/alarms.js';
import { Director, inView } from '../src/director.js';
import { mulberry32 } from '../src/replay.js';

// The street's cars, as level.js places them.
const CARS = [
  [-2, 14, 0.15], [2.3, 21, -0.05], [-1.2, 33, 0.9], [1.6, 36.5, -0.6], [-2.4, 50, 0.05],
  [2.1, 58, 3.1], [-2.2, 64, 0.1], [0.3, 76, 1.45], [2.6, 89, -0.2], [-2.3, 96, 0.3],
].map(([x, z, yaw]) => ({ x, z, yaw }));

function seededAlarms(seed) {
  const real = Math.random;
  Math.random = mulberry32(seed);
  try {
    const alarms = new CarAlarms(new THREE.Scene(), CARS);
    alarms.reset();
    const rang = [];
    alarms.onAlarm = (car) => rang.push(car);
    return { alarms, rang };
  } finally {
    Math.random = real;
  }
}

// A point on (or in) a car, from car-local right/up/forward.
const onCar = (car, lx, y, lz) =>
  new THREE.Vector3(car.x + lx * Math.cos(car.yaw) + lz * Math.sin(car.yaw), y, car.z - lx * Math.sin(car.yaw) + lz * Math.cos(car.yaw));

describe('car alarms', () => {
  it('a few cars are armed each run, never by the start, and the seed says which', () => {
    const a = seededAlarms(3).alarms.armed;
    expect(a.length).toBe(3);
    for (const car of a) expect(car.z).toBeGreaterThan(25);
    expect(seededAlarms(3).alarms.armed).toEqual(a);
    const others = [4, 5, 6, 7].map((s) => seededAlarms(s).alarms.armed);
    expect(others.some((o) => JSON.stringify(o) !== JSON.stringify(a))).toBe(true);
  });

  it('a bullet into an armed car sets it off, once', () => {
    const { alarms, rang } = seededAlarms(1);
    const car = alarms.armed[0];
    const shooter = onCar(car, 3, 0, -6);
    alarms.shotAt(onCar(car, 0.5, 0.7, 1.5), shooter); // the door
    expect(rang).toEqual([car]);
    alarms.shotAt(onCar(car, -0.3, 1.2, 0), shooter); // again: it's already going
    expect(rang.length).toBe(1);
    expect(alarms.armed).not.toContain(car);
  });

  it('a bullet into an unarmed car, or over an armed one, does nothing', () => {
    const { alarms, rang } = seededAlarms(1);
    const quiet = CARS.find((c) => !alarms.armed.includes(c));
    alarms.shotAt(onCar(quiet, 0, 0.7, 0), onCar(quiet, 3, 0, -6));
    const near = onCar(alarms.armed[0], 3, 0, -6);
    alarms.shotAt(onCar(alarms.armed[0], 0, 2.3, 0), near); // a wall behind it, above the roof
    alarms.shotAt(onCar(alarms.armed[0], 2.5, 0.7, 0), near); // the road beside it
    expect(rang).toEqual([]);
  });

  it('a stray round from too far off to see the car does nothing', () => {
    const { alarms, rang } = seededAlarms(1);
    const car = alarms.armed[0];
    alarms.shotAt(onCar(car, 0, 0.7, 0), new THREE.Vector3(car.x, 0, car.z - 25));
    expect(rang).toEqual([]);
    alarms.shotAt(onCar(car, 0, 0.7, 0), new THREE.Vector3(car.x, 0, car.z - 12));
    expect(rang).toEqual([car]);
  });

  it('climbing up on an armed car sets it off; walking past it does not', () => {
    const { alarms, rang } = seededAlarms(2);
    const car = alarms.armed[0];
    const player = { pos: onCar(car, 1.4, 0, 0), state: 'normal' };
    alarms.update(1 / 120, player);
    expect(rang).toEqual([]);
    player.pos.copy(onCar(car, 0, 0.95, 1.6)); // on the bonnet
    alarms.update(1 / 120, player);
    expect(rang).toEqual([car]);
  });

  it('rings for a while, then stops', () => {
    const { alarms } = seededAlarms(2);
    const car = alarms.armed[0];
    alarms.shotAt(onCar(car, 0, 0.7, 0), onCar(car, 3, 0, -6));
    const ringing = () => alarms.cars.some((c) => c.ringing > 0);
    expect(ringing()).toBe(true);
    const player = { pos: new THREE.Vector3(0, 0, 0), state: 'normal' };
    for (let t = 0; t < 21; t += 1 / 120) alarms.update(1 / 120, player);
    expect(ringing()).toBe(false);
  });

  it('the panic it causes: a horde from both ends, on a breather or not, out of sight', () => {
    const real = Math.random;
    Math.random = mulberry32(9);
    try {
      const d = new Director({ minZ: 2, maxZ: 113, edge: 6.5 });
      const player = { pos: new THREE.Vector3(0, 0, 50), health: 100, state: 'normal' };
      const spawns = [];
      const warned = [];
      const ctx = {
        player,
        zombies: [],
        isFree: () => true,
        pickType: () => 'walker',
        onHorde: (dir) => warned.push(dir),
        spawn(x, z) {
          const zombie = { pos: new THREE.Vector3(x, 0, z), dead: false, state: 'wander' };
          ctx.zombies.push(zombie);
          spawns.push(zombie.pos.clone());
          return zombie;
        },
      };
      d.update(1 / 120, ctx);
      expect(d.phase).toBe('relax'); // the calm at the start
      d.panic(ctx);
      expect(warned).toEqual([0]);
      expect(d.phase).toBe('build');
      d.panic(ctx); // a second alarm while that one is on its way: nothing more
      expect(warned).toEqual([0]);
      for (let t = 0; t < 4; t += 1 / 120) d.update(1 / 120, ctx);
      expect(spawns.length).toBeGreaterThan(15);
      expect(spawns.some((p) => p.z > player.pos.z)).toBe(true);
      expect(spawns.some((p) => p.z < player.pos.z)).toBe(true);
      for (const p of spawns) expect(inView(player.pos, p.x, p.z)).toBe(false);
    } finally {
      Math.random = real;
    }
  });
});
