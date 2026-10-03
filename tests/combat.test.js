import { describe, it, expect } from 'vitest';
import { makeWorld, v3 } from './world.js';
import { RAGDOLL } from '../src/ragdoll.js';
import { Throwables } from '../src/throwables.js';

// Guns, aim, wounds and bodies on the ground.

function pull(w, n, aim, gap = 0.3) {
  for (let i = 0; i < n; i++) {
    w.advance(0.05, () => ({ fire: true, aimPoint: aim() }));
    w.advance(gap, () => ({ aimPoint: aim() }));
  }
}

// Fire at `t` (aiming at aim()) and count what each shot's ray hits.
function shootAt(w, t, aim, { taps = 10, auto = 0 } = {}) {
  const p = w.player;
  const r = { shots: 0, hits: 0, head: 0, legs: 0 };
  p.onShot = (muzzle, dir) => {
    r.shots++;
    const h = t.raycast(muzzle, dir);
    if (h) {
      r.hits++;
      if (h.headshot) r.head++;
      if (h.leg) r.legs++;
    }
  };
  w.advance(0.6, () => ({ aimPoint: aim() }));
  if (auto) w.advance(auto, () => ({ fire: true, aimPoint: aim() }));
  else pull(w, taps, aim);
  p.onShot = null;
  return r;
}

describe('guns', () => {
  it('rifle: spare rounds run out, a top-up costs nothing, empty clicks', () => {
    const w = makeWorld();
    const p = w.player;
    expect([p.rounds, p.reserve]).toEqual([30, 30]);
    p.onShot = () => {};
    w.advance(0.5, { fire: true }); // 5 shots
    p.startReload();
    w.advance(3);
    expect([p.rounds, p.reserve]).toEqual([30, 25]);
    p.reserve = 0;
    p.ammo = 0;
    p.params.autoReload = false;
    w.advance(0.2, { fire: true });
    expect(p.dryFire).toBe(true);
    p.startReload();
    expect(p.reload.active).toBe(false);
  });

  it('pistol: one shot per pull, 15+1, slide locks, reload from empty racks it', () => {
    const w = makeWorld();
    const p = w.player;
    p.switchWeapon('pistol');
    w.advance(0.6);
    expect(p.weapon.name).toBe('pistol');
    expect(p.rounds).toBe(16);
    let shots = 0;
    p.onShot = () => shots++;
    w.advance(1, { fire: true });
    expect(shots).toBe(1);
    pull(w, 20, () => null, 0.12); // no faster than it can fire (420 rpm)
    expect(shots).toBe(16);
    expect(p.weapon.slideLocked || p.reload.active).toBe(true);
    w.advance(3); // auto reload from empty, racking the slide
    expect(p.weapon.chambered).toBe(true);
    expect(p.rounds).toBe(15);
  });

  it('pistol: a top-up reload keeps the chambered round (15+1)', () => {
    const w = makeWorld({ params: { startPistolReserve: 30 } });
    const p = w.player;
    p.switchWeapon('pistol');
    w.advance(0.6);
    p.onShot = () => {};
    pull(w, 4, () => null, 0.1);
    p.startReload();
    const steps = p.reload.steps.length;
    w.advance(3);
    expect(p.rounds).toBe(16);
    expect(steps).toBe(6); // no racking
  });

  it("can't swap guns mid-reload; a swap holsters one and draws the other", () => {
    const w = makeWorld();
    const p = w.player;
    p.onShot = () => {};
    w.advance(0.3, { fire: true });
    p.startReload();
    p.switchWeapon('pistol');
    expect(p.switchTo).toBe(null);
    w.advance(3);
    p.switchWeapon('pistol');
    w.advance(0.1);
    expect(p.weaponReady).toBe(false);
    w.advance(0.5);
    expect(p.weapon.name).toBe('pistol');
    expect(p.weaponReady).toBe(true);
  });
});

describe('aim: shots go where the reticle is', () => {
  it('rifle taps at a body 10 m off land', () => {
    const w = makeWorld();
    const t = w.dummy(0, 10);
    const r = shootAt(w, t, () => t.chestPos.clone());
    expect(r.hits / r.shots).toBeGreaterThanOrEqual(0.9);
  });

  it('a held rifle trigger no longer sprays over heads at close range', () => {
    const w = makeWorld();
    const t = w.dummy(0, 5);
    const r = shootAt(w, t, () => t.chestPos.clone(), { auto: 1.5 });
    expect(r.hits / r.shots).toBeGreaterThanOrEqual(0.45);
  });

  for (const [part, dist, min] of [['head', 8, 7], ['legs', 6, 7]]) {
    it(`aiming at the ${part} hits the ${part} (pistol, ${dist} m)`, () => {
      const w = makeWorld({ params: { startPistolReserve: 99 } });
      w.player.switchWeapon('pistol');
      w.advance(0.6);
      const t = w.dummy(0, dist);
      const aim = part === 'head' ? () => t.headPos.clone() : () => t.legs[0].knee.clone();
      const r = shootAt(w, t, aim);
      expect(part === 'head' ? r.head : r.legs).toBeGreaterThanOrEqual(min);
    });
  }

  it('a crawler on the road can be shot', () => {
    const w = makeWorld();
    const t = w.dummy(0, 4);
    t.legHealth = 1;
    t.takeHit(v3(0, 0, 1), 34, { leg: true, limb: 0 });
    w.advance(2);
    t.crawlDelay = 1e9;
    t.health = 1e9;
    const r = shootAt(w, t, () => t.ragdoll.chest.clone());
    expect(r.hits / r.shots).toBeGreaterThanOrEqual(0.9);
  });
});

