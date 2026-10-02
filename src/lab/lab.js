import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { Humanoid } from '../humanoid.js';
import { Player } from '../player.js';
import { Zombie } from '../zombie.js';
import { Gore } from '../gore.js';
import { heightAt, findLedge, collideCircle } from '../level.js';
import { traversalTiming } from '../traversal.js';
import { TRAVERSAL_KEYS, cloneKeys, saveKeys, resetKeys, hasSavedKeys } from '../traversal-keys.js';
import { loadParams, ZOMBIE_DEFAULTS, ZOMBIE_KEY } from '../params.js';
import { localPoint } from '../rig-utils.js';
import './lab.css';

// The lab: an open floor of test obstacles, an orbit camera, a timeline you
// can scrub, onion-skin ghosts, limb trails, and a live keyframe editor.
// It uses the game's own body and traversal code, so what you tune here is
// exactly what the game does.

const params = { ...loadParams(), flashlightOn: false, night: false, faceMouse: false, showSkeleton: false };
const zparams = loadParams(ZOMBIE_DEFAULTS, ZOMBIE_KEY);

// ---------------------------------------------------------------- scene

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#8e99ab');
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.05, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight('#e4ecff', '#4a5060', 1.5));
const sun = new THREE.DirectionalLight('#ffffff', 2.2);
sun.position.set(6, 12, -5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 50 });
sun.shadow.bias = -0.0005;
scene.add(sun);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 80).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: '#6d7480', roughness: 1 }),
);
floor.receiveShadow = true;
scene.add(floor);
const grid = new THREE.GridHelper(80, 160, '#5a6170', '#626a78');
grid.position.y = 0.002;
scene.add(grid);

// ---------------------------------------------------------------- test floor

const lab = { colliders: [], meshes: [] };
Humanoid.terrain = {
  heightAt: (x, z, maxY) => heightAt(lab, x, z, maxY),
  findLedge: (pos, dir) => findLedge(lab, pos, dir),
};

const mat = (color, roughness = 0.85) => new THREE.MeshStandardMaterial({ color, roughness });
function addBox(x, z, w, d, h, color, opts) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  mesh.position.set(x, h / 2, z);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  lab.colliders.push({ x, z, hx: w / 2, hz: d / 2, cos: 1, sin: 0, top: h, ...opts });
}
function addCar(x, z) {
  // Parked across the approach so you climb onto its side.
  const yaw = Math.PI / 2;
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;
  const paint = mat('#c9c6bd', 0.55);
  const glass = mat('#1c2530', 0.25);
  for (const [w, h, d, y, oz, m] of [
    [1.8, 0.7, 4.3, 0.6, 0, paint],
    [1.62, 0.55, 2.2, 1.22, -0.2, paint],
    [1.64, 0.4, 2.0, 1.24, -0.2, glass],
  ]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(0, y, oz);
    mesh.castShadow = mesh.receiveShadow = true;
    g.add(mesh);
  }
  scene.add(g);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  lab.colliders.push({ x, z, hx: 0.95, hz: 2.2, cos: c, sin: s, top: 0.95, climb: true });
  lab.colliders.push({ x: x - 0.2 * s, z: z - 0.2 * c, hx: 0.81, hz: 1.1, cos: c, sin: s, top: 1.5, climb: true });
}

