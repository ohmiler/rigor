import * as THREE from 'three';
import { Player } from './player.js';
import { Zombie } from './zombie.js';
import { createPanel } from './panel.js';
import { Effects } from './effects.js';
import { Gore } from './gore.js';
import { Grapple } from './grapple.js';
import { Pickups } from './pickups.js';
import { Sound } from './audio.js';
import { Throwables } from './throwables.js';
import { MELEE } from './weapons.js';
import { buildStreet, collideCircle, insideCollider, heightAt, findLedge, solidAt, STREET_LENGTH } from './level.js';
import { Humanoid } from './humanoid.js';
import { loadParams, ZOMBIE_DEFAULTS, ZOMBIE_KEY, VISIBILITY } from './params.js';
import { DEG } from './rig-utils.js';
import './style.css';

const params = loadParams();
const zparams = loadParams(ZOMBIE_DEFAULTS, ZOMBIE_KEY);

// The levers panel, debug readout, lab link and test keys are for working on
// the game. They're on with the dev server, or add ?dev to the address.
const DEV = import.meta.env.DEV || new URLSearchParams(location.search).has('dev');
document.body.classList.toggle('dev', DEV);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#4b566c');
scene.fog = new THREE.Fog('#4b566c', 25, 60);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 200);

const sky = new THREE.HemisphereLight('#c9d6ff', '#3a4150', 1.3);
scene.add(sky);
// Faint light that follows the player: enough to see your footing, not enough
// to see what's coming.
const nearGlow = new THREE.PointLight('#9fb2d8', 0, 6, 1.2);
scene.add(nearGlow);
const sun = new THREE.DirectionalLight('#ffffff', 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 50 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(300, 300).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: '#3a3b3d', roughness: 1 }),
);
ground.position.z = STREET_LENGTH / 2;
ground.receiveShadow = true;
scene.add(ground);

const level = buildStreet(scene);
Humanoid.terrain = {
  heightAt: (x, z, maxY) => heightAt(level, x, z, maxY),
  findLedge: (pos, dir) => findLedge(level, pos, dir),
  solidAt: (p) => solidAt(level, p),
  // Ragdolls: shove a ball out of anything taller than `stepUp` above its bottom.
  collide: (pos, radius, bottom, stepUp) => collideCircle(level, pos, radius, bottom, stepUp),
};

// Day is kept around as a debugging view; night is the game.
function applyEnvironment() {
  const night = params.night;
  scene.background.set(night ? '#04060a' : '#4b566c');
  scene.fog.color.copy(scene.background);
  sky.intensity = night ? params.ambientLight : 1.3;
  sky.color.set(night ? '#6d7fa8' : '#c9d6ff');
  sky.groundColor.set(night ? '#0b0d12' : '#3a4150');
  sun.intensity = night ? params.moonLight : 2.2;
  sun.color.set(night ? '#8fa6d6' : '#ffffff');
  nearGlow.intensity = night ? params.nearGlow : 0;
  for (const { light, bulb } of level.lamps) {
    light.intensity = night ? 9 : 0;
    bulb.material.color.set(night ? '#ffd59a' : '#55534e');
  }
  level.goalParts.flare.intensity = night ? 6 : 0;
  renderer.toneMappingExposure = params.exposure;
  for (const b of visibilityButtons.children) b.classList.toggle('on', b.textContent === params.visibility);
}

// Visibility presets: buttons top-left, V cycles through them.
const visibilityButtons = document.getElementById('visibility');
for (const name of Object.keys(VISIBILITY)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = name;
  b.addEventListener('click', () => setVisibility(name));
  visibilityButtons.append(b);
}
function setVisibility(name) {
  Object.assign(params, VISIBILITY[name]);
  params.visibility = name;
  applyEnvironment();
}
function cycleVisibility() {
  const names = Object.keys(VISIBILITY);
  setVisibility(names[(names.indexOf(params.visibility) + 1) % names.length]);
  showToast(`Visibility: ${params.visibility}`);
}
applyEnvironment();

