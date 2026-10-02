import * as THREE from 'three';
import { Player } from './player.js';
import { Zombie } from './zombie.js';
import { createPanel } from './panel.js';
import { Effects } from './effects.js';
import { loadParams, ZOMBIE_DEFAULTS, ZOMBIE_KEY } from './params.js';
import './style.css';

const params = loadParams();
const zparams = loadParams(ZOMBIE_DEFAULTS, ZOMBIE_KEY);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#4b566c');
scene.fog = new THREE.Fog('#4b566c', 25, 60);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 200);

scene.add(new THREE.HemisphereLight('#c9d6ff', '#3a4150', 1.3));
const sun = new THREE.DirectionalLight('#ffffff', 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 40 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: '#56617a', roughness: 1 }),
);
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(200, 200, '#76839f', '#6a7690');
grid.position.y = 0.002;
grid.material.transparent = true;
grid.material.opacity = 0.35;
scene.add(grid);

// Crates: cover, scale reference, and something to collide with.
const crateMat = new THREE.MeshStandardMaterial({ color: '#8a7656', roughness: 0.9 });
const obstacles = [];
for (const [x, z, s] of [[4, 5, 1.4], [-5, 3, 1.4], [6, -4, 1.6], [-3, -6, 1.4], [0, 9, 1.4]]) {
  const crate = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), crateMat);
  crate.position.set(x, s / 2, z);
  crate.castShadow = crate.receiveShadow = true;
  crate.userData.half = s / 2;
  scene.add(crate);
  obstacles.push(crate);
}

// Push a circle (x, z, radius) out of every crate.
function collideWithCrates(pos, radius) {
  for (const crate of obstacles) {
    const h = crate.userData.half;
    const cx = THREE.MathUtils.clamp(pos.x, crate.position.x - h, crate.position.x + h);
    const cz = THREE.MathUtils.clamp(pos.z, crate.position.z - h, crate.position.z + h);
    const dx = pos.x - cx;
    const dz = pos.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < radius * radius && d2 > 1e-8) {
      const d = Math.sqrt(d2);
      pos.x += (dx / d) * (radius - d);
      pos.z += (dz / d) * (radius - d);
    }
  }
}

function insideCrate(x, z, margin) {
  return obstacles.some(
    (c) => Math.abs(x - c.position.x) < c.userData.half + margin && Math.abs(z - c.position.z) < c.userData.half + margin,
  );
}

const player = new Player(scene, params);
const effects = new Effects(scene, obstacles);

// ---------------------------------------------------------------- zombies

let zombies = [];
let kills = 0;

function spawnZombies() {
  for (const z of zombies) z.dispose();
  zombies = [];
  for (let i = 0; i < zparams.count; i++) {
    let x, z;
    do {
      const a = Math.random() * Math.PI * 2;
      const r = 9 + Math.random() * 11;
      x = player.pos.x + Math.sin(a) * r;
      z = player.pos.z + Math.cos(a) * r;
    } while (insideCrate(x, z, 0.5));
    const zombie = new Zombie(scene, zparams, new THREE.Vector3(x, 0, z));
    zombie.setSkeleton(params.showSkeleton);
    zombies.push(zombie);
  }
}
spawnZombies();

function setSkeleton(on) {
  params.showSkeleton = on;
  player.setSkeleton(on);
  for (const z of zombies) z.setSkeleton(on);
}
setSkeleton(params.showSkeleton);

createPanel(params, zparams, player, { onSkeleton: setSkeleton, onSpawn: spawnZombies });

// A shot hits whichever is nearest along the ray: a crate or a zombie.
let shake = 0;
player.onShot = (muzzle, dir) => {
  let distance = effects.raycastObstacles(muzzle, dir);
  let kind = distance < Infinity ? 'wall' : null;
  let target = null;
  let headshot = false;
  for (const z of zombies) {
    const hit = z.raycast(muzzle, dir);
    if (hit && hit.distance < distance) {
      distance = hit.distance;
      kind = 'flesh';
      target = z;
      headshot = hit.headshot;
    }
  }
  effects.shot(muzzle, dir, distance, kind);
  if (target) {
    const wasDead = target.dead;
    target.takeHit(dir, params.bulletDamage * (headshot ? params.headshotMultiplier : 1));
    if (!wasDead && target.dead) kills++;
  }
  // Gunfire is loud: everything within earshot comes looking.
  for (const z of zombies) {
    if (z.pos.distanceTo(player.pos) < zparams.hearingRange) z.alert();
  }
  shake = Math.min(shake + params.cameraShake, params.cameraShake * 3);
};

