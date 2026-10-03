import { beforeEach } from 'vitest';

// Every test runs on the same dice: Math.random is a seeded generator, reset
// before each test, so a failure can be reproduced exactly.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeEach(() => {
  Math.random = mulberry32(1234);
});
