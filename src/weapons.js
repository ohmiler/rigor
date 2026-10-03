import * as THREE from 'three';

// The guns: their handling, where the hands go on them, how they reload, and
// what they look like. Points are in gun space: (right, up, forward).
//
// `stat` overrides the shared levers in params (spread, recoil, fire rate,
// hold position...). The rifle overrides nothing, so the Weapon levers in the
// panel tune it directly; the pistol carries its own numbers.

// Each reload stage is a target for the left hand. The next stage only starts
// once the hand actually touches the target (contact-gated), not after a timer.
const RIFLE_SUPPORT = [0, -0.08, 0.24];
const RIFLE_RELOAD = [
  { name: 'Eject the old mag', frame: 'gun', p: [0, -0.18, 0.16], start: 'eject' },
  { name: 'Reach the left hip', frame: 'pelvis', p: [-0.21, 0.02, 0.06] },
  { name: 'Grip the new mag', frame: 'pelvis', p: [-0.21, -0.02, 0.06], end: 'take', minTime: 0.12 },
  { name: 'Align below the port', frame: 'gun', p: [0, -0.4, 0.08] },
  { name: 'Seat the mag', frame: 'gun', p: [0, -0.22, 0.08], end: 'seat' },
  { name: 'Restore the support grip', frame: 'gun', p: RIFLE_SUPPORT },
];

// The support hand cups the gun hand from the left.
const PISTOL_SUPPORT = [-0.028, -0.085, -0.02];
const PISTOL_RELOAD = [
  { name: 'Drop the old mag', frame: 'gun', p: [-0.02, -0.16, -0.05], start: 'eject' },
  { name: 'Reach the mag pouch', frame: 'pelvis', p: [-0.17, 0.03, 0.09] },
  { name: 'Grip the new mag', frame: 'pelvis', p: [-0.17, -0.01, 0.09], end: 'take', minTime: 0.1 },
  { name: 'Line it up under the grip', frame: 'gun', p: [0, -0.22, -0.05] },
  { name: 'Seat the mag', frame: 'gun', p: [0, -0.13, -0.045], end: 'seat' },
];
// After a reload from empty the slide is locked back: rack it to chamber a round.
const PISTOL_RACK = [
  { name: 'Grip the slide', frame: 'gun', p: [0, 0.035, -0.02] },
  { name: 'Rack the slide', frame: 'gun', p: [0, 0.035, -0.11], end: 'rack' },
];
const PISTOL_RESTORE = { name: 'Restore the grip', frame: 'gun', p: PISTOL_SUPPORT };

export const WEAPONS = {
  rifle: {
    label: 'RIFLE',
    slot: 1,
    ammo: 'rifle', // which pile of spare rounds it draws on
    auto: true,
    chamber: false,
    stat: {},
    grip: [0, -0.1, -0.05],
    support: RIFLE_SUPPORT,
    magSeat: [0, -0.13, 0.08],
    magInHand: 0.09,
    muzzle: [0, 0.01, 0.52],
    ejection: [0.04, 0.03, 0.1],
    torch: 0.43, // where the flashlight sits along the barrel
    holster: 'back', // slung across the back when not in hand
    moveSpeed: 1,
    reload: () => RIFLE_RELOAD,
  },
  pistol: {
    label: 'PISTOL',
    slot: 2,
    ammo: 'pistol',
    auto: false,
    chamber: true, // 15 in the mag plus one up the spout
    stat: {
      magSize: 15,
      fireRate: 420, // as fast as you can pull the trigger, but no faster
      bulletDamage: 30,
      spread: 0.6,
      spreadMove: 2.6,
      bloomPerShot: 1.3,
      bloomMax: 6,
      bloomRecover: 9,
      recoilKick: 0.8,
      recoilClimb: 12,
      recoilYaw: 3,
      recoilStiffness: 430,
      recoilDampingRatio: 0.62,
      maxClimb: 28,
      torsoKick: 0.18,
      // Held out at arm's length, centred: an isosceles stance.
      gunRight: 0,
      gunUp: 0.07,
      gunFwd: 0.5,
    },
    grip: [0, -0.07, -0.035],
    support: PISTOL_SUPPORT,
    magSeat: [0, -0.075, -0.036],
    magInHand: 0.05,
    muzzle: [0, 0.008, 0.15],
    ejection: [0.02, 0.025, 0.05],
    torch: 0.15,
    holster: 'hip',
    moveSpeed: 1.08, // lighter than the rifle
    reload: (fromEmpty) => [...PISTOL_RELOAD, ...(fromEmpty ? PISTOL_RACK : []), PISTOL_RESTORE],
  },
  knife: {
    label: 'KNIFE',
    slot: 3,
    melee: true, // no ammo: slash and stab (see Player.startMelee)
    ammo: null,
    chamber: false,
    stat: {
      // Held low and forward, blade out, ready to cut.
      gunRight: 0.14,
      gunUp: -0.16,
      gunFwd: 0.34,
    },
    grip: [0, 0, 0],
    support: null, // the free hand holds the flashlight out in front
    magSeat: [0, 0, 0],
    magInHand: 0,
    muzzle: [0, 0, 0.2], // the tip of the blade
    ejection: [0, 0, 0],
    torch: 0,
    holster: 'sheath', // on the left hip, blade down
    moveSpeed: 1.12,
    reload: () => [],
  },
};