const player = new Player(scene, params);
player.teleport(level.start);
const effects = new Effects(scene, level.meshes);
const gore = new Gore(scene);
const pickups = new Pickups(scene, level.pickupSpots);
const sound = new Sound();
sound.listener = player.pos;
player.onFootstep = () => sound.footstep(player.pos, { speed: player.speed });
player.onLand = (impact) => sound.land(player.pos, impact);
player.onReloadEvent = (step) => sound.reload(step === 'rack' ? 'seat' : step);
player.onWeaponEvent = (event) => sound.weapon(event);
// The shove lands on whatever is in a cone in front, within reach.
// A bottle smashing: it draws anything nearby that hasn't seen you.
const throwables = new Throwables(scene, (pos) => {
  sound.glass(pos);
  for (const z of zombies) if (z.pos.distanceTo(pos) < params.noiseRange) z.investigate(pos);
});
player.onThrow = (from, to) => throwables.lob(from, to);

// The knife, each frame its blade can connect: anything the tip is inside
// takes the cut (once per swing). A stab or cut to the head hits far harder;
// on a crawler's head it's the end. Taken from behind by one that hasn't
// seen you, it dies without a sound, and nothing else hears.
player.onMeleeFrame = (tip, kind, hits, dir) => {
  for (const z of zombies) {
    if (z.dead || hits.has(z)) continue;
    let head = false;
    if (z.ragdoll) {
      if (tip.distanceTo(z.ragdoll.head) < 0.24) head = true;
      else if (!z.ragdoll.particles.some((p) => p.pos.distanceTo(tip) < 0.2)) continue;
    } else {
      if (Math.hypot(tip.x - z.pos.x, tip.z - z.pos.z) > z.hitRadius + 0.1) continue;
      const h = tip.y - z.pos.y;
      if (h < 0.15 || h > 1.9) continue;
      head = tip.distanceTo(z.headPos) < 0.17; // where its head actually is (hunched ones carry it low)
    }
    hits.add(z);
    const toPlayer = player.pos.clone().sub(z.pos).setY(0).normalize();
    const facing = new THREE.Vector3(Math.sin(z.aimYaw), 0, Math.cos(z.aimYaw));
    const unaware = !z.ragdoll && (z.state === 'wander' || z.state === 'investigate') && facing.dot(toPlayer) < -0.2;
    let damage = MELEE[kind].damage * (head ? 2.5 : 1);
    if (unaware || (z.ragdoll && head)) damage = 9999;
    const wasDead = z.dead;
    z.takeHit(dir, damage, { headshot: head, height: tip.y });
    if (!wasDead && z.dead) kills++;
    gore.spray(tip.clone(), dir.clone().setY(0.3), head ? 16 : 9, 2.2);
    sound.stab(tip);
    if (unaware) notePickup('SILENT KILL', 'medkit');
  }
};

// Grabbed with the knife out: it goes into the head of whatever has hold.
player.onGrabStab = (z) => {
  if (!z || z.dead) return;
  const dir = z.pos.clone().sub(player.pos).setY(0).normalize();
  z.takeHit(dir, 9999, { headshot: true, height: z.headPos.y });
  kills++;
  gore.spray(z.headPos.clone(), dir.clone().setY(0.5), 22, 2.6);
  sound.stab(z.headPos);
  shake = Math.max(shake, params.cameraShake * 2);
};

player.onShove = (dir) => {
  let hit = false;
  for (const z of zombies) {
    if (z.dead) continue;
    const to = z.pos.clone().sub(player.pos).setY(0);
    const d = to.length();
    if (d > params.shoveRange || (d > 0.2 && to.normalize().dot(dir) < 0.45)) continue;
    // A brute barely rocks; everything else reels back and drops a lunge.
    if (z.type === 'brute') z.jolt(dir, 1.5);
    else z.shove(dir, params.shoveForce);
    z.health -= 8;
    hit = true;
  }
  if (hit) {
    sound.thump(player.pos.clone().addScaledVector(dir, 0.8));
    shake = Math.max(shake, params.cameraShake);
  }
};