describe('wounds', () => {
  it('one leg shot cripples it (a slow hobble); another and it crawls', () => {
    const w = makeWorld();
    const z = w.dummy(0, 10);
    z.takeHit(v3(0, 0, 1), 34, { leg: true, limb: 1 });
    expect(z.injurySpeed).toBeLessThan(0.7);
    expect(z.feet[1].stepScale).toBeLessThan(0.5);
    expect(z.ragdoll).toBe(null);
    z.takeHit(v3(0, 0, 1), 34, { leg: true, limb: 0 });
    expect(z.ragdoll).not.toBe(null);
  });

  it('arms come off; with both forearms gone it cannot grab', () => {
    const w = makeWorld();
    const z = w.dummy(0, 10);
    const severed = [];
    z.onSever = (_, i, part) => severed.push(`${i}${part}`);
    z.takeHit(v3(0, 0, 1), 34, { arm: true, limb: 0, part: 'fore' });
    z.takeHit(v3(0, 0, 1), 34, { arm: true, limb: 1, part: 'fore' });
    expect(severed).toEqual(['0fore', '1fore']);
    expect(z.canGrab).toBe(false);
    z.takeHit(v3(0, 0, 1), 34, { arm: true, limb: 0, part: 'upper' });
    expect(z.arms[0].lostUpper).toBe(true);
  });

  it('a smashed bottle draws the ones that have not seen you, not the far ones', () => {
    const w = makeWorld();
    const near = w.addZombie(4, 14);
    const far = w.addZombie(0, 60);
    for (const z of [near, far]) {
      z.state = 'wander';
      z.wanderTimer = 1e9;
      z.wanderTarget.copy(z.pos);
    }
    const bottles = new Throwables(w.scene, (pos) => {
      for (const z of w.zombies) if (z.pos.distanceTo(pos) < w.params.noiseRange) z.investigate(pos);
    });
    bottles.lob(v3(0, 1.4, 0), v3(5, 0, 10));
    for (let i = 0; i < 120; i++) bottles.update(1 / 120);
    expect(near.state).toBe('investigate');
    expect(far.state).toBe('wander');
  });
});

describe('bodies', () => {
  it('a shot zombie falls and lies on the road', () => {
    const w = makeWorld();
    const z = w.dummy(0, 6);
    z.takeHit(v3(0, 0, 1), 999, { height: 1.2 });
    w.advance(4);
    const ps = z.ragdoll.particles;
    expect(ps.every((p) => Number.isFinite(p.pos.y))).toBe(true);
    expect(Math.min(...ps.map((p) => p.pos.y - p.r))).toBeGreaterThan(-0.01);
    expect(z.ragdoll.head.y).toBeLessThan(0.35);
  });

  it('a crawler stays face down, steady, and drags itself toward you', () => {
    const w = makeWorld();
    w.player.teleport(v3(0, 0, -12));
    const z = w.addZombie(0, 0);
    z.aimYaw = Math.PI;
    z._settle();
    z.takeHit(v3(0, 0, 1), 34, { leg: true, limb: 0 });
    z.takeHit(v3(0, 0, 1), 34, { leg: true, limb: 1 });
    w.advance(3.5);
    const z0 = z.ragdoll.pelvis.z;
    let maxRoll = 0;
    let faceUp = 0;
    const P = (i) => z.ragdoll.particles[i].pos;
    w.advance(3, {}, () => {
      const left = P(RAGDOLL.LEG[0].hip).clone().sub(P(RAGDOLL.LEG[1].hip)).normalize();
      maxRoll = Math.max(maxRoll, Math.asin(Math.min(Math.abs(left.y), 1)));
      const up = P(RAGDOLL.ARM[0].sh).clone().add(P(RAGDOLL.ARM[1].sh)).sub(P(RAGDOLL.LEG[0].hip)).sub(P(RAGDOLL.LEG[1].hip)).normalize();
      if (left.clone().cross(up).y > 0.3) faceUp++;
    });
    const speed = (z0 - z.ragdoll.pelvis.z) / 3;
    expect(maxRoll).toBeLessThan(0.17); // under 10 degrees
    expect(faceUp).toBe(0);
    expect(speed).toBeGreaterThan(0.25);
    expect(speed).toBeLessThan(0.7);
  });

  it('the player torn apart: many pieces, none under the road', () => {
    const w = makeWorld();
    const p = w.player;
    p.die('halves', [v3(1, 0, 0), v3(-1, 0, 0)], w.gore);
    w.advance(3);
    expect(p.ragdoll._pieces().length).toBeGreaterThanOrEqual(8);
    expect(Math.min(...p.ragdoll.particles.map((q) => q.pos.y - q.r))).toBeGreaterThan(-0.01);
  });

  it('walking through a corpse nudges it, but does not drag it along', () => {
    const w = makeWorld();
    const z = w.dummy(0, 5);
    z.takeHit(v3(0, 0, 1), 999, { height: 1.2 });
    w.advance(3);
    const before = z.ragdoll.pelvis.clone();
    const p = w.player;
    p.teleport(before.clone().setZ(before.z - 2.5).setY(0));
    w.advance(2.5, { z: 1 }, () => {
      for (const leg of p.legs) z.ragdoll.push(leg.ankle, 0.07, p.vel.clone().multiplyScalar(1.4));
    });
    const moved = z.ragdoll.pelvis.distanceTo(before);
    expect(moved).toBeGreaterThan(0.02);
    expect(moved).toBeLessThan(1);
  });
});
