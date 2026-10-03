import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from './replay.js';

// Street props modelled in Blender (art/build_props.py, rebuilt with
// `npm run models`) dressed over the boxes level.js builds. The boxes stay
// as they are for gameplay, hidden: what bullets hit, and the shape the
// colliders were made from. If a model fails to load, its boxes just show.

/**
 * @param {{ props: Record<string, Array<{ x: number, z: number, yaw: number, standIns: import('three').Object3D[], color?: string }>>, buildings: any[], windowLights?: THREE.MeshStandardMaterial[] }} level
 * @returns {Promise<void>} once every model is in (or has failed)
 */
export function dressProps(level) {
  const loader = new GLTFLoader();
  const base = import.meta.env.BASE_URL;
  const street = loader
    .loadAsync(`${base}models/street.glb`)
    .then((gltf) => dressStreet(level, gltf.scene))
    .catch((e) => console.warn('RIGOR: street fronts not loaded, keeping plain buildings', e));
  return Promise.all([
    street,
    ...Object.entries(level.props).map(([name, slots]) =>
      loader
        .loadAsync(`${base}models/${name}.glb`)
        .then((gltf) => {
          for (const slot of slots) {
            const model = gltf.scene.clone(true);
            model.position.set(slot.x, 0, slot.z);
            model.rotation.y = slot.yaw;
            model.traverse((o) => {
              if (!(/** @type {any} */ (o).isMesh)) return;
              const mesh = /** @type {import('three').Mesh} */ (o);
              mesh.castShadow = mesh.receiveShadow = true;
              // Each car its own colour.
              const m = /** @type {import('three').MeshStandardMaterial} */ (mesh.material);
              if (slot.color && m.name === 'Paint') {
                mesh.material = m.clone();
                /** @type {import('three').MeshStandardMaterial} */ (mesh.material).color.set(slot.color);
              }
            });
            slot.standIns[0].parent.add(model);
            for (const s of slot.standIns) s.visible = false;
          }
        })
        .catch((e) => console.warn(`RIGOR: ${name} model not loaded, keeping boxes`, e)),
    ),
  ]).then(() => {});
}

// ---------------------------------------------------------------- street fronts

const EDGE = 6.5; // the building line (level.js)
const SIGNS = ['#7a2b28', '#2f4a6b', '#3c5a3a', '#7a5a22', '#4a2f5a', '#2a2a2a', '#8a3d1f'];
const AWNINGS = ['#2f4a6b', '#6b2b2b', '#3c5a3a', '#7a6a3a', '#3a3a40'];

const weighted = (rnd, table) => {
  let r = rnd() * table.reduce((n, [, w]) => n + w, 0);
  for (const [name, w] of table) if ((r -= w) <= 0) return name;
  return table[0][0];
};

/**
 * Line the modular pieces of street.glb (art/build_street.py) along every
 * building's street face: a shopfront per bay on the ground, a window per
 * bay on each floor above, ledges, the cornice, pilasters at the ends, the
 * odd fire escape and awning, clutter on the roof. Each building picks its
 * own from a generator seeded by where it stands, so the street looks the
 * same every time and the game's own dice are left alone. Everything is
 * merged into one mesh per material (and colour) for the whole street.
 */