// Walking over supplies. A medkit is left lying if you're already at full health.
const pickupNote = document.getElementById('pickup-note');
let pickupNoteTimer = 0;
function notePickup(text, kind) {
  pickupNote.textContent = text;
  pickupNote.className = kind;
  // Restart the rise-and-fade even if the last note is still showing.
  pickupNote.hidden = true;
  void pickupNote.offsetWidth;
  pickupNote.hidden = false;
  clearTimeout(pickupNoteTimer);
  pickupNoteTimer = setTimeout(() => (pickupNote.hidden = true), 1600);
}
function takePickup(type) {
  if (type === 'bottle') {
    if (player.bottles >= params.maxBottles) return false; // hands full: leave it
    player.bottles++;
    sound.pickup('bottle');
    notePickup('+1 BOTTLE', 'ammo');
    return true;
  }
  if (type === 'ammo' || type === 'pistolAmmo') {
    const kind = type === 'ammo' ? 'rifle' : 'pistol';
    const n = kind === 'rifle' ? params.ammoPickup : params.pistolAmmoPickup;
    sound.pickup(type);
    player.reserves[kind] += n;
    notePickup(`+${n} ${kind.toUpperCase()} ROUNDS`, 'ammo');
    // Ran dry with this gun in hand: reload straight away.
    if (player.weapon.def.ammo === kind && player.rounds === 0 && params.autoReload) player.startReload();
    return true;
  }
  if (player.health >= params.maxHealth) return false;
  const before = player.health;
  player.health = Math.min(player.health + params.medkitHeal, params.maxHealth);
  sound.pickup('medkit');
  notePickup(`+${Math.round(player.health - before)} HEALTH`, 'medkit');
  return true;
}

// Feedback for the grab loop: red flash on bites, slow motion on death.
let hurtFlash = 0;
let deathSlow = 0;
const grapple = new Grapple(player, gore, params, {
  onBite: () => {
    sound.bite();
    hurtFlash = 1;
    shake = params.cameraShake * 5;
  },
  onBreakFree: () => {
    sound.breakFree();
    shake = params.cameraShake * 2;
  },
  onDeath: (mode) => onPlayerDeath(mode === 'halves' ? 'They pulled you apart.' : 'Torn limb from limb.'),
});

function onPlayerDeath(text) {
  sound.tear();
  setTimeout(() => sound.died(), 900);
  hurtFlash = 1;
  shake = params.cameraShake * 6;
  deathSlow = 1.6;
  document.getElementById('dead-sub').textContent = text;
  setTimeout(() => (document.getElementById('dead').hidden = false), 900);
}

// A brute's blow: it throws you, and it can finish you.
function bruteBlow(brute, dir) {
  if (player.state === 'dead' || escaped) return;
  sound.slam(brute.pos);
  player.knock(dir, zparams.slamKnock, zparams.slamDamage);
  hurtFlash = 1;
  shake = params.cameraShake * 6;
  gore.spray(player.chestPos.clone(), dir.clone().setY(0.5), 12, 2.5);
  if (player.health <= 0) {
    for (const z of grapple.grabbers) z.state = 'feed';
    grapple.reset();
    player.die('arms', [dir.clone().negate()], gore);
    onPlayerDeath('Beaten to pieces.');
  }
}

// A screamer's shriek: every zombie in earshot comes running.
function screamerShriek(screamer) {
  sound.scream(screamer.pos, 1.2, true);
  shake = Math.max(shake, params.cameraShake * 1.5);
  for (const z of zombies) {
    if (z !== screamer && z.pos.distanceTo(screamer.pos) < zparams.screamRange) z.alert();
  }
}

function restart() {
  gore.clear();
  throwables.clear();
  grapple.reset();
  player.reset(level.start);
  setSkeleton(params.showSkeleton);
  kills = 0;
  runTime = 0;
  escaped = false;
  document.getElementById('dead').hidden = true;
  document.getElementById('won').hidden = true;
  pickups.reset();
  spawnLevelZombies();
}

// ---------------------------------------------------------------- zombies

let zombies = [];
let kills = 0;
let runTime = 0;
let escaped = false;

// Which kind spawns. Specials get likelier further down the street (`along`,
// metres from the start; a wave around the player uses the full shares).
function pickType(along = Infinity) {
  const ramp = (from) => Math.min(Math.max((along - from) / 40, 0), 1);
  const r = Math.random();
  const screamer = zparams.screamerShare * ramp(15);
  const runner = screamer + zparams.runnerShare * ramp(25);
  const brute = runner + zparams.bruteShare * ramp(45);
  if (r < screamer) return 'screamer';
  if (r < runner) return 'runner';
  if (r < brute) return 'brute';
  return 'walker';
}

function addZombie(x, z, type = 'walker') {
  const zombie = new Zombie(scene, zparams, new THREE.Vector3(x, 0, z), type);
  zombie.onSlam = (dir) => bruteBlow(zombie, dir);
  zombie.onScream = screamerShriek;
  zombie.setSkeleton(params.showSkeleton);
  // The limping leg drags along the road rather than stepping.
  zombie.onFootstep = (f) => sound.footstep(f.pos, { zombie: true, drag: f.stepScale < 0.75 });
  zombie.onLand = (impact) => sound.land(zombie.pos, impact);
  zombie.voice = { state: zombie.state, dead: false, next: Math.random() * 6 };
  zombies.push(zombie);
}

