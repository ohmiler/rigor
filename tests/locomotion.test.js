import { describe, it, expect } from 'vitest';
import { makeWorld, soles, STEP } from './world.js';
import { heightAt } from '../src/level.js';

// Walking, running, turning, steps and falls: feet that stay on the ground
// they're on, legs that reach it, and nothing passing through anything.

const DIRS = { W: [0, 1], S: [0, -1], D: [-1, 0], A: [1, 0] };
const aimAhead = (p) => p.pos.clone().set(p.pos.x, 1.2, p.pos.z + 10);

function measureFeet(w, secs, input) {
  const p = w.player;
  const r = { sink: 0, floatInStance: 0, slide: 0, legShort: 0, minKneeGap: Infinity };
  let prev = [null, null];
  w.advance(secs, input, (t) => {
    const s = soles(p);
    s.forEach((pts, i) => {
      const f = p.feet[i];
      for (const q of pts) r.sink = Math.min(r.sink, q.y - heightAt(w.level, q.x, q.z, q.y + 0.3));
      if (f.planted && t > secs / 2) {
        r.floatInStance = Math.max(r.floatInStance, Math.min(...pts.map((q) => q.y)));
        r.legShort = Math.max(r.legShort, p.legs[i].ankle.distanceTo(p.legs[i].ankleTarget));
        // Skid: the toe tip (the part that stays put) moving while planted on the ground.
        if (prev[i] && pts[2].y < 0.003 && prev[i][2].y < 0.003) {
          r.slide = Math.max(r.slide, Math.hypot(pts[2].x - prev[i][2].x, pts[2].z - prev[i][2].z) / STEP);
        }
      }
      prev[i] = f.planted ? pts : null;
    });
    r.minKneeGap = Math.min(r.minKneeGap, p.legs[0].knee.distanceTo(p.legs[1].knee));
  });
  return r;
}

describe('walking and running on flat ground', () => {
  for (const [name, input] of [
    ['walk', { z: 1, walk: true }],
    ['jog', { z: 1 }],
    ['sprint', { z: 1, sprint: true }],
    ['backpedal', { z: -1 }],
  ]) {
    it(`${name}: soles never sink, planted feet don't skid or float, legs reach`, () => {
      const w = makeWorld();
      const r = measureFeet(w, 3, () => ({ ...input, aimPoint: aimAhead(w.player) }));
      expect(r.sink).toBeGreaterThan(-0.01);
      expect(r.floatInStance).toBeLessThan(0.01);
      expect(r.slide).toBeLessThan(0.15);
      expect(r.legShort).toBeLessThan(0.03);
    });
  }

  it('strafing and diagonals: the legs never scissor through each other', () => {
    const w = makeWorld();
    for (const key of ['W', 'D', 'S', 'A', 'D', 'W']) {
      const [x, z] = DIRS[key];
      const r = measureFeet(w, 1.5, () => ({ x, z, aimPoint: aimAhead(w.player) }));
      expect(r.minKneeGap, `knees too close moving ${key}`).toBeGreaterThan(0.14);
    }
  });

  it('turning on the spot steps the legs round to face the aim', () => {
    const w = makeWorld();
    const p = w.player;
    w.advance(2, () => ({ aimPoint: p.pos.clone().set(p.pos.x + 10, 1.2, p.pos.z) }));
    expect(Math.abs(p.lowerYaw - Math.PI / 2)).toBeLessThan(0.25);
  });
});

describe('steps and drops', () => {
  for (const h of [0.14, 0.3, 0.55]) {
    it(`up a ${h} m step: no foot or shin inside it, the hips ease up`, () => {
      const w = makeWorld();
      w.box(0, 5, 3, 2.5, h); // from z 2.5 to 7.5
      const p = w.player;
      let clip = 0;
      let hipSpeed = 0;
      let prevY = null;
      w.advance(3.2, () => ({ z: 1, walk: true, aimPoint: aimAhead(p) }), () => {
        p.body.updateMatrixWorld(true);
        for (const leg of p.legs) {
          const pts = [leg.ankle, leg.knee.clone().lerp(leg.ankle, 0.5)];
          for (const q of pts) clip = Math.max(clip, heightAt(w.level, q.x, q.z) - q.y);
        }
        if (prevY !== null) hipSpeed = Math.max(hipSpeed, Math.abs(p.pelvisPos.y - prevY) / STEP);
        prevY = p.pelvisPos.y;
      });
      expect(p.pos.y).toBeCloseTo(h, 2);
      expect(clip).toBeLessThan(0.03);
      expect(hipSpeed).toBeLessThan(3.5);
    });
  }

  it('off a 0.95 m ledge: the legs leave the ground, reach for it, and the knees give', () => {
    const w = makeWorld();
    w.box(0, 0, 3, 3, 0.95); // edge at z = 3
    const p = w.player;
    p.teleport(p.pos.clone().set(0, 0.95, 0));
    let airborne = false;
    let give = 0;
    let shortAfter = 0;
    let landed = false;
    w.advance(3, () => ({ z: 1, aimPoint: aimAhead(p) }), () => {
      if (p.airborne) airborne = true;
      if (airborne && !p.airborne) landed = true;
      give = Math.min(give, p.landDip);
      if (landed) p.feet.forEach((f, i) => f.planted && (shortAfter = Math.max(shortAfter, p.legs[i].ankle.distanceTo(p.legs[i].ankleTarget))));
    });
    expect(airborne).toBe(true);
    expect(landed).toBe(true);
    expect(p.pos.y).toBeCloseTo(0, 2);
    expect(give).toBeLessThan(-0.03);
    expect(shortAfter).toBeLessThan(0.05);
  });
});
