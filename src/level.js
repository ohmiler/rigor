import * as THREE from 'three';
import { STEP_UP } from './rig-utils.js';

// "One night, one street": a straight road running north (+Z) from the start
// to an extraction point, walled in by buildings, cluttered with dead cars.

const ROAD_HALF = 4; // two lanes
const WALK = 2.5; // sidewalk width
const EDGE = ROAD_HALF + WALK; // building line
export const STREET_EDGE = EDGE;
export const STREET_LENGTH = 116;

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

const mat = (color, roughness = 0.85, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, ...extra });

const MATS = {
  asphalt: mat('#2a2c30', 0.95),
  sidewalk: mat('#5d5f63', 0.95),
  curb: mat('#77797d', 0.9),
  paint: mat('#c9c4a8', 0.8),
  concrete: mat('#8d8a83', 0.95),
  dumpster: mat('#2f4a3a', 0.7),
  pole: mat('#3a3c40', 0.6),
  tire: mat('#151515', 0.9),
  glass: mat('#1c2530', 0.25, { metalness: 0.3 }),
};
// Yaowarat's shophouses: faded cream, ochre, mint, salmon, the odd grey.
const BUILDING_COLORS = ['#b8a98a', '#a8925f', '#8fa08c', '#b08a78', '#9a8f7a', '#7d8a8c', '#a37f5c'];
const CAR_COLORS = ['#7a2b28', '#2f4a6b', '#c9c6bd', '#3c3e42', '#6b6a3a', '#24282e', '#8a8478'];

/**
 * Builds the street into `scene`. Returns everything gameplay needs:
 * meshes bullets can hit, oriented-box colliders, the start, the goal,
 * zombie spawn points, and street lamps to switch on at night.
 */