// The street's own population, jittered so no two runs are the same.
function spawnLevelZombies() {
  for (const z of zombies) z.dispose();
  zombies = [];
  for (const s of level.zombieSpawns) {
    let x, z;
    let tries = 0;
    do {
      x = s.x + (Math.random() - 0.5) * 2;
      z = s.z + (Math.random() - 0.5) * 3;
    } while (insideCollider(level, x, z, 0.4) && ++tries < 10);
    if (tries < 10) addZombie(x, z, pickType(z));
  }
}
spawnLevelZombies();

// N: an extra wave around the player (for testing, or for punishment).
function spawnWave() {
  for (let i = 0; i < zparams.count; i++) {
    let x, z;
    let tries = 0;
    do {
      const a = Math.random() * Math.PI * 2;
      const r = 8 + Math.random() * 8;
      x = player.pos.x + Math.sin(a) * r;
      z = player.pos.z + Math.cos(a) * r;
    } while (insideCollider(level, x, z, 0.4) && ++tries < 20);
    if (tries < 20) addZombie(x, z, pickType());
  }
}

function setSkeleton(on) {
  params.showSkeleton = on;
  player.setSkeleton(on);
  for (const z of zombies) z.setSkeleton(on);
}
setSkeleton(params.showSkeleton);

if (DEV) {
  createPanel(params, zparams, player, {
    onSkeleton: setSkeleton,
    onSpawn: spawnWave,
    onFullscreen: () => enterFullscreen(),
    onEnvironment: applyEnvironment,
    onVisibility: setVisibility,
  });
}

// A shot hits whichever is nearest along the ray: a crate or a zombie.
let shake = 0;
player.onShot = (muzzle, dir, damage) => {
  let distance = effects.raycastObstacles(muzzle, dir);
  let kind = distance < Infinity ? 'wall' : null;
  // Shooting down from a car: the road stops the bullet.
  if (dir.y < -1e-4 && muzzle.y / -dir.y < distance) {
    distance = muzzle.y / -dir.y;
    kind = 'wall';
  }
  let target = null;
  let headshot = false;
  let targetHit = null;
  for (const z of zombies) {
    const hit = z.raycast(muzzle, dir);
    if (hit && hit.distance < distance) {
      distance = hit.distance;
      kind = 'flesh';
      target = z;
      headshot = hit.headshot;
      targetHit = hit;
    }
  }
  effects.shot(muzzle, dir, distance, kind);
  sound.gunshot(muzzle, player.weapon.name === 'pistol');
  if (kind === 'wall') sound.wallHit(muzzle.clone().addScaledVector(dir, distance));
  if (target) {
    const hitPoint = muzzle.clone().addScaledVector(dir, distance);
    gore.spray(hitPoint, dir, headshot ? 24 : 10, headshot ? 3.5 : 2.5);
    const wasDead = target.dead;
    target.takeHit(dir, damage * (headshot ? params.headshotMultiplier : 1), targetHit);
    sound.fleshHit(hitPoint, headshot);
    if (!wasDead && target.dead) kills++;
  }
  // Gunfire is loud: everything within earshot comes looking.
  for (const z of zombies) {
    if (z.pos.distanceTo(player.pos) < zparams.hearingRange) z.alert();
  }
  shake = Math.min(shake + params.cameraShake, params.cameraShake * 3);
};

const NO_INPUT = { x: 0, z: 0, walk: false, sprint: false, fire: false, jump: false, aimPoint: null };

// Legs passing through a body on the road shove it: corpses get kicked and
// trodden on, and so do the pieces of a torn-apart player.
const _shin = new THREE.Vector3();
const _legVel = new THREE.Vector3();
function kickBodies() {
  const bodies = zombies.filter((z) => z.dead && z.ragdoll).map((z) => z.ragdoll);
  if (player.ragdoll) bodies.push(player.ragdoll);
  if (!bodies.length) return;
  const walkers = zombies.filter((z) => !z.ragdoll && !z.traversal);
  if (player.state !== 'dead' && !player.traversal) walkers.push(player);
  for (const w of walkers) {
    for (const rd of bodies) {
      if (rd.pelvis.distanceToSquared(w.pos) > 2.5 * 2.5) continue;
      for (const leg of w.legs) {
        _legVel.copy(w.vel).multiplyScalar(1.4);
        rd.push(leg.ankle, 0.07, _legVel);
        rd.push(_shin.lerpVectors(leg.knee, leg.ankle, 0.5), 0.06, _legVel);
      }
    }
  }
}