function updateWorld(dt, input) {
  player.update(dt, input);
  const world = { player, zombies };
  for (const z of zombies) z.update(dt, world);

  // Bodies can't overlap crates, and the living can't walk through each other.
  collideWithCrates(player.pos, 0.3);
  for (const z of zombies) {
    if (z.dead) continue;
    collideWithCrates(z.pos, 0.3);
    const dx = player.pos.x - z.pos.x;
    const dz = player.pos.z - z.pos.z;
    const d = Math.hypot(dx, dz);
    const min = 0.55;
    if (d < min && d > 1e-4) {
      const push = (min - d) / d / 2;
      player.pos.x += dx * push;
      player.pos.z += dz * push;
      z.pos.x -= dx * push;
      z.pos.z -= dz * push;
    }
  }
  zombies = zombies.filter((z) => !z.removed);
}

// ---------------------------------------------------------------- input

const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  keys.add(e.code);
  if (e.repeat) return;
  if (e.code === 'KeyR') player.startReload();
  if (e.code === 'KeyN') spawnZombies();
  if (e.code === 'KeyT') params.slowMo = !params.slowMo;
  if (e.code === 'KeyP') params.paused = !params.paused;
  if (e.code === 'KeyF') params.faceMouse = !params.faceMouse;
  if (e.code === 'KeyB') setSkeleton(!params.showSkeleton);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

const mouse = new THREE.Vector2();
let hasMouse = false;
renderer.domElement.addEventListener('pointermove', (e) => {
  mouse.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  hasMouse = true;
});

let triggerHeld = false;
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button === 0) triggerHeld = true;
});
window.addEventListener('pointerup', (e) => {
  if (e.button === 0) triggerHeld = false;
});
window.addEventListener('blur', () => (triggerHeld = false));
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

let camDist = 13;
renderer.domElement.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    camDist = THREE.MathUtils.clamp(camDist * (1 + Math.sign(e.deltaY) * 0.1), 4, 30);
  },
  { passive: false },
);

const raycaster = new THREE.Raycaster();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1.2); // gun height
const aimHit = new THREE.Vector3();
const held = (...codes) => (codes.some((c) => keys.has(c)) ? 1 : 0);

function readInput() {
  let aimPoint = null;
  if (hasMouse) {
    raycaster.setFromCamera(mouse, camera);
    if (raycaster.ray.intersectPlane(aimPlane, aimHit)) aimPoint = aimHit;
  }
  // Camera looks toward +Z, so screen-right is world -X.
  return {
    x: held('KeyA', 'ArrowLeft') - held('KeyD', 'ArrowRight'),
    z: held('KeyW', 'ArrowUp') - held('KeyS', 'ArrowDown'),
    walk: keys.has('ShiftLeft') || keys.has('ShiftRight'),
    fire: triggerHeld,
    aimPoint,
  };
}

// ---------------------------------------------------------------- loop

const camTarget = new THREE.Vector3();
const camGoal = new THREE.Vector3();
const camPos = new THREE.Vector3();
function updateCamera(dt, snap = false) {
  camGoal.copy(player.pos).add(new THREE.Vector3(0, 1, 0));
  const k = snap ? 1 : 1 - Math.exp(-8 * dt);
  camTarget.lerp(camGoal, k);
  camPos.set(camTarget.x, camTarget.y + camDist * 0.82, camTarget.z - camDist * 0.57);
  camera.position.lerp(camPos, k);
  camera.lookAt(camTarget);
  if (shake > 0) {
    camera.position.x += (Math.random() * 2 - 1) * shake;
    camera.position.z += (Math.random() * 2 - 1) * shake;
    shake = Math.max(shake - dt * 1.5, 0);
  }
  sun.position.set(player.pos.x - 6, 12, player.pos.z - 4);
  sun.target.position.copy(player.pos);
}
updateCamera(0, true);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const stats = document.getElementById('stats');
const timer = new THREE.Timer();
timer.connect(document);
const STEP = 1 / 120;
let hudTimer = 0;

function frame(timestamp) {
  requestAnimationFrame(frame);
  timer.update(timestamp);
  const real = Math.min(timer.getDelta(), 0.1);
  const dt = params.paused ? 0 : real * params.timeScale * (params.slowMo ? 0.25 : 1);

  const input = readInput();
  const steps = Math.ceil(dt / STEP);
  for (let i = 0; i < steps; i++) updateWorld(dt / steps, input);
  effects.update(dt);

  updateCamera(real);

  hudTimer -= real;
  if (hudTimer <= 0) {
    hudTimer = 0.1;
    const alive = zombies.filter((z) => !z.dead);
    const chasing = alive.filter((z) => z.state === 'chase').length;
    stats.textContent =
      `${player.getDebug()}\n` + `zombies ${alive.length} alive · ${chasing} chasing · kills ${kills}`;
  }

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
