import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from './replay.js';
import { STREET_LENGTH } from './level.js';

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
            /** @type {any} */ (slot).model = model; // (a car alarm flashes its lights)
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
// Yaowarat: louvred shutters, and neon (tubes and the characters inside them).
const SHUTTERS = ['#3f6b55', '#2f5a6b', '#6b4a2f', '#4a5a3a', '#7a3a2a'];
const NEONS = ['#ff3b30', '#ff2d8a', '#36e0ff', '#ffd23f', '#46ff7a', '#ff8a1f'];
const GLYPHS = ['#ffe08a', '#ffffff', '#ffd23f', '#ff3b30', '#9ff7ff'];
const NEON = new Set(['Neon', 'Glyph', 'Lantern']); // they glow at night

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
  const neon = { steady: [], flicker: [], lanterns: [] };

  const put = (name, matrix, colours) => {
    const piece = pieces[name];
    if (!piece) return;
    piece.updateMatrixWorld(true);
    piece.traverse((o) => {
      const mesh = /** @type {THREE.Mesh} */ (o);
      if (!mesh.isMesh) return;
      const src = /** @type {THREE.MeshStandardMaterial} */ (mesh.material);
      const colour = colours[src.name];
      // A flickering sign is its own material, so it flickers alone.
      const flicker = colours.flicker && NEON.has(src.name);
      const key = (colour ? `${src.name}|${colour}` : src.name) + (flicker ? '|flicker' : '');
      let bucket = buckets.get(key);
      if (!bucket) {
        const material = /** @type {THREE.MeshStandardMaterial} */ (colour || flicker ? src.clone() : src);
        if (colour) material.color.set(colour);
        if (colour && NEON.has(src.name)) material.emissive.set(colour);
        bucket = { material, geometries: [] };
        buckets.set(key, bucket);
        if (src.name === 'GlassLit') lit.add(material);
        if (src.name === 'Lantern') neon.lanterns.push(material);
        else if (NEON.has(src.name)) (flicker ? neon.flicker : neon.steady).push(material);
      }
      const g = mesh.geometry.clone();
      g.applyMatrix4(m.multiplyMatrices(matrix, mesh.matrixWorld));
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
      bucket.geometries.push(g);
    });
  };

  for (const b of level.buildings) {
    const rnd = mulberry32(Math.round(b.z0 * 1000) * 2 + (b.side > 0 ? 1 : 0));
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const colours = {
      Wall: b.color,
      Sign: pick(SIGNS),
      Awning: pick(AWNINGS),
      Shutter: pick(SHUTTERS),
      Neon: pick(NEONS),
      Glyph: pick(GLYPHS),
      flicker: rnd() < 0.2, // a tube on its way out
    };
    // Most of the street is old Sino-Portuguese shophouses: arched windows,
    // shutters, a balustrade along the roof.
    const sino = b.floors > 0 && rnd() < 0.7;
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
      const ground = i === door ? 'door' : weighted(rnd, [['shop', 4], ['shop_broken', 2], ['shutter', 2.5], ['boarded', 2], ['goldshop', 1.6]]);
      put(ground === 'goldshop' ? `goldshop_${Math.floor(rnd() * 2)}` : ground, at(u, 0, 0, sx), colours);
      if (ground !== 'door' && ground !== 'goldshop' && rnd() < 0.35) put(`sign_neon_${Math.floor(rnd() * 4)}`, at(u, 0, 0, sx), colours);
      else if (ground !== 'door' && i !== escapeBay && rnd() < 0.3) put('awning', at(u, 0, 0, sx), colours);
      for (let f = 0; f < b.floors; f++) {
        const y = 3.6 + 3 * f;
        const upper = sino
          ? weighted(rnd, [['arch', 4], ['arch_shut', 2.2], ['arch_ac', 1.5], ['arch_lit', 1]])
          : weighted(rnd, [['upper', 5], ['upper_ac', 1.6], ['upper_broken', 1.8], ['upper_boarded', 0.8], ['upper_lit', 0.8]]);
        put(upper, at(u, y, 0, sx), colours);
        if (i === escapeBay && !sino) put(f === b.floors - 1 ? 'escape_top' : 'escape', at(u, y, 0, sx), colours);
      }
      if (sino) put('parapet', at(u, b.height, 0, sx), colours);
    }
    for (let f = 0; f < b.floors; f++) put('ledge', at(span / 2, 3.6 + 3 * f, 0, span / 3), colours);
    if (!sino) put('cornice', at(span / 2, b.height, 0, span / 3), colours);
    // Neon blade signs over the shops, standing out between the bays.
    if (b.floors > 0) {
      const blades = rnd() < 0.8 ? 1 + (rnd() < 0.45 ? 1 : 0) : 0;
      for (let k = 0; k < blades; k++) {
        const u = bays > 1 ? 0.32 + bayW * (1 + Math.floor(rnd() * (bays - 1))) : 0.6 + rnd() * (span - 1.2);
        const tall = b.floors > 1 && rnd() < 0.5;
        put(tall ? 'neon_blade_tall' : rnd() < 0.5 ? 'neon_blade' : 'neon_blade_b', at(u + (k ? 0.25 : 0), 3.75, 0), colours);
      }
    }
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

  // Across the street, high up: strings of lanterns, and tangles of cable.
  const rnd = mulberry32(4242);
  for (let z = 11; z < STREET_LENGTH - 4; z += 11 + rnd() * 5) {
    place.makeTranslation(0, 0, z).multiply(m.makeRotationY((rnd() - 0.5) * 0.25));
    put(rnd() < 0.65 ? 'lanterns' : 'cables', place.clone(), {});
  }

  const root = level.buildings[0]?.standIns[0]?.parent;
  for (const { material, geometries } of buckets.values()) {
    const mesh = new THREE.Mesh(mergeGeometries(geometries), material);
    mesh.castShadow = mesh.receiveShadow = true;
    root?.add(mesh);
    for (const g of geometries) g.dispose();
  }
  level.windowLights = [...lit];
  level.neon = neon;
}

// Neon at night: steady, but a few tubes stutter (seconds of real time; looks only).
export function animateNeon(level, time, night) {
  if (!level.neon) return;
  for (const m of level.neon.steady) m.emissiveIntensity = night ? 2.6 : 0;
  for (const m of level.neon.lanterns) m.emissiveIntensity = night ? 0.7 : 0; // a deep red glow, not a blaze
  level.neon.flicker.forEach((m, i) => {
    const t = time * 7 + i * 13.7;
    const stutter = Math.sin(t * 0.37) > 0.85 && Math.sin(t * 9.1) > 0; // now and then, a burst of flicker
    m.emissiveIntensity = night ? (stutter ? 0.15 : 2.6) : 0;
  });
}
