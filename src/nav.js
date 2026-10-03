import * as THREE from 'three';
import { STEP_UP } from './rig-utils.js';
import { contains } from './level.js';

// How zombies find their way round cars, barriers and dumpsters to you.
//
// The street is a grid of small cells; a cell is blocked if anything taller
// than a step stands on it (with a margin for a body's width). Toward a
// target, a flow field is built once (Dijkstra from the target outward, so
// every cell knows how far it is from the target the long way round) and
// every zombie heading there just reads it: no per-zombie path search. A
// zombie that can see its target in a straight line walks straight at it;
// otherwise it heads for a point a couple of metres down the field that it
// can see, so the path curves round obstacles instead of zig-zagging cell to
// cell. The street doesn't change, so a field depends only on its target
// cell: the last few are kept, and one is built only when a target moves into
// a cell that has none.

const _c = new THREE.Vector3();
const NI = [1, -1, 0, 0, 1, 1, -1, -1];
const NJ = [0, 0, 1, -1, 1, -1, 1, -1];
const NCOST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

export class NavGrid {
  /**
   * @param {{ colliders: any[] }} level
   * @param {{ minX: number, maxX: number, minZ: number, maxZ: number }} bounds
   */
  constructor(level, bounds, { cell = 0.35, margin = 0.3, range = 45 } = {}) {
    this.cell = cell;
    this.maxCost = range / cell; // fields stop this far out (metres of path)
    this.minX = bounds.minX;
    this.minZ = bounds.minZ;
    this.w = Math.ceil((bounds.maxX - bounds.minX) / cell);
    this.h = Math.ceil((bounds.maxZ - bounds.minZ) / cell);
    this.blocked = new Uint8Array(this.w * this.h);
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        const x = this.minX + (i + 0.5) * cell;
        const z = this.minZ + (j + 0.5) * cell;
        for (const c of level.colliders) {
          // Floor (a kerb, the sidewalk) is walkable; anything taller blocks.
          if (c.top <= STEP_UP || c.floor) continue;
          if (contains(c, x, z, margin)) {
            this.blocked[j * this.w + i] = 1;
            break;
          }
        }
      }
    }
    this.fields = new Map(); // target cell -> distances to it, oldest first
    this.keep = 8;
    this.heap = new Int32Array(this.w * this.h * 4);
    this.heapCost = new Float32Array(this.w * this.h * 4);
  }

  index(x, z) {
    const i = Math.floor((x - this.minX) / this.cell);
    const j = Math.floor((z - this.minZ) / this.cell);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return -1;
    return j * this.w + i;
  }

  centre(idx, out) {
    const i = idx % this.w;
    const j = (idx - i) / this.w;
    return out.set(this.minX + (i + 0.5) * this.cell, 0, this.minZ + (j + 0.5) * this.cell);
  }

  isFree(x, z) {
    const k = this.index(x, z);
    return k >= 0 && !this.blocked[k];
  }

  // Nothing tall between a and b (walking the cells the line passes over).
  clear(a, b) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const steps = Math.ceil(len / (this.cell * 0.5));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const k = this.index(a.x + dx * t, a.z + dz * t);
      if (k < 0 || this.blocked[k]) return false;
    }
    return true;
  }

  // Distances to `target` from every cell, the long way round.
  field(target) {
    const k = this.index(target.x, target.z);
    if (k < 0) return null;
    let dist = this.fields.get(k);
    if (dist) {
      this.fields.delete(k); // most recently used goes to the back
      this.fields.set(k, dist);
      return dist;
    }
    if (this.fields.size >= this.keep) {
      const oldest = this.fields.keys().next().value;
      dist = this.fields.get(oldest);
      this.fields.delete(oldest);
    } else {
      dist = new Float32Array(this.w * this.h);
    }
    dist.fill(Infinity);
    this.builds = (this.builds ?? 0) + 1;
    // A target on top of something (you, on a car roof) is reached from the
    // free cells around it.
    const sources = [];
    if (!this.blocked[k]) sources.push(k);
    else {
      const reach = Math.ceil(2.6 / this.cell);
      const ti = k % this.w;
      const tj = (k - ti) / this.w;
      for (let dj = -reach; dj <= reach; dj++) {
        for (let di = -reach; di <= reach; di++) {
          const i = ti + di;
          const j = tj + dj;
          if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
          const n = j * this.w + i;
          if (!this.blocked[n]) sources.push(n);
        }
      }
    }
    this._dijkstra(dist, sources);
    this.fields.set(k, dist);
    return dist;
  }

  _dijkstra(dist, sources) {
    // A binary heap of (cell, cost); a cell may sit in it more than once.
    const heap = this.heap;
    const cost = this.heapCost;
    let n = 0;
    const push = (idx, c) => {
      let i = n++;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (cost[parent] <= c) break;
        heap[i] = heap[parent];
        cost[i] = cost[parent];
        i = parent;
      }
      heap[i] = idx;
      cost[i] = c;
    };
    const pop = () => {
      const top = heap[0];
      const last = heap[--n];
      const lc = cost[n];
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && cost[child + 1] < cost[child]) child++;
        if (cost[child] >= lc) break;
        heap[i] = heap[child];
        cost[i] = cost[child];
        i = child;
      }
      heap[i] = last;
      cost[i] = lc;
      return top;
    };
    for (const s of sources) {
      dist[s] = 0;
      push(s, 0);
    }
    const w = this.w;
    const h = this.h;
    const blocked = this.blocked;
    const maxCost = this.maxCost;
    while (n > 0 && n < heap.length - 8) {
      const c = cost[0];
      const k = pop();
      if (c > dist[k]) continue;
      if (c > maxCost) break;
      const i = k % w;
      const j = (k - i) / w;
      for (let e = 0; e < 8; e++) {
        const di = NI[e];
        const dj = NJ[e];
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const nk = nj * w + ni;
        if (blocked[nk]) continue;
        // No cutting corners past a blocked cell.
        if (e >= 4 && (blocked[j * w + ni] || blocked[nj * w + i])) continue;
        const nd = c + NCOST[e];
        if (nd < dist[nk]) {
          dist[nk] = nd;
          push(nk, nd);
        }
      }
    }
  }

  /**
   * Where a body at `from` should head to reach `target`: the target itself
   * if it can see it, else a point down the flow field it can see (up to
   * `ahead` metres along). Returns false if there's no way (keep going
   * straight), true with `out` set otherwise.
   */
  steer(from, target, out, ahead = 2.5) {
    if (this.clear(from, target)) {
      out.copy(target);
      return true;
    }
    const f = this.field(target);
    if (!f) return false;
    const k = this.index(from.x, from.z);
    if (k < 0) return false;
    // Standing in a blocked cell (squeezed against a car): step to the
    // nearest free neighbour that's on the field.
    if (this.blocked[k] || f[k] === Infinity) {
      let best = -1;
      let bestD = Infinity;
      const i = k % this.w;
      const j = (k - i) / this.w;
      for (let dj = -2; dj <= 2; dj++) {
        for (let di = -2; di <= 2; di++) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= this.w || nj >= this.h) continue;
          const nk = nj * this.w + ni;
          if (!this.blocked[nk] && f[nk] < bestD) {
            bestD = f[nk];
            best = nk;
          }
        }
      }
      if (best < 0) return false;
      this.centre(best, out);
      return true;
    }
    // Walk downhill on the field, keeping the furthest cell still in sight.
    const steps = Math.ceil(ahead / this.cell);
    const c = _c;
    let seen = -1;
    let cur = k;
    for (let s = 0; s < steps; s++) {
      const i = cur % this.w;
      const j = (cur - i) / this.w;
      let next = -1;
      let nd = f[cur];
      for (let e = 0; e < 8; e++) {
        const ni = i + NI[e];
        const nj = j + NJ[e];
        if (ni < 0 || nj < 0 || ni >= this.w || nj >= this.h) continue;
        const nk = nj * this.w + ni;
        if (f[nk] < nd) {
          nd = f[nk];
          next = nk;
        }
      }
      if (next < 0) break; // arrived
      cur = next;
      if (this.clear(from, this.centre(cur, c))) seen = cur;
      else if (seen >= 0) break;
    }
    if (seen < 0) seen = cur;
    this.centre(seen, out);
    return true;
  }
}