// Knife attacks: how long each lasts, and the stretch of it where the blade
// can connect. Poses are offsets of the knife in the chest frame
// (right, up, forward) and a yaw (radians, + to the left) over the swing.
export const MELEE = {
  slash: { time: 0.34, from: 0.07, to: 0.2, damage: 34 },
  stab: { time: 0.4, from: 0.1, to: 0.2, damage: 55 },
};

const mat = (color, roughness = 0.5) => new THREE.MeshStandardMaterial({ color, roughness });

function box(parent, material, w, h, d, x = 0, y = 0, z = 0) {
  // Gun space is (right, up, forward); three.js x points left.
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(-x, y, z);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function cylinder(parent, material, r, len, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(-x, y, z);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

/**
 * Meshes for one gun: { group, mag, slide, lensAt }. `group` is placed at
 * the gun's origin each frame; `mag` lives in world space so it can leave the
 * gun during a reload; `slide` (pistol) moves back as it fires.
 */
export function buildWeaponMeshes(name, lensMaterial) {
  const group = new THREE.Group();
  const black = mat('#1e2024', 0.45);
  const accent = mat('#3a3d44', 0.5);
  let mag;
  let slide = null;
  if (name === 'rifle') {
    box(group, black, 0.06, 0.09, 0.42, 0, 0, 0.08);
    box(group, accent, 0.05, 0.1, 0.18, 0, -0.02, -0.21);
    box(group, black, 0.035, 0.1, 0.045, 0, -0.08, -0.05).rotation.x = -0.3;
    box(group, black, 0.03, 0.06, 0.035, 0, -0.075, 0.24);
    cylinder(group, accent, 0.015, 0.22, 0, 0.01, 0.4);
    cylinder(group, accent, 0.02, 0.12, 0, -0.045, 0.36); // flashlight body
    mag = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.07), mat('#d39b2a', 0.6));
  } else if (name === 'knife') {
    // Handle, guard, and a long blade along +Z from the grip.
    box(group, black, 0.024, 0.026, 0.11, 0, 0, -0.02);
    box(group, accent, 0.05, 0.012, 0.012, 0, 0, 0.04);
    const steel = new THREE.MeshStandardMaterial({ color: '#c9ced6', roughness: 0.25, metalness: 0.8 });
    box(group, steel, 0.005, 0.03, 0.17, 0, 0.002, 0.13);
    const mag = new THREE.Object3D(); // nothing to reload
    return { group, mag, slide: null, slideZ: 0 };
  } else {
    // Frame with the grip raked back, trigger guard, slide on top.
    box(group, black, 0.03, 0.115, 0.045, 0, -0.065, -0.035).rotation.x = -0.25;
    box(group, accent, 0.03, 0.028, 0.15, 0, -0.022, 0.045);
    box(group, black, 0.008, 0.008, 0.045, 0, -0.05, 0.02);
    cylinder(group, accent, 0.008, 0.03, 0, 0.008, 0.125); // barrel, bare when the slide is back
    slide = box(group, black, 0.033, 0.034, 0.17, 0, 0.008, 0.05);
    cylinder(group, accent, 0.014, 0.05, 0, -0.033, 0.11); // weapon light
    mag = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.1, 0.035), mat('#2a2d33', 0.55));
  }
  mag.castShadow = true;
  const def = WEAPONS[name];
  const lens = new THREE.Mesh(new THREE.CircleGeometry(name === 'rifle' ? 0.018 : 0.012, 12), lensMaterial);
  lens.position.set(0, name === 'rifle' ? -0.045 : -0.033, def.torch - (name === 'rifle' ? 0.009 : 0.014));
  group.add(lens);
  return { group, mag, slide, slideZ: slide?.position.z ?? 0 };
}

// How a gun sits when it isn't in hand, in the frame of the chest (rifle,
// slung across the back, muzzle up over the right shoulder) or the pelvis
// (pistol, in a holster on the right hip, muzzle down).
const _m = new THREE.Matrix4();
function orient(fwd, up) {
  const z = new THREE.Vector3(...fwd).normalize();
  const y = new THREE.Vector3(...up);
  y.addScaledVector(z, -y.dot(z)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Quaternion().setFromRotationMatrix(_m.makeBasis(x, y, z));
}
export const HOLSTERS = {
  back: { frame: 'chest', p: [0.02, -0.02, -0.17], q: orient([-0.5, 0.86, 0], [0, 0, -1]) },
  hip: { frame: 'pelvis', p: [0.21, -0.1, 0.03], q: orient([0, -1, 0.12], [0, 0, 1]) },
  sheath: { frame: 'pelvis', p: [-0.17, -0.06, 0.08], q: orient([0, -1, 0.15], [0, 0, 1]) },
};