function updateWorld(dt, input) {
  player.update(dt, escaped ? NO_INPUT : input);
  const world = { player, zombies, grapple };
  for (const z of zombies) z.update(dt, world);
  if (player.state === 'normal' || player.state === 'grabbed') runTime += dt;

  // Made it to the extraction point alive.
  if (!escaped && player.state === 'normal' && player.pos.distanceTo(level.goal.pos) < level.goal.radius) {
    escaped = true;
    player.state = 'escaped'; // can't be grabbed any more
    const m = Math.floor(runTime / 60);
    const s = Math.floor(runTime % 60).toString().padStart(2, '0');
    document.getElementById('won-sub').textContent =
      `Time ${m}:${s} · ${kills} killed · ${Math.round(player.health)} health · ${Object.values(player.weapons).reduce((n, w) => n + w.ammo + (w.chambered ? 1 : 0), 0) + player.reserves.rifle + player.reserves.pistol} rounds left`;
    document.getElementById('won').hidden = false;
    sound.escaped();
  }

  // Bodies can't overlap walls, cars or each other (mid-climb, the path rules).
  if (player.state !== 'dead' && !player.traversal) collideCircle(level, player.pos, 0.3, player.pos.y);
  for (const z of zombies) {
    if (z.dead || z.traversal || z.ragdoll) continue; // bodies on the road are ragdolls
    collideCircle(level, z.pos, 0.3, z.pos.y);
    // Grabbers and feeders are meant to be up close; different heights don't touch.
    if (player.state !== 'normal' || z.state === 'grab' || player.traversal) continue;
    if (Math.abs(player.pos.y - z.pos.y) > 0.5) continue;
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
// Shift state comes from the shiftKey flag every key and mouse event carries,
// so a keyup lost to a dialog or focus change can't leave it "stuck" down.
// (Walking is C, not Ctrl: Ctrl+W closes the tab and a page can't stop it.)
const mods = { shift: false };
const syncMods = (e) => {
  mods.shift = e.shiftKey;
};
for (const type of ['keydown', 'keyup', 'pointermove', 'pointerdown', 'pointerup']) {
  window.addEventListener(type, syncMods, true);
}

async function enterFullscreen() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    showToast('Press Esc to leave fullscreen');
  } catch {
    showToast('Fullscreen was blocked by the browser');
  }
}
document.addEventListener('fullscreenchange', () => {
  fullscreenButton.hidden = !!document.fullscreenElement;
});

const fullscreenButton = document.getElementById('fullscreen');
fullscreenButton.addEventListener('click', enterFullscreen);

const toast = document.getElementById('toast');
let toastTimer = 0;
function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 4000);
}
// The start screen: nothing moves until you choose how to play.
let started = false;
const startScreen = document.getElementById('start');
function startGame(fullscreen) {
  if (started) return;
  sound.start(); // browsers only allow audio after a click or key press
  started = true;
  startScreen.hidden = true;
  jumpQueued = false;
  document.activeElement?.blur?.(); // or Space would "click" the hidden button
  if (fullscreen) enterFullscreen();
}
document.getElementById('play-fullscreen').addEventListener('click', () => startGame(true));
document.getElementById('play-window').addEventListener('click', () => startGame(false));
// Phones and tablets: say so up front rather than leaving them stuck.
if (matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches) {
  startScreen.querySelector('.touch').hidden = false;
}