// Each test is an obstacle in a row along X, approached from -Z.
const TESTS = [
  { name: 'Vault · barrier 0.85 m', depth: 0.6, build: (x) => addBox(x, 0, 2.4, 0.6, 0.85, '#8d8a83', { climb: true, vault: true }) },
  // 0.7 m: anything up to 0.6 m is just stepped onto (STEP_UP).
  { name: 'Vault · low wall 0.7 m', depth: 0.35, build: (x) => addBox(x, 0, 2.4, 0.35, 0.7, '#9a8f80', { climb: true, vault: true }) },
  { name: 'Climb · car side 0.95 m', depth: 1.9, build: (x) => addCar(x, 0) },
  { name: 'Climb · crate 1.0 m', depth: 1.2, build: (x) => addBox(x, 0, 1.6, 1.2, 1.0, '#8a7656') },
  { name: 'Climb · dumpster 1.34 m', depth: 1.1, build: (x) => addBox(x, 0, 2, 1.1, 1.34, '#2f4a3a') },
  { name: 'Climb · wall 1.6 m', depth: 1.6, build: (x) => addBox(x, 0, 2.6, 1.6, 1.6, '#6b6259') },
];
const SPACING = 5;
TESTS.forEach((t, i) => {
  t.x = (i - (TESTS.length - 1) / 2) * SPACING;
  t.yaw = 0;
  t.dir = new THREE.Vector3(0, 0, 1);
  t.start = new THREE.Vector3(t.x, 0, -t.depth / 2 - 0.55);
  t.focus = new THREE.Vector3(t.x, 0.9, -t.depth / 2);
  t.build(t.x);
});
for (const c of lab.colliders) if (c.climb === undefined) c.climb = true;

// ---------------------------------------------------------------- bodies

// Translucent stand-in used for onion skins, the A/B baseline, and sampling trails.
class Ghost extends Humanoid {
  constructor(color, opacity, p = params) {
    super(scene, p, { skin: color, shirt: color, pants: color, shoes: color });
    for (const m of Object.values(this.materials)) {
      m.transparent = true;
      m.opacity = opacity;
      m.depthWrite = false;
    }
    this.body.traverse((o) => (o.castShadow = false));
    this._settle();
  }

  // Hands held out front as if carrying a gun, unless the keys plant them.
  _setHandTargets() {
    localPoint(this.hands.left.target, this.chestPos, this.chestQuat, -0.08, -0.12, 0.38);
    localPoint(this.hands.right.target, this.chestPos, this.chestQuat, 0.1, -0.15, 0.1);
  }

  setVisible(on) {
    this.body.visible = on;
  }
}

const player = new Player(scene, params);
let zombie = null;
const gore = new Gore(scene);

const state = {
  test: 2,
  subject: 'player',
  free: false,
  playing: true,
  speed: 0.25,
  loop: true,
  k: 0,
  duration: 1,
  restartIn: 0,
  onion: true,
  onionCount: 4,
  trails: true,
  follow: false,
  compare: false,
  baseline: null,
  skeleton: false,
};

const test = () => TESTS[state.test];
const testType = () => (test().name.startsWith('Vault') ? 'vault' : 'climb');
const subject = () => (state.subject === 'zombie' ? zombie : player);
const subjectParams = () => (state.subject === 'zombie' ? zparams : params);

function placeAtStart(body) {
  body.traversal = null;
  body.traversalPose.pitch = body.traversalPose.roll = 0;
  body.gunStow = 0;
  body.vel.set(0, 0, 0);
  body.lean.set(0, 0);
  body.leanVel.set(0, 0);
  body.vy = 0;
  body.aimYaw = test().yaw;
  body.pos.copy(test().start);
  body._settle();
}

// Start the current test's move on `body` (optionally with other keys).
function beginMove(body, keys) {
  placeAtStart(body);
  const ledge = findLedge(lab, body.pos, test().dir);
  if (!ledge) return null;
  const timing = traversalTiming(ledge, body.pos.y);
  // Ghosts copy whoever is being tested, so zombie ghosts use both hands too.
  const isZombie = state.subject === 'zombie';
  body.startTraversal(ledge, {
    duration: timing.duration * (isZombie ? zparams.climbSlowness : 1),
    bothHands: isZombie || timing.bothHands,
    keys,
  });
  return ledge;
}

// Freeze `body` at an exact point k of the move (no springs, hands snapped).
function poseAt(body, k, keys) {
  if (!beginMove(body, keys)) return false;
  body.traversal.seek(Math.min(k, 0.999));
  body._updateTraversal(0);
  body._updateYaws(0);
  body._poseBody(0, true);
  return true;
}

function restartRun() {
  const body = subject();
  if (beginMove(body)) state.duration = body.traversal.duration;
  state.k = 0;
  state.restartIn = 0;
}