export function buildStreet(scene) {
  const level = {
    meshes: [], // bullet raycast targets
    colliders: [], // { x, z, hx, hz, cos, sin, top, climb, vault }
    start: new THREE.Vector3(0, 0, 3),
    goal: { pos: new THREE.Vector3(0, 0, STREET_LENGTH - 6), radius: 2.6 },
    zombieSpawns: [],
    pickupSpots: [], // { type: 'ammo' | 'medkit', pos }
    lamps: [],
    props: { car: [], dumpster: [], barrier: [], stall: [], tables: [], tuktuk: [], gate: [] }, // where the Blender models go (props.js)
    buildings: [], // street fronts to dress (props.js)
    goalParts: null,
  };
  const root = new THREE.Group();
  scene.add(root);
  level.root = root;

  const add = (mesh, { solid = false, shootable = solid } = {}) => {
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
    if (shootable) level.meshes.push(mesh);
    return mesh;
  };
  const block = (material, w, h, d, x, y, z, yaw = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.rotation.y = yaw;
    return mesh;
  };
  // `top` is the walkable height of the box; `climb` means you can get up on
  // it, `vault` means you go over it instead; `floor` is ground you simply
  // step up onto (it never blocks a spawn).
  const collider = (x, z, hx, hz, yaw = 0, { top = 10, climb = false, vault = false, floor = false } = {}) => {
    level.colliders.push({ x, z, hx, hz, cos: Math.cos(yaw), sin: Math.sin(yaw), top, climb, vault, floor });
  };

  // ------------------------------------------------------------ road
  const mid = STREET_LENGTH / 2;
  add(block(MATS.asphalt, ROAD_HALF * 2, 0.02, STREET_LENGTH, 0, 0.01, mid));
  for (const side of [-1, 1]) {
    add(block(MATS.sidewalk, WALK, 0.14, STREET_LENGTH, side * (ROAD_HALF + WALK / 2), 0.07, mid));
    add(block(MATS.curb, 0.18, 0.16, STREET_LENGTH, side * (ROAD_HALF + 0.09), 0.08, mid));
    collider(side * (ROAD_HALF + WALK / 2), mid, WALK / 2, STREET_LENGTH / 2, 0, { top: 0.14, floor: true });
    collider(side * (ROAD_HALF + 0.09), mid, 0.09, STREET_LENGTH / 2, 0, { top: 0.16, floor: true });
  }
  for (let z = 4; z < STREET_LENGTH - 2; z += 6) {
    add(block(MATS.paint, 0.14, 0.025, 2.6, 0, 0.025, z));
  }

  // ------------------------------------------------------------ buildings
  for (const side of [-1, 1]) {
    let z = -4;
    while (z < STREET_LENGTH + 4) {
      const len = rand(7, 14);
      // Whole storeys: a 3.6 m shop floor and 3 m floors above (props.js
      // fits the fronts to them).
      const floors = Math.round(THREE.MathUtils.clamp((rand(4, 9.5) - 3.6) / 3, 0, 2));
      const height = 3.6 + 3 * floors;
      const depth = rand(8, 12);
      const color = pick(BUILDING_COLORS);
      const x = side * (EDGE + depth / 2);
      const building = add(block(mat(color), depth, height, len - 0.3, x, height / 2, z + len / 2), { solid: true });
      collider(x, z + len / 2, depth / 2, len / 2, 0, { top: height });
      // Dark shop windows along the street face (until the modelled front arrives).
      const face = side * (EDGE - 0.01);
      const windows = [];
      for (let wz = z + 1.5; wz < z + len - 1.5; wz += 3) {
        windows.push(add(block(MATS.glass, 0.05, 1.4, 1.8, face, 1.6, wz)));
      }
      level.buildings.push({ side, z0: z, len, floors, height, depth, color, standIns: windows });
      // Some buildings are set back, leaving a recess zombies like to wait in.
      if (Math.random() < 0.25 && z > 12 && z < STREET_LENGTH - 16) {
        level.zombieSpawns.push(new THREE.Vector3(side * (EDGE - 0.8), 0, z + len / 2));
      }
      building.userData.isBuilding = true;
      z += len;
    }
  }
  // End caps: a wall behind the start and a collapsed overpass past the goal.
  add(block(MATS.concrete, EDGE * 2, 3, 1, 0, 1.5, -1.2), { solid: true });
  collider(0, -1.2, EDGE, 0.5, 0, { top: 3 });
  add(block(MATS.concrete, EDGE * 2, 4, 1.5, 0, 2, STREET_LENGTH + 0.8), { solid: true });
  collider(0, STREET_LENGTH + 0.8, EDGE, 0.75, 0, { top: 4 });

  // ------------------------------------------------------------ cars
  const car = (x, z, yaw, color = pick(CAR_COLORS)) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
    level.props.car.push({ x, z, yaw, color, standIns: [g] });
    const paint = mat(color, 0.55, { metalness: 0.2 });
    const body = block(paint, 1.8, 0.7, 4.3, 0, 0.6, 0);
    const cabin = block(paint, 1.62, 0.55, 2.2, 0, 1.22, -0.2);
    const windows = block(MATS.glass, 1.64, 0.4, 2.0, 0, 1.24, -0.2);
    for (const m of [body, cabin, windows]) {
      m.castShadow = m.receiveShadow = true;
      g.add(m);
    }
    for (const [wx, wz] of [[-0.85, 1.4], [0.85, 1.4], [-0.85, -1.4], [0.85, -1.4]]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 14), MATS.tire);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(wx, 0.34, wz);
      wheel.castShadow = true;
      g.add(wheel);
    }
    root.add(g);
    level.meshes.push(body, cabin);
    // Hood/trunk level, and the roof on top of it (offset back like the cabin).
    collider(x, z, 0.95, 2.2, yaw, { top: 0.95, climb: true });
    collider(x - 0.2 * Math.sin(yaw), z - 0.2 * Math.cos(yaw), 0.81, 1.1, yaw, { top: 1.5, climb: true });
  };
  // Hand-placed so the street reads as a story: a pile-up, a jam, strays.
  car(-2, 14, 0.15);
  car(2.3, 21, -0.05);
  car(-1.2, 33, 0.9); // spun out across the lane
  car(1.6, 36.5, -0.6); // rear-ended it
  car(-2.4, 50, 0.05);
  car(2.1, 58, 3.1);
  car(-2.2, 64, 0.1);
  car(0.3, 76, 1.45); // sideways, blocking most of the road
  car(2.6, 89, -0.2);
  car(-2.3, 96, 0.3);

  // ------------------------------------------------------------ clutter
  const barrier = (x, z, yaw) => {
    const mesh = add(block(MATS.concrete, 0.6, 0.85, 2.4, x, 0.425, z, yaw), { solid: true });
    level.props.barrier.push({ x, z, yaw, standIns: [mesh] });
    collider(x, z, 0.3, 1.2, yaw, { top: 0.85, climb: true, vault: true });
  };
  barrier(-1.5, 44, 1.5);
  barrier(1.5, 44.4, 1.65);
  barrier(-3, 82, 0.2);
  barrier(3.2, 104, -0.3);
  barrier(-1.8, 106, 1.4);

  const dumpster = (x, z, yaw) => {
    const mesh = add(block(MATS.dumpster, 1.1, 1.2, 2, x, 0.74, z, yaw), { solid: true });
    level.props.dumpster.push({ x, z, yaw, standIns: [mesh] });
    collider(x, z, 0.55, 1, yaw, { top: 1.34, climb: true });
  };
  dumpster(-5.2, 26, 0);
  dumpster(5.3, 47, 0.1);
  dumpster(-5.4, 71, -0.08);
  dumpster(5.2, 99, 0);

  // Yaowarat's night market, abandoned: food carts along the kerb (up on
  // one, out of reach for a moment) and folding tables to vault. Placed by
  // hand, clear of the lamps, bins and supplies.
  const STALL_COLORS = ['#3a6b8a', '#b5462f', '#d8b23a', '#3f7a4f', '#c9c6bd'];
  const stall = (x, z, color) => {
    const mesh = add(block(MATS.dumpster, 0.8, 1.0, 1.5, x, 0.5, z), { solid: true });
    level.props.stall.push({ x, z, yaw: 0, color, standIns: [mesh] });
    collider(x, z, 0.4, 0.75, 0, { top: 1.0, climb: true });
  };
  const tables = (x, z, yaw = 0) => {
    const mesh = add(block(MATS.concrete, 0.7, 0.75, 1.2, x, 0.375, z, yaw), { solid: true });
    level.props.tables.push({ x, z, yaw, standIns: [mesh] });
    collider(x, z, 0.35, 0.6, yaw, { top: 0.75, climb: true, vault: true });
  };
  // Tuk-tuks left among the cars: up on the canopy is the highest perch on
  // the street short of a dumpster.
  const tuktuk = (x, z, yaw, color) => {
    const mesh = add(block(MATS.dumpster, 1.3, 1.75, 2.6, x, 0.875, z, yaw), { solid: true });
    level.props.tuktuk.push({ x, z, yaw, color, standIns: [mesh] });
    collider(x, z, 0.65, 1.3, yaw, { top: 1.75, climb: true });
  };
  // The Chinatown gate across the end of the street, behind the extraction
  // point: where you hold out for the helicopter. Its pillars are solid.
  const GATE_Z = STREET_LENGTH - 1.2;
  const gateBoxes = [];
  for (const [x, w, h] of [[-4.6, 0.7, 6.6], [4.6, 0.7, 6.6], [-6.0, 0.5, 4.8], [6.0, 0.5, 4.8]]) {
    gateBoxes.push(add(block(MATS.concrete, w, h, w, x, h / 2, GATE_Z), { solid: true }));
    collider(x, GATE_Z, w / 2 + 0.05, w / 2 + 0.05, 0, { top: h });
  }
  level.props.gate.push({ x: 0, z: GATE_Z, yaw: 0, standIns: gateBoxes });

  tuktuk(1.9, 27.5, 0.25, '#1f6fb5');
  tuktuk(2.4, 70, 3.0, '#2f8a3a');
  tuktuk(-2.6, 101, -0.15, '#d94a1f');

  stall(-5.2, 19.5, STALL_COLORS[0]);
  tables(-5.1, 22);
  stall(5.3, 31, STALL_COLORS[1]);
  stall(-5.2, 53, STALL_COLORS[2]);
  tables(-5.1, 55.5, 0.2);
  stall(5.3, 63, STALL_COLORS[3]);
  tables(5.1, 65.5, -0.15);
  stall(-5.2, 79, STALL_COLORS[4]);
  stall(5.3, 84, STALL_COLORS[1]);
  tables(5.1, 86.5);

  // Street lamps; a few still work and light the road at night.
  for (let z = 10; z < STREET_LENGTH - 4; z += 18) {
    for (const side of [-1, 1]) {
      const x = side * (ROAD_HALF + 0.6);
      const lz = z + (side > 0 ? 9 : 0);
      add(block(MATS.pole, 0.14, 5, 0.14, x, 2.5 + 0.14, lz));
      add(block(MATS.pole, 1.2, 0.12, 0.25, x - side * 0.55, 5.1, lz));
      collider(x, lz, 0.12, 0.12, 0, { top: 5 });
      if (Math.random() < 0.55) {
        const light = new THREE.PointLight('#ffb866', 0, 11, 1.4);
        light.position.set(x - side * 1.0, 4.9, lz);
        root.add(light);
        const bulb = block(new THREE.MeshBasicMaterial({ color: '#ffd59a' }), 0.3, 0.06, 0.2, x - side * 1.0, 5.03, lz);
        root.add(bulb);
        level.lamps.push({ light, bulb });
      }
    }
  }

  // ------------------------------------------------------------ goal
  const goalRing = new THREE.Mesh(
    new THREE.RingGeometry(level.goal.radius - 0.25, level.goal.radius, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: '#5dff9b', transparent: true, opacity: 0.8 }),
  );
  goalRing.position.copy(level.goal.pos).setY(0.04);
  const goalDisc = new THREE.Mesh(
    new THREE.CircleGeometry(level.goal.radius, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: '#5dff9b', transparent: true, opacity: 0.12, depthWrite: false }),
  );
  goalDisc.position.copy(level.goal.pos).setY(0.035);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.6, 30, 16, 1, true),
    new THREE.MeshBasicMaterial({
      color: '#5dff9b',
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  beam.position.copy(level.goal.pos).setY(15);
  const flare = new THREE.PointLight('#5dff9b', 6, 14, 1.5);
  flare.position.copy(level.goal.pos).setY(0.6);
  root.add(goalRing, goalDisc, beam, flare);
  level.goalParts = { goalRing, goalDisc, beam, flare };

  // ------------------------------------------------------------ supplies
  // Where ammo and medkits can turn up (pickups.js rolls which do each run).
  // The best ones are up on car roofs and dumpster lids: worth the climb, and
  // a moment out of reach while you take them.
  const supply = (type, x, z) => level.pickupSpots.push({ type, pos: new THREE.Vector3(x, heightAt(level, x, z), z) });
  supply('ammo', -2.03, 13.8); // roof of the first car: learn to climb for it
  supply('ammo', -5.4, 28.6); // behind the first dumpster
  supply('medkit', 5.0, 37); // sidewalk by the pile-up
  supply('ammo', 0, 45.8); // past the barrier line
  supply('ammo', 5.3, 47); // dumpster lid
  supply('ammo', 2.09, 58.2); // car roof
  supply('medkit', -5.3, 66);
  supply('ammo', 3.8, 78.6); // round the back of the sideways car
  supply('ammo', 5.2, 91);
  supply('medkit', 5.2, 99); // dumpster lid
  supply('ammo', 0.5, 105.2); // between the last barriers
  // Empty bottles to throw.
  supply('bottle', 5.6, 18);
  supply('bottle', -5.6, 40);
  supply('bottle', 2.9, 52); // in the road by the car
  supply('bottle', 5.5, 72);
  supply('bottle', -5.5, 86);

  // ------------------------------------------------------------ zombies
  // Scattered down the street, thicker toward the end.
  for (let i = 0; i < 22; i++) {
    const t = Math.pow(Math.random(), 0.8);
    const z = 16 + t * (STREET_LENGTH - 24);
    level.zombieSpawns.push(new THREE.Vector3(rand(-EDGE + 0.8, EDGE - 0.8), 0, z));
  }

  return level;
}

// World point -> box space (three.js Y rotation).
function toLocal(c, x, z) {
  const dx = x - c.x;
  const dz = z - c.z;
  return [dx * c.cos - dz * c.sin, dx * c.sin + dz * c.cos];
}

export function contains(c, x, z, margin = 0) {
  const [lx, lz] = toLocal(c, x, z);
  return Math.abs(lx) <= c.hx + margin && Math.abs(lz) <= c.hz + margin;
}

// Is this point inside something solid (below an obstacle's top)?
export function solidAt(level, p) {
  if (p.y < 0.02) return false;
  for (const c of level.colliders) {
    if (p.y < c.top && contains(c, p.x, p.z)) return true;
  }
  return false;
}

// Height of the walkable surface under (x, z), ignoring anything taller than
// `maxY` (a wall you're beside isn't a floor you're on).
export function heightAt(level, x, z, maxY = Infinity) {
  let h = 0;
  for (const c of level.colliders) {
    if (c.top > h && c.top <= maxY && contains(c, x, z)) h = c.top;
  }
  return h;
}

/**
 * Something to vault or climb directly ahead of `pos` along ground direction
 * `dir`. Returns { type: 'vault' | 'climb', top, edge, end, dir } or null.
 * `edge` is where the hands go (on the top surface at the near edge) and
 * `end` is where the feet finish.
 */
// Face the obstacle: a move that meets a face within 60 degrees of square is
// turned to go straight at it, so feet and knees meet the face the way the
// keys assume. Steeper than that, the move keeps the way you were heading.
function squareUp(c, pos, dir) {
  const [lx, lz] = toLocal(c, pos.x, pos.z);
  const alongX = Math.abs(lx) - c.hx > Math.abs(lz) - c.hz;
  // Only when the straight line to the face still lands on it, not past its end.
  if (Math.abs(alongX ? lz : lx) > (alongX ? c.hz : c.hx) - 0.3) return dir;
  const nx = alongX ? -Math.sign(lx) : 0;
  const nz = alongX ? 0 : -Math.sign(lz);
  // Box space -> world.
  const wx = nx * c.cos + nz * c.sin;
  const wz = -nx * c.sin + nz * c.cos;
  return wx * dir.x + wz * dir.z > 0.5 ? new THREE.Vector3(wx, 0, wz) : dir;
}

export function findLedge(level, pos, dir0) {
  const feet = pos.y;
  for (const reach of [0.35, 0.55, 0.8]) {
    const px = pos.x + dir0.x * reach;
    const pz = pos.z + dir0.z * reach;
    for (let c of level.colliders) {
      const rise = c.top - feet;
      if (!c.climb || rise < 0.35 || rise > 1.6 || !contains(c, px, pz)) continue;
      const dir = squareUp(c, pos, dir0);
      // Ignore boxes we're already standing on top of.
      if (heightAt(level, px, pz, feet + STEP_UP) > feet + 0.05) continue;

      // Walk back to the exact near edge so hands land on the lip, not inside.
      let near = 0;
      while (near < reach && !contains(c, pos.x + dir.x * near, pos.z + dir.z * near)) near += 0.03;
      let ex0 = pos.x + dir.x * near;
      let ez0 = pos.z + dir.z * near;

      // A lip too narrow to stand on, right below a higher surface (a car's
      // sill under its roof): grab the higher edge and climb straight onto it.
      if (!c.vault) {
        for (const o of level.colliders) {
          if (o === c || !o.climb || o.top <= c.top || o.top - c.top > STEP_UP || o.top - feet > 1.7) continue;
          let d = 0;
          while (d < 0.35 && !contains(o, ex0 + dir.x * d, ez0 + dir.z * d)) d += 0.03;
          if (d < 0.35) {
            ex0 += dir.x * d;
            ez0 += dir.z * d;
            c = o;
            break;
          }
        }
      }
      const edge = new THREE.Vector3(ex0, c.top, ez0);

      // How thick is it along our direction? Thin and low means go over.
      let through = 0;
      while (through < 3 && contains(c, ex0 + dir.x * (through + 0.03), ez0 + dir.z * (through + 0.03))) through += 0.05;
      if (c.vault && through <= 1.2 && rise <= 1.1) {
        const ex = ex0 + dir.x * (through + 0.55);
        const ez = ez0 + dir.z * (through + 0.55);
        const landY = heightAt(level, ex, ez, feet + STEP_UP);
        const blocked = level.colliders.some((o) => o.top > landY + STEP_UP && contains(o, ex, ez, 0.3));
        if (!blocked) {
          return { type: 'vault', top: c.top, edge, through, end: new THREE.Vector3(ex, landY, ez), dir: dir.clone() };
        }
      }
      // Otherwise climb up and stand on it, a little in from the edge.
      const step = Math.min(0.5, Math.max(through - 0.15, 0.15));
      const end = new THREE.Vector3(ex0 + dir.x * step, 0, ez0 + dir.z * step);
      // Finish on whatever is walkable from this top: a car's side lip leads
      // straight up onto its roof rather than leaving you pressed to the glass.
      end.y = heightAt(level, end.x, end.z, c.top + STEP_UP);
      return { type: 'climb', top: c.top, edge, through, end, dir: dir.clone() };
    }
  }
  return null;
}

// Push a circle at `pos` (x, z) out of every box taller than a step from
// `feetY`. Things below that height are floor, not walls.
export function collideCircle(level, pos, radius, feetY = 0, stepUp = STEP_UP) {
  for (const c of level.colliders) {
    if (c.top <= feetY + stepUp) continue;
    const dx = pos.x - c.x;
    const dz = pos.z - c.z;
    // World -> box space (three.js Y rotation).
    const lx = dx * c.cos - dz * c.sin;
    const lz = dx * c.sin + dz * c.cos;
    if (Math.abs(lx) > c.hx + radius || Math.abs(lz) > c.hz + radius) continue;
    const cx = THREE.MathUtils.clamp(lx, -c.hx, c.hx);
    const cz = THREE.MathUtils.clamp(lz, -c.hz, c.hz);
    let ux = lx - cx;
    let uz = lz - cz;
    let d = Math.hypot(ux, uz);
    let push;
    if (d > 1e-6) {
      if (d >= radius) continue;
      ux /= d;
      uz /= d;
      push = radius - d;
    } else {
      // Centre inside the box: leave by the shallowest side.
      const px = c.hx - Math.abs(lx);
      const pz = c.hz - Math.abs(lz);
      if (px < pz) {
        ux = Math.sign(lx) || 1;
        uz = 0;
        push = px + radius;
      } else {
        ux = 0;
        uz = Math.sign(lz) || 1;
        push = pz + radius;
      }
    }
    // Box space -> world.
    pos.x += (ux * c.cos + uz * c.sin) * push;
    pos.z += (-ux * c.sin + uz * c.cos) * push;
  }
}

export function insideCollider(level, x, z, margin) {
  return level.colliders.some((c) => {
    if (c.floor) return false;
    const dx = x - c.x;
    const dz = z - c.z;
    const lx = dx * c.cos - dz * c.sin;
    const lz = dx * c.sin + dz * c.cos;
    return Math.abs(lx) < c.hx + margin && Math.abs(lz) < c.hz + margin;
  });
}
