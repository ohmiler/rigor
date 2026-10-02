import * as THREE from 'three';

// "One night, one street": a straight road running north (+Z) from the start
// to an extraction point, walled in by buildings, cluttered with dead cars.

const ROAD_HALF = 4; // two lanes
const WALK = 2.5; // sidewalk width
const EDGE = ROAD_HALF + WALK; // building line
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
const BUILDING_COLORS = ['#6b6259', '#5a5f66', '#7a6d5d', '#4f5552', '#6e5f5a', '#5c5348', '#666a70'];
const CAR_COLORS = ['#7a2b28', '#2f4a6b', '#c9c6bd', '#3c3e42', '#6b6a3a', '#24282e', '#8a8478'];

/**
 * Builds the street into `scene`. Returns everything gameplay needs:
 * meshes bullets can hit, oriented-box colliders, the start, the goal,
 * zombie spawn points, and street lamps to switch on at night.
 */
export function buildStreet(scene) {
  const level = {
    meshes: [], // bullet raycast targets
    colliders: [], // { x, z, hx, hz, cos, sin }
    start: new THREE.Vector3(0, 0, 3),
    goal: { pos: new THREE.Vector3(0, 0, STREET_LENGTH - 6), radius: 2.6 },
    zombieSpawns: [],
    lamps: [],
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
  const collider = (x, z, hx, hz, yaw = 0) => {
    level.colliders.push({ x, z, hx, hz, cos: Math.cos(yaw), sin: Math.sin(yaw) });
  };

  // ------------------------------------------------------------ road
  const mid = STREET_LENGTH / 2;
  add(block(MATS.asphalt, ROAD_HALF * 2, 0.02, STREET_LENGTH, 0, 0.01, mid));
  for (const side of [-1, 1]) {
    add(block(MATS.sidewalk, WALK, 0.14, STREET_LENGTH, side * (ROAD_HALF + WALK / 2), 0.07, mid));
    add(block(MATS.curb, 0.18, 0.16, STREET_LENGTH, side * (ROAD_HALF + 0.09), 0.08, mid));
  }
  for (let z = 4; z < STREET_LENGTH - 2; z += 6) {
    add(block(MATS.paint, 0.14, 0.025, 2.6, 0, 0.025, z));
  }

  // ------------------------------------------------------------ buildings
  for (const side of [-1, 1]) {
    let z = -4;
    while (z < STREET_LENGTH + 4) {
      const len = rand(7, 14);
      const height = rand(4, 9.5);
      const depth = rand(8, 12);
      const color = pick(BUILDING_COLORS);
      const x = side * (EDGE + depth / 2);
      const building = add(block(mat(color), depth, height, len - 0.3, x, height / 2, z + len / 2), { solid: true });
      collider(x, z + len / 2, depth / 2, len / 2);
      // Dark shop windows along the street face.
      const face = side * (EDGE - 0.01);
      for (let wz = z + 1.5; wz < z + len - 1.5; wz += 3) {
        const win = block(MATS.glass, 0.05, 1.4, 1.8, face, 1.6, wz);
        add(win);
      }
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
  collider(0, -1.2, EDGE, 0.5);
  add(block(MATS.concrete, EDGE * 2, 4, 1.5, 0, 2, STREET_LENGTH + 0.8), { solid: true });
  collider(0, STREET_LENGTH + 0.8, EDGE, 0.75);

  // ------------------------------------------------------------ cars
  const car = (x, z, yaw, color = pick(CAR_COLORS)) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
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
    collider(x, z, 0.95, 2.2, yaw);
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
    add(block(MATS.concrete, 0.6, 0.85, 2.4, x, 0.425, z, yaw), { solid: true });
    collider(x, z, 0.3, 1.2, yaw);
  };
  barrier(-1.5, 44, 1.5);
  barrier(1.5, 44.4, 1.65);
  barrier(-3, 82, 0.2);
  barrier(3.2, 104, -0.3);
  barrier(-1.8, 106, 1.4);

  const dumpster = (x, z, yaw) => {
    add(block(MATS.dumpster, 1.1, 1.2, 2, x, 0.74, z, yaw), { solid: true });
    collider(x, z, 0.55, 1, yaw);
  };
  dumpster(-5.2, 26, 0);
  dumpster(5.3, 47, 0.1);
  dumpster(-5.4, 71, -0.08);
  dumpster(5.2, 99, 0);

  // Street lamps; a few still work and light the road at night.
  for (let z = 10; z < STREET_LENGTH - 4; z += 18) {
    for (const side of [-1, 1]) {
      const x = side * (ROAD_HALF + 0.6);
      const lz = z + (side > 0 ? 9 : 0);
      add(block(MATS.pole, 0.14, 5, 0.14, x, 2.5 + 0.14, lz));
      add(block(MATS.pole, 1.2, 0.12, 0.25, x - side * 0.55, 5.1, lz));
      collider(x, lz, 0.12, 0.12);
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

  // ------------------------------------------------------------ zombies
  // Scattered down the street, thicker toward the end.
  for (let i = 0; i < 22; i++) {
    const t = Math.pow(Math.random(), 0.8);
    const z = 16 + t * (STREET_LENGTH - 24);
    level.zombieSpawns.push(new THREE.Vector3(rand(-EDGE + 0.8, EDGE - 0.8), 0, z));
  }

  return level;
}

// Push a circle at `pos` (x, z) out of every oriented box.
export function collideCircle(level, pos, radius) {
  for (const c of level.colliders) {
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
    const dx = x - c.x;
    const dz = z - c.z;
    const lx = dx * c.cos - dz * c.sin;
    const lz = dx * c.sin + dz * c.cos;
    return Math.abs(lx) < c.hx + margin && Math.abs(lz) < c.hz + margin;
  });
}