// ---------------------------------------------------------------- ghosts & trails

let ghosts = [];
const probe = new Ghost('#ffffff', 0);
probe.setVisible(false);
const baselineGhost = new Ghost('#ff9a3c', 0.35);
baselineGhost.setVisible(false);

function rebuildGhosts() {
  for (const g of ghosts) g.dispose();
  ghosts = [];
  for (let i = 0; i < state.onionCount; i++) {
    const shade = new THREE.Color('#4da3ff').lerp(new THREE.Color('#b37bff'), i / Math.max(state.onionCount - 1, 1));
    ghosts.push(new Ghost(`#${shade.getHexString()}`, 0.22, subjectParams()));
  }
}

const TRAIL_SAMPLES = 90;
const trails = [
  ['hips', '#ffd23f', (b) => b.pelvisPos],
  ['left hand', '#3fe07a', (b) => b.arms[0].wrist],
  ['right hand', '#3fd2e0', (b) => b.arms[1].wrist],
  ['left foot', '#ff5d73', (b) => b.legs[0].ankle],
  ['right foot', '#ff5dd8', (b) => b.legs[1].ankle],
].map(([name, color, get]) => {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_SAMPLES * 3), 3));
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
  line.renderOrder = 998;
  line.frustumCulled = false;
  scene.add(line);
  return { name, line, get };
});

function refreshHelpers() {
  const n = ghosts.length;
  ghosts.forEach((g, i) => {
    g.setVisible(state.onion && !state.free);
    if (state.onion && !state.free) poseAt(g, (i + 1) / (n + 1));
  });
  for (const t of trails) t.line.visible = state.trails && !state.free;
  if (state.trails && !state.free) {
    const arrays = trails.map((t) => t.line.geometry.attributes.position.array);
    for (let s = 0; s < TRAIL_SAMPLES; s++) {
      if (!poseAt(probe, s / (TRAIL_SAMPLES - 1))) break;
      trails.forEach((t, j) => t.get(probe).toArray(arrays[j], s * 3));
    }
    for (const t of trails) t.line.geometry.attributes.position.needsUpdate = true;
  }
  updateTicks();
}

// ---------------------------------------------------------------- camera

function setView(view) {
  const f = test().focus;
  const offsets = {
    side: [4.2, 1.2, 0.4],
    front: [0.6, 1.5, 4.2],
    back: [0.8, 2.2, -4.6],
    game: [0, 0.82 * 9, -0.57 * 9],
  };
  const [x, y, z] = offsets[view];
  controls.target.copy(f);
  camera.position.set(f.x + x, f.y + y, f.z + z);
  controls.update();
}
for (const b of document.querySelectorAll('#views button')) b.addEventListener('click', () => setView(b.dataset.view));

// ---------------------------------------------------------------- timeline

const ui = {
  play: document.getElementById('play'),
  scrub: document.getElementById('scrub'),
  ticks: document.getElementById('ticks'),
  readout: document.getElementById('readout'),
  speed: document.getElementById('speed'),
  loop: document.getElementById('loop'),
  info: document.getElementById('info'),
};
let scrubbing = false;

function setPlaying(on) {
  state.playing = on;
  ui.play.textContent = on ? '❚❚' : '▶';
  if (on && !subject().traversal) restartRun();
}

function seek(k) {
  setPlaying(false);
  state.k = THREE.MathUtils.clamp(k, 0, 1);
  poseAt(subject(), state.k);
  if (subject().traversal) state.duration = subject().traversal.duration;
}

ui.play.addEventListener('click', () => setPlaying(!state.playing));
ui.scrub.addEventListener('input', () => {
  scrubbing = true;
  seek(ui.scrub.value / 1000);
});
ui.scrub.addEventListener('change', () => (scrubbing = false));
const frameStep = () => 1 / 60 / Math.max(state.duration, 0.1);
document.getElementById('step-back').addEventListener('click', () => seek(state.k - frameStep()));
document.getElementById('step-fwd').addEventListener('click', () => seek(state.k + frameStep()));
ui.speed.addEventListener('change', () => (state.speed = Number(ui.speed.value)));
ui.loop.addEventListener('change', () => (state.loop = ui.loop.checked));

