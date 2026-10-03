import * as THREE from 'three';

// Ammo boxes and medkits lying along the street. Walk over one to take it.
// Each run lays out a fresh selection of the level's spots, so the street
// never has quite the same supplies twice; the riskier spots (car roofs,
// dumpster lids) are worth the climb.

const LOOKS = {
  ammo: { body: '#4f5a32', trim: '#d8b23a', halo: '#ffc85a', chance: 0.75 },
  medkit: { body: '#e9e6df', trim: '#c8302f', halo: '#ff6b6b', chance: 0.8 },
  pistolAmmo: { body: '#8a6a44', trim: '#e3dccb', halo: '#ffc85a', chance: 0.75 },
};
// An ammo spot holds rifle or pistol rounds, rolled each run.
const PISTOL_SHARE = 0.45;

const haloGeometry = new THREE.RingGeometry(0.22, 0.42, 32).rotateX(-Math.PI / 2);

function buildMesh(type) {
  const look = LOOKS[type];
  const g = new THREE.Group();
  const mat = (color, emissive = 0.25) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.6, emissive: color, emissiveIntensity: emissive });
  const box = (m, w, h, d, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };
  if (type === 'ammo') {
    // A green ammo can with a yellow band and a carry handle.
    box(mat(look.body, 0.2), 0.32, 0.18, 0.16, 0, 0.09, 0);
    box(mat(look.trim, 0.5), 0.325, 0.03, 0.165, 0, 0.12, 0);
    box(mat('#2a2f1c', 0.1), 0.14, 0.02, 0.03, 0, 0.19, 0);
  } else if (type === 'pistolAmmo') {
    // A small cardboard box of pistol rounds.
    box(mat(look.body, 0.15), 0.2, 0.08, 0.13, 0, 0.04, 0);
    box(mat(look.trim, 0.3), 0.205, 0.02, 0.135, 0, 0.06, 0);
  } else {
    // A white kit with a red cross on the lid.
    box(mat(look.body, 0.25), 0.3, 0.14, 0.22, 0, 0.07, 0);
    const red = mat(look.trim, 0.6);
    box(red, 0.16, 0.01, 0.05, 0, 0.145, 0);
    box(red, 0.05, 0.01, 0.16, 0, 0.145, 0);
  }
  // A glow on the ground so it reads in the dark.
  const halo = new THREE.Mesh(
    haloGeometry,
    new THREE.MeshBasicMaterial({
      color: look.halo,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  halo.position.y = 0.02;
  g.scale.setScalar(1.3); // a touch bigger than life, to read from the top-down camera
  return { group: g, halo };
}

export class Pickups {
  /** `spots`: [{ type: 'ammo' | 'medkit', pos: Vector3 }] from the level. An
   * 'ammo' spot turns up rifle or pistol rounds. */
  constructor(scene, spots) {
    this.items = spots.map((spot) => {
      // An ammo spot gets both boxes built; reset() shows one.
      const kinds = spot.type === 'ammo' ? ['ammo', 'pistolAmmo'] : [spot.type];
      const looks = {};
      const root = new THREE.Group();
      root.position.copy(spot.pos);
      for (const k of kinds) {
        looks[k] = buildMesh(k);
        root.add(looks[k].group, looks[k].halo);
      }
      scene.add(root);
      return { ...spot, spotType: spot.type, looks, root, group: null, halo: null, active: false, phase: Math.random() * Math.PI * 2 };
    });
    this.reset();
  }

  // A new run: roll which spots have something in them, and what.
  reset() {
    for (const it of this.items) {
      it.type = it.spotType === 'ammo' && Math.random() < PISTOL_SHARE ? 'pistolAmmo' : it.spotType;
      for (const [k, look] of Object.entries(it.looks)) look.group.visible = look.halo.visible = k === it.type;
      it.group = it.looks[it.type].group;
      it.halo = it.looks[it.type].halo;
      it.active = Math.random() < LOOKS[it.type].chance;
      it.root.visible = it.active;
    }
  }

  /**
   * `take(type)` returns true if the player could use it (a medkit at full
   * health stays where it is).
   */
  update(dt, player, take) {
    const t = performance.now() / 1000;
    for (const it of this.items) {
      if (!it.active) continue;
      // Turn slowly and bob, with the halo breathing, so it catches the eye.
      it.group.rotation.y += dt * 1.2;
      it.group.position.y = 0.06 + Math.sin(t * 2.4 + it.phase) * 0.04;
      it.halo.material.opacity = 0.35 + 0.25 * Math.sin(t * 3 + it.phase);
      if (player.state !== 'normal') continue;
      const dx = player.pos.x - it.pos.x;
      const dz = player.pos.z - it.pos.z;
      if (dx * dx + dz * dz < 0.7 * 0.7 && Math.abs(player.pos.y - it.pos.y) < 0.6 && take(it.type)) {
        it.active = false;
        it.root.visible = false;
      }
    }
  }
}
