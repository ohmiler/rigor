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
import { buildStreet, collideCircle, insideCollider, heightAt, findLedge, solidAt, STREET_LENGTH, STREET_EDGE } from './level.js';
import { NavGrid } from './nav.js';
import { Post } from './post.js';
import { dressProps } from './props.js';
import { Recorder, Playback, mulberry32, newSeed, round, fingerprint } from './replay.js';
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
const fog = new THREE.Fog('#4b566c', 25, 60);
scene.fog = fog;

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 200);
const post = new Post(renderer, scene, camera);

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

// The street is built from a fixed seed: everyone gets the same one, so a
// replay from another machine walks the same street. (Random streets will
// take each run's seed instead.)
const STREET_SEED = 1;
const level = (() => {
  const random = Math.random;
  Math.random = mulberry32(STREET_SEED);
  try {
    return buildStreet(scene);
  } finally {
    Math.random = random;
  }
})();
dressProps(level);
Humanoid.terrain = {
  heightAt: (x, z, maxY) => heightAt(level, x, z, maxY),
  findLedge: (pos, dir) => findLedge(level, pos, dir),
  solidAt: (p) => solidAt(level, p),
  // Ragdolls: shove a ball out of anything taller than `stepUp` above its bottom.
  collide: (pos, radius, bottom, stepUp) => collideCircle(level, pos, radius, bottom, stepUp),
};
// How zombies find their way round the cars and barriers to you.
const nav = new NavGrid(level, { minX: -STREET_EDGE, maxX: STREET_EDGE, minZ: -1, maxZ: STREET_LENGTH + 1 });