function updateTicks() {
  ui.ticks.replaceChildren(
    ...TRAVERSAL_KEYS[testType()].map((key, i) => {
      const s = document.createElement('span');
      s.style.left = `${key.t * 100}%`;
      s.title = `Key ${i + 1} · t ${key.t}`;
      s.addEventListener('click', () => seek(key.t));
      return s;
    }),
  );
}

// ---------------------------------------------------------------- panel

const gui = new GUI({ title: 'Lab' });
const testNames = Object.fromEntries(TESTS.map((t, i) => [t.name, i]));
const setup = gui.addFolder('Test');
setup.add(state, 'test', testNames).name('Obstacle').onChange(() => {
  buildKeysGui();
  restartRun();
  setView('side');
  refreshHelpers();
});
setup.add(state, 'subject', ['player', 'zombie']).name('Who').onChange(selectSubject);
setup.add({ run: () => setPlaying(true) || restartRun() }, 'run').name('Run again');

const view = gui.addFolder('Display');
view.add(state, 'onion').name('Onion skin').onChange(refreshHelpers);
view.add(state, 'onionCount', 1, 8, 1).name('Onion count').onChange(() => {
  rebuildGhosts();
  refreshHelpers();
});
view.add(state, 'trails').name('Limb trails').onChange(refreshHelpers);
view.add(state, 'follow').name('Camera follows');
view.add(state, 'skeleton').name('Skeleton (B)').onChange((on) => {
  player.setSkeleton(on);
  zombie?.setSkeleton(on);
});

const compare = gui.addFolder('Compare A/B');
compare
  .add(
    {
      set: () => {
        state.baseline = cloneKeys(TRAVERSAL_KEYS);
        state.compare = true;
        compare.controllers.forEach((c) => c.updateDisplay());
      },
    },
    'set',
  )
  .name('Set baseline = current keys');
compare.add(state, 'compare').name('Show baseline (orange)').listen();

const free = gui.addFolder('Free walk').close();
free.add(state, 'free').name('Walk around (WASD, Space)').onChange((on) => {
  if (on && state.subject !== 'player') {
    state.subject = 'player';
    selectSubject();
  }
  setPlaying(!on);
  if (on) placeAtStart(player);
  refreshHelpers();
});
free.add({ reload: () => player.startReload() }, 'reload').name('Reload');
free.add({ fire: () => (fireUntil = performance.now() + 1000) }, 'fire').name('Fire for 1 s');
const dirToward = (dx, dz) => new THREE.Vector3(dx, 0, dz).normalize();
free.add({ arms: () => player.die('arms', [dirToward(1, 0.3)], gore) }, 'arms').name('Die: arm torn off');
free.add({ halves: () => player.die('halves', [dirToward(1, 0.2), dirToward(-1, -0.2)], gore) }, 'halves').name('Die: torn in half');
free
  .add(
    {
      reset: () => {
        gore.clear();
        player.reset(test().start);
        player.setSkeleton(state.skeleton);
      },
    },
    'reset',
  )
  .name('New body');

