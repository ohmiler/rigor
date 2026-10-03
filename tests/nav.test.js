import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeWorld, v3 } from './world.js';
import { NavGrid } from '../src/nav.js';

// A wall across the way: 5 m wide, too tall to step over, not climbable.
function walled() {
  const w = makeWorld({ zparams: { detectRange: 30 } });
  w.box(0, 0, 2.5, 0.3, 1.6);
  return w;
}

const insideWall = (p) => Math.abs(p.x) < 2.5 && Math.abs(p.z) < 0.3;

describe('pathfinding', () => {
  it('the grid marks tall things blocked and kerbs walkable', () => {
    const level = { colliders: [] };
    level.colliders.push({ x: 0, z: 0, hx: 1, hz: 1, cos: 1, sin: 0, top: 1.5 });
    level.colliders.push({ x: 4, z: 0, hx: 1, hz: 1, cos: 1, sin: 0, top: 0.16, floor: true });
    const nav = new NavGrid(level, { minX: -6, maxX: 6, minZ: -6, maxZ: 6 });
    expect(nav.isFree(0, 0)).toBe(false);
    expect(nav.isFree(1.2, 0)).toBe(false); // the margin for a body's width
    expect(nav.isFree(4, 0)).toBe(true);
    expect(nav.clear(v3(-3, 0, 0), v3(3, 0, 0))).toBe(false);
    expect(nav.clear(v3(-3, 0, 3), v3(3, 0, 3))).toBe(true);
  });

  it('steers round a wall instead of into it, and builds a field once per target cell', () => {
    const w = walled();
    const nav = w.navigate();
    const out = new THREE.Vector3();
    expect(nav.steer(v3(0, 0, -3), v3(0, 0, 3), out)).toBe(true);
    // Heads for one end of the wall, not straight at it.
    expect(Math.abs(out.x)).toBeGreaterThan(1.5);
    nav.steer(v3(0.5, 0, -3), v3(0.1, 0, 3.05), out);
    expect(nav.builds).toBe(1);
  });

  it('a zombie walks round a wall to reach you; without the grid it is stuck behind it', () => {
    const run = (withNav) => {
      const w = walled();
      if (withNav) w.navigate();
      w.player.pos.set(0, 0, 3);
      const z = w.addZombie(0, -3);
      z.state = 'chase';
      let closest = Infinity;
      let walledIn = false;
      w.advance(14, {}, () => {
        closest = Math.min(closest, z.pos.distanceTo(w.player.pos));
        if (insideWall(z.pos)) walledIn = true;
      });
      return { closest, walledIn };
    };
    const lost = run(false);
    const found = run(true);
    expect(lost.closest).toBeGreaterThan(2.5);
    expect(found.closest).toBeLessThan(1.2);
    expect(found.walledIn).toBe(false);
  });

  it('when you stand on top of something, it heads for the free ground beside it', () => {
    const w = makeWorld();
    w.box(0, 0, 1, 2, 1.4, { climb: true });
    const nav = w.navigate();
    const out = new THREE.Vector3();
    expect(nav.steer(v3(0, 0, -8), v3(0, 1.4, 0), out)).toBe(true);
    expect(nav.isFree(out.x, out.z)).toBe(true);
  });
});