let strugglePresses = 0; // Space presses since last frame
let jumpQueued = false;

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  keys.add(e.code);
  if (e.repeat) return;
  if (!started) {
    if (e.code === 'Enter') startGame(false);
    return;
  }
  if (e.code === 'Space' || e.code === 'KeyE') strugglePresses++;
  if (e.code === 'Space') jumpQueued = true; // vault/climb when not grabbed
  if (e.code === 'Enter' && (player.state === 'dead' || escaped)) restart();
  if (e.code === 'KeyR') player.startReload();
  if (e.code === 'Digit1') player.switchWeapon('rifle');
  if (e.code === 'Digit2') player.switchWeapon('pistol');
  if (e.code === 'Digit3') player.switchWeapon('knife');
  if (e.code === 'KeyQ') player.switchWeapon(player.switchTo ? player.weapon.name : player.otherWeapon());
  if (e.code === 'KeyG') player.startThrow(lastAim);
  if (e.code === 'KeyP') params.paused = !params.paused;
  if (e.code === 'KeyF') player.toggleFlashlight();
  if (e.code === 'KeyV') cycleVisibility();
  if (e.code === 'KeyM') showToast(sound.toggleMute() ? 'Sound off (M)' : 'Sound on (M)');
  if (DEV) {
    if (e.code === 'KeyN') spawnWave();
    if (e.code === 'KeyT') params.slowMo = !params.slowMo;
    if (e.code === 'KeyB') setSkeleton(!params.showSkeleton);
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => {
  keys.clear();
  mods.shift = false;
});

const mouse = new THREE.Vector2();
let hasMouse = false;
renderer.domElement.addEventListener('pointermove', (e) => {
  mouse.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  hasMouse = true;
});

let triggerHeld = false;
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button === 0) triggerHeld = true;
  if (e.button === 2 && started) player.startShove();
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

let lastAim = null;
function readInput() {
  let aimPoint = null;
  if (hasMouse) {
    raycaster.setFromCamera(mouse, camera);
    if (raycaster.ray.intersectPlane(aimPlane, aimHit)) aimPoint = aimHit;
  }
  lastAim = aimPoint;
  // Camera looks toward +Z, so screen-right is world -X.
  return {
    x: held('KeyA', 'ArrowLeft') - held('KeyD', 'ArrowRight'),
    z: held('KeyW', 'ArrowUp') - held('KeyS', 'ArrowDown'),
    walk: keys.has('KeyC'),
    sprint: mods.shift,
    fire: triggerHeld,
    aimPoint,
  };
}

// ---------------------------------------------------------------- loop

const camTarget = new THREE.Vector3();
const camGoal = new THREE.Vector3();
const camPos = new THREE.Vector3();
let camZoom = 1;
function updateCamera(dt, snap = false) {
  camGoal.copy(player.state === 'dead' ? player.deathPos : player.pos).add(new THREE.Vector3(0, 1, 0));
  const k = snap ? 1 : 1 - Math.exp(-8 * dt);
  camTarget.lerp(camGoal, k);
  // Push in close while grabbed or dead.
  const zoomGoal = { grabbed: 0.6, dead: 0.5 }[player.state] ?? 1;
  camZoom += (zoomGoal - camZoom) * (1 - Math.exp(-4 * dt));
  const dist = camDist * camZoom;
  camPos.set(camTarget.x, camTarget.y + dist * 0.82, camTarget.z - dist * 0.57);
  // Fog is measured from the camera, so it has to start at the player's
  // distance or the player would be fogged too.
  scene.fog.near = params.night ? dist * 0.92 : dist + 12;
  scene.fog.far = params.night ? dist + params.fogRange : dist + 50;
  nearGlow.position.set(camTarget.x, 1.8, camTarget.z);
  camera.position.lerp(camPos, k);
  camera.lookAt(camTarget);
  if (shake > 0) {
    camera.position.x += (Math.random() * 2 - 1) * shake;
    camera.position.z += (Math.random() * 2 - 1) * shake;
    shake = Math.max(shake - dt * 1.5, 0);
  }
  // High sun so the buildings don't drown the road in shadow.
  sun.position.set(player.pos.x - 5, 22, player.pos.z - 3);
  sun.target.position.copy(player.pos);
}
updateCamera(0, true);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const stats = document.getElementById('stats');
const ui = {
  health: document.getElementById('health-fill'),
  hurt: document.getElementById('hurt'),
  struggle: document.getElementById('struggle'),
  struggleFill: document.getElementById('struggle-fill'),
  biteFill: document.getElementById('bite-fill'),
  objective: document.getElementById('objective'),
  ammo: document.getElementById('ammo'),
  ammoWeapon: document.querySelector('#ammo .weapon'),
  reticle: document.getElementById('reticle'),
  bottles: document.querySelector('#ammo .bottles'),
  ammoMag: document.querySelector('#ammo .mag'),
  ammoReserve: document.querySelector('#ammo .reserve'),
  ammoState: document.querySelector('#ammo .state'),
  parkour: document.getElementById('parkour'),
};
const timer = new THREE.Timer();
timer.connect(document);
const STEP = 1 / 120;
let hudTimer = 0;