let keysFolder = null;
function buildKeysGui() {
  keysFolder?.destroy();
  const type = testType();
  keysFolder = gui.addFolder(`Keys · ${type}`);
  TRAVERSAL_KEYS[type].forEach((key, i) => {
    const f = keysFolder.addFolder(`Key ${i + 1} · t ${key.t}`).close();
    f.add(key, 't', 0.01, 1, 0.01).onFinishChange(() => f.title(`Key ${i + 1} · t ${key.t}`));
    const p = key.pelvis;
    f.add(p, 'a', -1.5, 2, 0.01).name(`hips along · from ${p.aFrom}`);
    f.add(p, 'u', -1.5, 1.5, 0.01).name(`hips height · from ${p.uFrom}`);
    f.add(p, 's', -0.6, 0.6, 0.01).name('hips sideways');
    f.add(key, 'pitch', -0.6, 1.6, 0.01).name('lean forward');
    f.add(key, 'roll', -1, 1, 0.01).name('lean right');
    f.add(key, 'hipYaw', -1.6, 1.6, 0.01).name('hips turn');
    f.add(key, 'stow', 0, 1, 0.01).name('gun swung aside');
    key.hands.forEach((h, hi) => {
      if (!h) return;
      const n = hi ? 'R hand' : 'L hand';
      f.add(h, 'a', -0.5, 1, 0.01).name(`${n} along`);
      f.add(h, 's', -0.6, 0.6, 0.01).name(`${n} sideways`);
      f.add(h, 'u', -0.5, 0.5, 0.01).name(`${n} height`);
      f.add(h, 'w', 0, 1, 0.01).name(`${n} grip`);
    });
    key.feet.forEach((ft, fi) => {
      const n = fi ? 'R foot' : 'L foot';
      if (typeof ft === 'string') {
        f.add({ mode: ft }, 'mode').name(n).disable();
        return;
      }
      f.add(ft, 'a', -1, 2, 0.01).name(`${n} along · from ${ft.aFrom}`);
      f.add(ft, 's', -0.6, 0.6, 0.01).name(`${n} sideways`);
      f.add(ft, 'u', -1.5, 1, 0.01).name(`${n} height · from ${ft.uFrom}`);
    });
  });
  keysFolder.onChange(() => {
    if (!state.playing) poseAt(subject(), state.k);
    refreshHelpers();
  });
}

const saving = gui.addFolder('Save keys');
const status = { text: hasSavedKeys() ? 'Using saved keys' : 'Using keys from code' };
const flash = (text) => {
  status.text = text;
  setTimeout(() => (status.text = hasSavedKeys() ? 'Using saved keys' : 'Using keys from code'), 2000);
};
saving.add({ save: () => flash(saveKeys() ? 'Saved: the game uses these now' : 'Could not save') }, 'save').name('Save (game uses them)');
saving
  .add(
    {
      copy: async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify(TRAVERSAL_KEYS, null, 2));
          flash('Copied JSON');
        } catch {
          flash('Clipboard blocked');
        }
      },
    },
    'copy',
  )
  .name('Copy JSON');
saving
  .add(
    {
      reset: () => {
        resetKeys();
        buildKeysGui();
        refreshHelpers();
        if (!state.playing) poseAt(subject(), state.k);
        flash('Back to keys from code');
      },
    },
    'reset',
  )
  .name('Reset to code');
saving.add(status, 'text').name('').listen().disable();

function selectSubject() {
  if (state.subject === 'zombie' && !zombie) {
    zombie = new Zombie(scene, zparams, test().start.clone());
    zombie.setSkeleton(state.skeleton);
  }
  player.body.visible = state.subject === 'player';
  if (zombie) zombie.body.visible = state.subject === 'zombie';
  rebuildGhosts();
  restartRun();
  refreshHelpers();
}

// ---------------------------------------------------------------- input (free walk)

const keys = new Set();
let jumpQueued = false;
let fireUntil = 0;
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  keys.add(e.code);
  if (e.repeat) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (state.free) jumpQueued = true;
    else setPlaying(!state.playing);
  }
  if (e.code === 'Comma') seek(state.k - frameStep());
  if (e.code === 'Period') seek(state.k + frameStep());
  if (e.code === 'KeyB') {
    state.skeleton = !state.skeleton;
    player.setSkeleton(state.skeleton);
    zombie?.setSkeleton(state.skeleton);
    view.controllers.forEach((c) => c.updateDisplay());
  }
  if (e.code === 'KeyR' && state.free) player.startReload();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