function dressStreet(level, scene) {
  const pieces = {};
  scene.traverse((o) => {
    if (o.parent === scene) pieces[o.name] = o;
  });
  /** @type {Map<string, { material: THREE.Material, geometries: THREE.BufferGeometry[] }>} */
  const buckets = new Map();
  const m = new THREE.Matrix4();
  const place = new THREE.Matrix4();
  const lit = new Set();

  const put = (name, matrix, colours) => {
    const piece = pieces[name];
    if (!piece) return;
    piece.updateMatrixWorld(true);
    piece.traverse((o) => {
      const mesh = /** @type {THREE.Mesh} */ (o);
      if (!mesh.isMesh) return;
      const src = /** @type {THREE.MeshStandardMaterial} */ (mesh.material);
      const colour = colours[src.name];
      const key = colour ? `${src.name}|${colour}` : src.name;
      let bucket = buckets.get(key);
      if (!bucket) {
        const material = colour ? src.clone() : src;
        if (colour) /** @type {THREE.MeshStandardMaterial} */ (material).color.set(colour);
        bucket = { material, geometries: [] };
        buckets.set(key, bucket);
        if (src.name === 'GlassLit') lit.add(material);
      }
      const g = mesh.geometry.clone();
      g.applyMatrix4(m.multiplyMatrices(matrix, mesh.matrixWorld));
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
      bucket.geometries.push(g);
    });
  };

  for (const b of level.buildings) {
    const rnd = mulberry32(Math.round(b.z0 * 1000) * 2 + (b.side > 0 ? 1 : 0));
    const colours = { Wall: b.color, Sign: SIGNS[Math.floor(rnd() * SIGNS.length)], Awning: AWNINGS[Math.floor(rnd() * AWNINGS.length)] };
    // The front faces the street: its +z points across the road.
    const yaw = -b.side * Math.PI / 2;
    const rot = new THREE.Matrix4().makeRotationY(yaw);
    const faceX = b.side * (EDGE - 0.005);
    const start = b.z0 + 0.15; // the box runs z0 + 0.15 .. z0 + len - 0.15
    const span = b.len - 0.3;
    // Bays between the pilasters, each stretched to fit.
    const inner = span - 0.64;
    const bays = Math.max(1, Math.round(inner / 3.2));
    const bayW = inner / bays;
    // A point along the front (u metres from its start), y up, d out from the wall.
    const at = (u, y, d, sx = 1, sy = 1) => {
      // Along the front is the piece's +x: for side +1 that's +z, for -1 it's -z.
      const z = b.side > 0 ? start + u : start + span - u;
      place.makeTranslation(faceX - b.side * d, y, z).multiply(rot).multiply(m.makeScale(sx, sy, 1));
      return place.clone();
    };
    const escapeBay = b.floors > 0 && rnd() < 0.35 ? Math.floor(rnd() * bays) : -1;
    let door = Math.floor(rnd() * bays);
    for (let i = 0; i < bays; i++) {
      const u = 0.32 + bayW * (i + 0.5);
      const sx = bayW / 3;
      const ground = i === door ? 'door' : weighted(rnd, [['shop', 4], ['shop_broken', 2], ['shutter', 2.5], ['boarded', 2]]);
      put(ground, at(u, 0, 0, sx), colours);
      if (ground !== 'door' && i !== escapeBay && rnd() < 0.3) put('awning', at(u, 0, 0, sx), colours);
      for (let f = 0; f < b.floors; f++) {
        const y = 3.6 + 3 * f;
        put(weighted(rnd, [['upper', 5], ['upper_ac', 1.6], ['upper_broken', 1.8], ['upper_boarded', 0.8], ['upper_lit', 0.8]]), at(u, y, 0, sx), colours);
        if (i === escapeBay) put(f === b.floors - 1 ? 'escape_top' : 'escape', at(u, y, 0, sx), colours);
      }
    }
    for (let f = 0; f < b.floors; f++) put('ledge', at(span / 2, 3.6 + 3 * f, 0, span / 3), colours);
    put('cornice', at(span / 2, b.height, 0, span / 3), colours);
    put('pilaster', at(0.16, 0, 0, 1, b.height), colours);
    put('pilaster', at(span - 0.16, 0, 0, 1, b.height), colours);
    // Roof clutter, set back from the front.
    const items = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < items; k++) {
      const name = weighted(rnd, [['roof_ac', 3], ['vent', 2], ['water_tank', b.floors > 0 ? 1.2 : 0], ['hatch', 1]]);
      put(name, at(1.2 + rnd() * (span - 2.4), b.height, -(1.2 + rnd() * (b.depth - 2.4))), colours);
    }
    for (const s of b.standIns) s.visible = false;
  }

  const root = level.buildings[0]?.standIns[0]?.parent;
  for (const { material, geometries } of buckets.values()) {
    const mesh = new THREE.Mesh(mergeGeometries(geometries), material);
    mesh.castShadow = mesh.receiveShadow = true;
    root?.add(mesh);
    for (const g of geometries) g.dispose();
  }
  level.windowLights = [...lit];
}