function updateUI(real) {
  ui.health.style.width = `${Math.max(player.health / params.maxHealth, 0) * 100}%`;
  hurtFlash = Math.max(hurtFlash - real * 1.5, 0);
  const lowHealth = player.state !== 'dead' && player.health < params.maxHealth * 0.35 ? 0.35 : 0;
  ui.hurt.style.opacity = Math.max(hurtFlash, lowHealth);
  ui.struggle.hidden = !grapple.active;
  if (grapple.active) {
    ui.struggleFill.style.width = `${grapple.struggle * 100}%`;
    ui.biteFill.style.width = `${grapple.biteProgress * 100}%`;
  }
  const hint = player.state === 'normal' && !player.traversal ? player.parkourHint : null;
  ui.parkour.hidden = !hint;
  if (hint) ui.parkour.innerHTML = `<b>SPACE</b> · ${hint.toUpperCase()}`;

  // Ammo: what's in the gun, what's left to reload, and what to do about it.
  const other = player.weapons[player.otherWeapon()];
  ui.ammoWeapon.innerHTML = `${(player.switchTo ? player.weapons[player.switchTo] : player.weapon).def.label} <span>· ${other.def.slot} ${other.def.label.toLowerCase()}</span>`;
  const melee = player.weapon.def.melee;
  ui.ammoMag.textContent = melee ? '' : player.magState === 'gun' ? player.rounds : '–';
  ui.ammoReserve.textContent = melee ? '' : player.reserve;
  ui.ammo.classList.toggle('melee', melee);
  ui.bottles.textContent = player.bottles > 0 ? `${'▮'.repeat(player.bottles)} BOTTLE${player.bottles > 1 ? 'S' : ''} · G` : '';
  let ammoState = '';
  let ammoClass = '';
  if (player.reload.active) ammoState = 'RELOADING';
  else if (player.switchTo) ammoState = 'SWITCHING';
  else if (melee) ammoState = player.state === 'grabbed' ? 'CLICK · STAB IT' : '';
  else if (player.rounds === 0 && player.reserve > 0) {
    ammoState = 'RELOAD · R';
    ammoClass = 'low';
  } else if (player.rounds === 0) {
    // Nothing left for this gun: say so, and whether the other one has any.
    const otherLeft = other.def.melee ? 1 : other.ammo + (other.chambered ? 1 : 0) + player.reserves[other.def.ammo];
    ammoState = otherLeft > 0 ? 'OUT OF AMMO · Q' : 'OUT OF AMMO';
    ammoClass = 'empty';
  } else if (player.rounds <= player.magSize * 0.25) ammoClass = 'low';
  if (player.dryFire) ammoClass = 'empty';
  ui.ammoState.textContent = ammoState;
  ui.ammo.className = ammoClass + (melee ? ' melee' : '');
  ui.ammo.hidden = player.state === 'dead';

  // The reticle: a ring at the cursor as wide as the cone a shot can go in.
  const aiming = started && player.state !== 'dead' && !escaped && hasMouse && lastAim;
  ui.reticle.hidden = !aiming;
  renderer.domElement.style.cursor = aiming ? 'none' : '';
  if (aiming) {
    const dist = Math.max(lastAim.distanceTo(player.gunPos), 0.5);
    const radius = dist * Math.tan(player.spreadNow * DEG);
    const a = lastAim.clone().project(camera);
    const b = lastAim.clone().add(new THREE.Vector3(radius, 0, 0)).project(camera);
    const px = Math.max(Math.abs(b.x - a.x) * window.innerWidth * 0.5, 4);
    ui.reticle.style.transform = `translate(${(a.x * 0.5 + 0.5) * window.innerWidth}px, ${(-a.y * 0.5 + 0.5) * window.innerHeight}px)`;
    ui.reticle.style.setProperty('--r', `${px}px`);
    ui.reticle.classList.toggle('busy', !player.weaponReady || player.reload.active);
  }

  const toGoal = Math.max(player.pos.distanceTo(level.goal.pos) - level.goal.radius, 0);
  ui.objective.textContent = escaped ? 'EXTRACTED' : `EXTRACTION ▲ ${Math.round(toGoal)} m`;

  // The extraction ring breathes so it reads as "go here".
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
  level.goalParts.goalRing.material.opacity = 0.5 + pulse * 0.5;
  level.goalParts.beam.material.opacity = 0.12 + pulse * 0.1;
}