const held = (c) => (keys.has(c) ? 1 : 0);
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
function freeInput() {
  camera.getWorldDirection(_fwd).setY(0).normalize();
  _right.crossVectors(_fwd, THREE.Object3D.DEFAULT_UP);
  const f = held('KeyW') - held('KeyS');
  const r = held('KeyD') - held('KeyA');
  const move = _fwd.clone().multiplyScalar(f).addScaledVector(_right, r);
  const input = {
    x: move.x,
    z: move.z,
    walk: keys.has('ControlLeft'),
    sprint: keys.has('ShiftLeft'),
    fire: performance.now() < fireUntil,
    jump: jumpQueued,
    aimPoint: null,
  };
  jumpQueued = false;
  return input;
}

// ---------------------------------------------------------------- loop

const ZERO = new THREE.Vector3();
const STEP = 1 / 120;

function stepPlaying(dt) {
  const body = subject();
  const total = dt * state.speed;
  const n = Math.max(1, Math.ceil(total / STEP));
  for (let i = 0; i < n; i++) {
    const h = total / n;
    if (body.traversal) {
      body._updateTraversal(h);
      body._updateYaws(h);
      body._updateLean(h);
      body._poseBody(h);
    } else {
      body._locomote(h, ZERO);
      body._updateBody(h);
      body._poseBody(h);
    }
  }
  if (body.traversal) {
    state.k = body.traversal.progress;
  } else {
    state.k = 1;
    state.restartIn += dt;
    if (state.restartIn > 0.8) {
      if (state.loop) restartRun();
      else setPlaying(false);
    }
  }
}

function stepFree(dt) {
  const input = freeInput();
  const n = Math.max(1, Math.ceil(dt / STEP));
  for (let i = 0; i < n; i++) {
    player.update(dt / n, input);
    input.jump = false;
    if (player.state !== 'dead' && !player.traversal) collideCircle(lab, player.pos, 0.3, player.pos.y);
  }
}

function updateInfo() {
  const body = subject();
  const tr = body.traversal;
  const lines = [
    `${test().name} · ${state.subject}${state.free ? ' · free walk' : ''}`,
    `t ${(state.k * 100).toFixed(1)}%  ·  ${(state.k * state.duration).toFixed(2)} / ${state.duration.toFixed(2)} s`,
  ];
  if (tr) {
    const keys = tr.keys;
    let seg = 0;
    while (seg < keys.length - 2 && state.k > keys[seg + 1].t) seg++;
    lines.push(`between key ${seg} and key ${seg + 1}`);
    lines.push(`hips ${(body.pelvisPos.y - tr.top).toFixed(2)} m from the top · lean ${(tr.pose.pitch * 57.3).toFixed(0)}°`);
  }
  lines.push(`hand error  L ${(body.hands.left.error * 100).toFixed(1)} cm · R ${(body.hands.right.error * 100).toFixed(1)} cm`);
  lines.push('Space play/pause · , . step a frame · drag to orbit · wheel to zoom');
  ui.info.textContent = lines.join('\n');
}

const timer = new THREE.Timer();
timer.connect(document);

function frame(timestamp) {
  requestAnimationFrame(frame);
  timer.update(timestamp);
  const dt = Math.min(timer.getDelta(), 0.05);

  if (state.free) stepFree(dt);
  else if (state.playing) stepPlaying(dt);
  gore.update(dt);

  baselineGhost.setVisible(state.compare && !!state.baseline && !state.free);
  if (baselineGhost.body.visible) poseAt(baselineGhost, state.k, state.baseline[testType()]);

  if (state.follow || state.free) {
    const target = subject().pelvisPos;
    const delta = target.clone().sub(controls.target).multiplyScalar(1 - Math.exp(-6 * dt));
    controls.target.add(delta);
    camera.position.add(delta);
  }
  controls.update();

  if (!scrubbing) ui.scrub.value = String(Math.round(state.k * 1000));
  ui.readout.textContent = `${Math.round(state.k * 100)}%`;
  updateInfo();
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------- go

rebuildGhosts();
buildKeysGui();
restartRun();
setView('side');
refreshHelpers();
setPlaying(true);
requestAnimationFrame(frame);

if (import.meta.env.DEV) window.__lab = { state, player, seek, poseAt, TESTS, setView, refreshHelpers };
