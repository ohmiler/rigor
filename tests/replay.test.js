import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeWorld, STEP } from './world.js';
import { Recorder, Playback, mulberry32, fingerprint } from '../src/replay.js';

// A short fight under one seed: zombies coming in, the player firing.
function fight(seed, inputAt) {
  const real = Math.random;
  Math.random = mulberry32(seed);
  try {
    const w = makeWorld({ zparams: { detectRange: 30 } });
    for (let i = 0; i < 4; i++) w.addZombie(-3 + i * 2, 7 + Math.random() * 3);
    const prints = [];
    w.advance(4, inputAt, (t) => {
      if (Math.round(t / STEP) % 60 === 0) {
        prints.push(fingerprint([w.player.pos.x, w.player.pos.z, w.player.health, ...w.zombies.flatMap((z) => [z.pos.x, z.pos.z, z.health])]));
      }
    });
    return prints;
  } finally {
    Math.random = real;
  }
}

const aim = new THREE.Vector3(0, 1.3, 8);
const firing = (t) => ({ fire: t > 0.5, z: t < 2 ? 0.3 : 0, aimPoint: aim });

describe('replays', () => {
  it('the same seed and input give the same fight, step for step', () => {
    const a = fight(42, firing);
    const b = fight(42, firing);
    expect(a.length).toBeGreaterThan(5);
    expect(b).toEqual(a);
    expect(fight(43, firing)).not.toEqual(a); // and a different seed doesn't
  });

  it('what is recorded is what plays back', () => {
    const rec = new Recorder(7, { params: {} });
    const inputs = [];
    for (let s = 0; s < 300; s++) {
      const input = { x: s > 100 ? 1 : 0, z: 1, walk: false, sprint: s > 200, fire: s % 50 < 10, jump: s === 20, aimPoint: s < 150 ? new THREE.Vector3(1, 1.2, 3 + Math.floor(s / 10)) : null };
      const cmds = s === 60 ? [['reload']] : s === 61 ? [['throw', 1, 1.2, 5]] : [];
      const dt = s > 250 ? STEP * 0.3 : STEP;
      rec.record(dt, input, cmds);
      inputs.push({ dt, input: { ...input, aimPoint: input.aimPoint?.clone() ?? null }, cmds });
      if (rec.step % 120 === 0) rec.check(`f${rec.step}`);
    }
    const data = JSON.parse(JSON.stringify(rec)); // through a file and back
    expect(data.inputs.length).toBeLessThan(60); // stored on change only

    const pb = new Playback(data);
    for (const want of inputs) {
      const got = pb.next();
      expect(got.dt).toBe(want.dt);
      expect(got.cmds).toEqual(want.cmds);
      const { aimPoint, ...rest } = got.input;
      const { aimPoint: wantAim, ...wantRest } = want.input;
      expect(rest).toEqual(wantRest);
      expect(aimPoint?.toArray() ?? null).toEqual(wantAim?.toArray() ?? null);
      pb.verify(`f${pb.step}`);
    }
    expect(pb.done).toBe(true);
    expect(pb.desync).toBe(null);
  });

  it('a replay that stops matching says where', () => {
    const rec = new Recorder(1);
    for (let s = 0; s < 360; s++) {
      rec.record(STEP, { x: 0, z: 0 }, []);
      if (rec.step % 120 === 0) rec.check(`f${rec.step}`);
    }
    const pb = new Playback(JSON.parse(JSON.stringify(rec)));
    while (!pb.done) {
      pb.next();
      if (pb.step % 120 === 0) pb.verify(pb.step === 240 ? 'wrong' : `f${pb.step}`);
    }
    expect(pb.desync).toBe(240);
  });

  it('refuses a file that is not a replay', () => {
    expect(() => new Playback({ hello: 1 })).toThrow();
    expect(() => new Playback({ game: 'rigor', version: 99, inputs: [] })).toThrow(/version/);
  });
});