// Day is kept around as a debugging view; night is the game.
function applyEnvironment() {
  const night = params.night;
  const background = /** @type {THREE.Color} */ (scene.background);
  background.set(night ? '#04060a' : '#4b566c');
  fog.color.copy(background);
  sky.intensity = night ? params.ambientLight : 1.3;
  sky.color.set(night ? '#6d7fa8' : '#c9d6ff');
  sky.groundColor.set(night ? '#0b0d12' : '#3a4150');
  sun.intensity = night ? params.moonLight : 2.2;
  sun.color.set(night ? '#8fa6d6' : '#ffffff');
  nearGlow.intensity = night ? params.nearGlow : 0;
  for (const { light, bulb } of level.lamps) {
    light.intensity = night ? 9 : 0;
    bulb.material.color.set(night ? '#ffd59a' : '#55534e');
    if (night) bulb.material.color.multiplyScalar(4); // bright enough to glow
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

// An arm shot off: the forearm (or what's left of the arm) flies off the way
// the bullet went, and the stump spurts for a while.
function severArm(z, i, part, dir) {
  const arm = z.arms[i];
  const parts = part === 'fore' ? [arm.fore.mesh, arm.hand] : [arm.upper.mesh];
  const joint = (part === 'fore' ? arm.elbow : arm.shoulder).clone();
  gore.tear(parts, joint, {
    vel: dir.clone().multiplyScalar(3).add(new THREE.Vector3(0, 1.8, 0)),
    angVel: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(20),
    rest: 0.05,
  });
  gore.spray(joint, dir.clone().setY(0.4), 20, 2.8);
  gore.wound(joint, dir, {
    rate: 45,
    duration: 4,
    speed: 1.4,
    follow: (outPoint, outDir) => {
      outPoint.copy(part === 'fore' ? arm.elbow : arm.shoulder);
      outDir.subVectors(outPoint, part === 'fore' ? arm.shoulder : z.chestPos).normalize();
    },
  });
  sound.sever(joint);
}

// A screamer's shriek: every zombie in earshot comes running.
function screamerShriek(screamer) {
  sound.scream(screamer.pos, 1.2, true);
  shake = Math.max(shake, params.cameraShake * 1.5);
  for (const z of zombies) {
    if (z !== screamer && z.pos.distanceTo(screamer.pos) < zparams.screamRange) z.alert();
  }
}

// ---------------------------------------------------------------- runs & replays

// Each run rolls its dice from its own seed, and the simulation steps at a
// fixed rate, so a run is its seed plus the input on every step: that's
// what's recorded, and a replay feeds it back (replay.js). Simulation code
// gets the seeded dice; looks and sounds keep the real ones.
const realRandom = Math.random;
let rng = mulberry32(1);
function seeded(fn) {
  Math.random = rng;
  try {
    fn();
  } finally {
    Math.random = realRandom;
  }
}
// ?seed=123 plays that run's dice (the same zombies and supplies every time).
const seedParam = new URLSearchParams(location.search).get('seed');
const urlSeed = seedParam && /^\d+$/.test(seedParam) ? Number(seedParam) >>> 0 : null;
let recorder = null; // the run being played
let playback = null; // or the replay being watched
let replaySpeed = 1;
let watchedLevers = null; // your levers, put back after a replay with its own
let pending = []; // commands (reload, switch weapon...) for the next step
let acc = 0; // real time not yet simulated
// Levers that only change how things look stay yours when a replay brings its own.
const VIEW_LEVERS = new Set(['paused', 'slowMo', 'timeScale', 'showSkeleton', 'postFX', 'bloom', 'vignette', 'grain', 'visibility', 'night', 'ambientLight', 'moonLight', 'nearGlow', 'fogRange', 'exposure']);
const levers = () => ({
  params: Object.fromEntries(Object.entries(params).filter(([k]) => !VIEW_LEVERS.has(k))),
  zparams: { ...zparams },
});

function restart(seed = urlSeed ?? newSeed()) {
  rng = mulberry32(seed);
  seeded(() => {
    gore.clear();
    throwables.clear();
    grapple.reset();
    player.reset(level.start);
    pickups.reset();
    spawnLevelZombies();
  });
  setSkeleton(params.showSkeleton);
  kills = 0;
  runTime = 0;
  escaped = false;
  deathSlow = 0;
  hurtFlash = 0;
  acc = 0;
  pending = [];
  document.getElementById('dead').hidden = true;
  document.getElementById('won').hidden = true;
  recorder = playback ? null : new Recorder(seed, levers());
}

// Watch a recorded run (yours just now, or a file someone sent).
function watchReplay(data) {
  let pb;
  try {
    pb = new Playback(data);
  } catch (e) {
    showToast(e.message);
    return;
  }
  if (!watchedLevers) watchedLevers = levers();
  Object.assign(params, data.settings?.params ?? {});
  Object.assign(zparams, data.settings?.zparams ?? {});
  playback = pb;
  replaySpeed = 1;
  if (!started) startGame(false);
  restart(pb.seed);
  ui.replay.hidden = false;
}

function leaveReplay() {
  playback = null;
  if (watchedLevers) {
    Object.assign(params, watchedLevers.params);
    Object.assign(zparams, watchedLevers.zparams);
    watchedLevers = null;
  }
  ui.replay.hidden = true;
  restart();
}

function saveReplay() {
  if (!recorder) return;
  const blob = new Blob([JSON.stringify(recorder)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rigor-replay-${recorder.seed}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function openReplayFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showToast('That file is not a RIGOR replay');
    return;
  }
  watchReplay(data);
}

// The state of the world in a few numbers, to catch a replay drifting.
function worldFingerprint() {
  const v = [player.pos.x, player.pos.y, player.pos.z, player.health, kills, zombies.length];
  for (const z of zombies) v.push(z.pos.x, z.pos.z);
  return fingerprint(v);
}

// Things you do once rather than hold: done at the start of the next step,
// recorded on it, and played back on the same step.
function queue(cmd) {
  if (started && !playback) pending.push(cmd);
}
const _throwAim = new THREE.Vector3();
function runCommand([name, a, b, c]) {
  if (name === 'reload') player.startReload();
  else if (name === 'weapon') player.switchWeapon(a);
  else if (name === 'swap') player.switchWeapon(player.switchTo ? player.weapon.name : player.otherWeapon());
  else if (name === 'throw') player.startThrow(a == null ? null : _throwAim.set(a, b, c));
  else if (name === 'flashlight') player.toggleFlashlight();
  else if (name === 'shove') player.startShove();
  else if (name === 'wave') spawnWave();
}

// One fixed simulation step.
function simStep(dt, input, cmds) {
  seeded(() => {
    let presses = 0;
    for (const cmd of cmds) {
      if (cmd[0] === 'struggle') presses += cmd[1];
      else runCommand(cmd);
    }
    updateWorld(dt, input);
    grapple.update(dt, presses);
    pickups.update(dt, player, takePickup);
    throwables.update(dt);
    kickBodies();
  });
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
  zombie.onSever = severArm;
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
  const world = { player, zombies, grapple, nav };
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
  if (!playback) restart(); // a fresh, seeded, recorded run
  /** @type {HTMLElement} */ (document.activeElement)?.blur?.(); // or Space would "click" the hidden button
  if (fullscreen) enterFullscreen();
}
document.getElementById('play-fullscreen').addEventListener('click', () => startGame(true));
document.getElementById('play-window').addEventListener('click', () => startGame(false));
// Phones and tablets: say so up front rather than leaving them stuck.
if (matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches) {
  /** @type {HTMLElement} */ (startScreen.querySelector('.touch')).hidden = false;
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
  if (e.code === 'KeyP') params.paused = !params.paused;
  if (e.code === 'KeyV') cycleVisibility();
  if (e.code === 'KeyM') showToast(sound.toggleMute() ? 'Sound off (M)' : 'Sound on (M)');
  if (playback) {
    // Watching: 1/2/4 sets the speed, Enter leaves.
    if (e.code === 'Digit1') replaySpeed = 1;
    if (e.code === 'Digit2') replaySpeed = 2;
    if (e.code === 'Digit4') replaySpeed = 4;
    if (e.code === 'Enter') leaveReplay();
    return;
  }
  if (e.code === 'F8') {
    // Save the run so far: "something odd just happened, here it is".
    e.preventDefault();
    saveReplay();
  }
  const over = player.state === 'dead' || escaped;
  if (over && e.code === 'Enter') restart();
  if (over && e.code === 'KeyY') watchReplay(recorder.toJSON());
  if (over && e.code === 'KeyU') saveReplay();
  if (e.code === 'Space' || e.code === 'KeyE') strugglePresses++;
  if (e.code === 'Space') jumpQueued = true; // vault/climb when not grabbed
  if (e.code === 'KeyR') queue(['reload']);
  if (e.code === 'Digit1') queue(['weapon', 'rifle']);
  if (e.code === 'Digit2') queue(['weapon', 'pistol']);
  if (e.code === 'Digit3') queue(['weapon', 'knife']);
  if (e.code === 'KeyQ') queue(['swap']);
  if (e.code === 'KeyG') queue(lastAim ? ['throw', lastAim.x, lastAim.y, lastAim.z] : ['throw']);
  if (e.code === 'KeyF') queue(['flashlight']);
  if (DEV) {
    if (e.code === 'KeyN') queue(['wave']);
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
  if (e.button === 2) queue(['shove']);
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
let lastAimZone = null; // 'head' | 'body' | 'legs' when the cursor is on a zombie
function readInput() {
  let aimPoint = null;
  let zone = null;
  if (hasMouse) {
    raycaster.setFromCamera(mouse, camera);
    const ray = raycaster.ray;
    // Whatever body is under the cursor, exactly where: aim there (its head,
    // its legs, a crawler on the road). Over nothing, aim level at chest height.
    let best = null;
    for (const z of zombies) {
      if (z.dead) continue;
      const hit = z.raycast(ray.origin, ray.direction);
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    if (best) {
      aimPoint = aimHit.copy(ray.origin).addScaledVector(ray.direction, best.distance);
      zone = best.headshot ? 'head' : best.leg ? 'legs' : 'body';
    } else if (ray.intersectPlane(aimPlane, aimHit)) {
      aimPoint = aimHit;
    }
  }
  // To the centimetre, as the replay stores it.
  if (aimPoint) aimPoint.set(round(aimPoint.x), round(aimPoint.y), round(aimPoint.z));
  lastAim = aimPoint;
  lastAimZone = zone;
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
  fog.near = params.night ? dist * 0.92 : dist + 12;
  fog.far = params.night ? dist + params.fogRange : dist + 50;
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
  post.resize();
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
  replay: document.getElementById('replay'),
  replayInfo: document.querySelector('#replay .info'),
  replayBar: /** @type {HTMLElement} */ (document.querySelector('#replay .bar i')),
};

function updateReplayUI() {
  if (!playback) return;
  const state = playback.done ? 'over · <b>Enter</b> to play' : `${replaySpeed}×`;
  const drift = playback.desync !== null ? ` · <span class="drift">drifted at ${Math.round(playback.desync / 120)} s</span>` : '';
  const html = `<b>REPLAY</b> ${state}${drift}`;
  if (ui.replayInfo.innerHTML !== html) ui.replayInfo.innerHTML = html;
  ui.replayBar.style.width = `${playback.progress * 100}%`;
}

// Buttons on the end screens and the start screen; a dropped file plays too.
document.getElementById('dead-replay').addEventListener('click', () => watchReplay(recorder.toJSON()));
document.getElementById('won-replay').addEventListener('click', () => watchReplay(recorder.toJSON()));
document.getElementById('dead-save').addEventListener('click', saveReplay);
document.getElementById('won-save').addEventListener('click', saveReplay);
const replayFile = /** @type {HTMLInputElement} */ (document.getElementById('replay-file'));
document.getElementById('open-replay').addEventListener('click', () => replayFile.click());
replayFile.addEventListener('change', () => replayFile.files[0] && openReplayFile(replayFile.files[0]));
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (file) openReplayFile(file);
});
const timer = new THREE.Timer();
timer.connect(document);
const STEP = 1 / 120;
let hudTimer = 0;

function updateUI(real) {
  ui.health.style.width = `${Math.max(player.health / params.maxHealth, 0) * 100}%`;
  hurtFlash = Math.max(hurtFlash - real * 1.5, 0);
  const lowHealth = player.state !== 'dead' && player.health < params.maxHealth * 0.35 ? 0.35 : 0;
  // With post effects on, the frame itself shows the hurt (post.js).
  ui.hurt.style.opacity = params.postFX ? '0' : String(Math.max(hurtFlash, lowHealth));
  post.update(real, {
    hurt: hurtFlash,
    health: Math.max(player.health / params.maxHealth, 0),
    dead: player.state === 'dead',
    bloom: params.bloom * (params.night ? 1 : 0.3), // daylight surfaces are bright already
    vignette: params.vignette,
    grain: params.grain,
  });
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
  const aiming = started && !playback && player.state !== 'dead' && !escaped && hasMouse && lastAim;
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
    for (const z of ['head', 'body', 'legs']) ui.reticle.classList.toggle(z, lastAimZone === z);
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

// A machine that can't keep up drops the post effects (once) rather than
// the frame rate; turning them back on in the panel sticks.
const rate = { time: 0, frames: 0, slow: 0 };
let postDropped = false;
function watchFrameRate(elapsed) {
  if (postDropped || !params.postFX) return;
  // Frames per second over each second; two slow seconds in a row and it's off.
  rate.time += elapsed;
  rate.frames++;
  if (rate.time < 1) return;
  rate.slow = rate.frames / rate.time < 25 ? rate.slow + 1 : 0;
  rate.time = rate.frames = 0;
  if (rate.slow >= 2) {
    params.postFX = false;
    postDropped = true;
    console.info('RIGOR: frames are slow, post effects off');
  }
}

function frame(timestamp) {
  requestAnimationFrame(frame);
  timer.update(timestamp);
  const elapsed = timer.getDelta();
  const real = Math.min(elapsed, 0.1);
  watchFrameRate(Math.min(elapsed, 1)); // (a hidden tab's gap isn't a slow frame)
  deathSlow = Math.max(deathSlow - real, 0);
  const slow = (params.slowMo ? 0.25 : 1) * (deathSlow > 0 ? 0.3 : 1);
  const running = started && !params.paused;
  const dt = running ? real * params.timeScale * slow : 0;
  const stepDt = STEP * params.timeScale * slow; // slow motion: shorter steps, not fewer

  // Dev test scripts can set window.__rigorInput to drive the game alone.
  const override = import.meta.env.DEV && /** @type {any} */ (window).__rigorInput;
  const input = override ? { ...override } : readInput();
  // Fixed steps of real time; a tap (jump, struggle, a command) goes to the
  // first step this frame.
  if (running) acc += real * (playback ? replaySpeed : 1);
  let first = true;
  while (acc >= STEP) {
    acc -= STEP;
    if (playback) {
      if (playback.done) {
        acc = 0;
        break;
      }
      const s = playback.next();
      simStep(s.dt, s.input, s.cmds);
      if (playback.step % 120 === 0) playback.verify(worldFingerprint());
      continue;
    }
    input.jump = first && jumpQueued;
    const cmds = first ? pending : [];
    if (first && strugglePresses) cmds.push(['struggle', strugglePresses]);
    if (first) {
      jumpQueued = false;
      strugglePresses = 0;
      pending = [];
    }
    recorder?.record(stepDt, input, cmds);
    simStep(stepDt, input, cmds);
    if (recorder && recorder.step % 120 === 0) recorder.check(worldFingerprint());
    first = false;
  }
  if (!running) strugglePresses = 0;
  effects.update(dt);
  gore.update(dt);

  updateCamera(real);
  updateUI(real);
  updateSounds(dt, real);
  updateReplayUI();

  hudTimer -= real;
  if (DEV && hudTimer <= 0) {
    hudTimer = 0.1;
    const alive = zombies.filter((z) => !z.dead);
    const chasing = alive.filter((z) => z.state === 'chase').length;
    stats.textContent =
      `${player.getDebug()}\n` + `zombies ${alive.length} alive · ${chasing} chasing · kills ${kills}`;
  }

  if (params.postFX) post.render();
  else renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// Dev-only handle for poking at the game from the browser console.
if (import.meta.env.DEV) {
  // Run the world forward without rendering (the tab may be hidden in tests).
  const advance = (secs, input = NO_INPUT) => {
    for (let t = 0; t < secs; t += STEP) {
      simStep(STEP, { ...input }, []);
      gore.update(STEP);
    }
  };
  /** @type {any} */ (window).__rigor = { player, grapple, gore, params, zparams, level, nav, post, hurt: () => (hurtFlash = 1), watchReplay, get recorder() { return recorder; }, get playback() { return playback; }, worldFingerprint, pickups, sound, restart, startGame, advance, addZombie, get zombies() { return zombies; } };
}