// Zombie voices and other sounds that follow from what's happening rather
// than from a single event.
let screamCooldown = 0;
let wasDry = false;
const VOICE_PITCH = { walker: 1, runner: 1.3, brute: 0.55, screamer: 1.45 };
function updateSounds(dt, real) {
  sound.update(real, player.health / params.maxHealth, player.state !== 'dead');
  if (player.dryFire && !wasDry) sound.dryClick();
  wasDry = player.dryFire;
  if (dt <= 0) return;
  screamCooldown = Math.max(screamCooldown - dt, 0);
  for (const z of zombies) {
    const v = z.voice;
    if (z.dead) {
      // The body hits the road as it finishes toppling.
      if (!v.dead) setTimeout(() => sound.bodyFall(z.pos), 650);
      v.dead = true;
      continue;
    }
    if (z.state !== v.state) {
      // Seeing you: a scream, but a whole street turning at once shouldn't
      // be twenty screams on top of each other.
      if (v.state === 'wander' && z.state === 'chase' && z.type !== 'screamer') {
        if (screamCooldown <= 0) {
          sound.scream(z.pos, VOICE_PITCH[z.type]);
          screamCooldown = 0.35;
        } else sound.groan(z.pos, true, VOICE_PITCH[z.type]);
        v.next = 2 + Math.random() * 2;
      }
      if (z.state === 'lunge') sound.snarl(z.pos);
      if (z.state === 'slam') sound.groan(z.pos, true, 0.45); // a brute's roar as it winds up
      v.state = z.state;
    }
    v.next -= dt;
    if (v.next <= 0) {
      const angry = z.state === 'chase' || z.state === 'lunge' || z.state === 'grab';
      sound.groan(z.pos, angry, VOICE_PITCH[z.type]);
      v.next = angry ? 1.6 + Math.random() * 2.2 : 4 + Math.random() * 6;
    }
  }
}

function frame(timestamp) {
  requestAnimationFrame(frame);
  timer.update(timestamp);
  const real = Math.min(timer.getDelta(), 0.1);
  deathSlow = Math.max(deathSlow - real, 0);
  const slow = (params.slowMo ? 0.25 : 1) * (deathSlow > 0 ? 0.3 : 1);
  const dt = params.paused || !started ? 0 : real * params.timeScale * slow;

  // Dev test scripts can set window.__rigorInput to drive the game alone.
  const input = (import.meta.env.DEV && window.__rigorInput) ? { ...window.__rigorInput } : readInput();
  // A tap is consumed by the first simulation step only.
  input.jump = jumpQueued && dt > 0;
  if (dt > 0) jumpQueued = false;
  const steps = Math.ceil(dt / STEP);
  for (let i = 0; i < steps; i++) {
    updateWorld(dt / steps, input);
    input.jump = false;
  }
  grapple.update(dt, params.paused ? 0 : strugglePresses);
  strugglePresses = 0;
  effects.update(dt);
  gore.update(dt);
  pickups.update(dt, player, takePickup);
  throwables.update(dt);

  updateCamera(real);
  updateUI(real);
  updateSounds(dt, real);
  if (dt > 0) kickBodies();

  hudTimer -= real;
  if (DEV && hudTimer <= 0) {
    hudTimer = 0.1;
    const alive = zombies.filter((z) => !z.dead);
    const chasing = alive.filter((z) => z.state === 'chase').length;
    stats.textContent =
      `${player.getDebug()}\n` + `zombies ${alive.length} alive · ${chasing} chasing · kills ${kills}`;
  }

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// Dev-only handle for poking at the game from the browser console.
if (import.meta.env.DEV) {
  // Run the world forward without rendering (the tab may be hidden in tests).
  const advance = (secs, input = NO_INPUT) => {
    for (let t = 0; t < secs; t += STEP) {
      updateWorld(STEP, { ...input });
      grapple.update(STEP, 0);
      gore.update(STEP);
      throwables.update(STEP);
      kickBodies();
    }
  };
  window.__rigor = { player, grapple, gore, params, zparams, level, pickups, sound, restart, startGame, advance, addZombie, get zombies() { return zombies; } };
}
