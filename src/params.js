// Every tunable "lever" lives here. The panel edits this object live.
export const DEFAULTS = {
  // Playback
  timeScale: 1,
  slowMo: false,
  paused: false,
  showSkeleton: false,

  // Movement
  runSpeed: 4.2, // Shift: sprint (also the top of the gait's speed range)
  jogSpeed: 2.6, // default movement
  walkSpeed: 1.3, // Ctrl: slow, careful walk
  acceleration: 14,
  aimTurnRate: 18,
  faceMouse: true,

  // Waist & spine
  maxHipOffset: 55, // degrees the legs may point away from the aim
  hipTurnRate: 10,
  legTurnRate: 360, // fastest the legs swing round while moving (degrees per second)
  pelvisTwistShare: 0.3, // how much of the waist twist the pelvis takes
  pivotStart: 45, // degrees the aim may turn from the legs before they step round
  pivotRate: 180, // degrees per second the legs turn on the spot
  maxTwist: 80, // most the waist can twist (degrees)
  gunLead: -13, // shoulders turned relative to the gun (degrees)

  // Torso physics
  leanAccel: 0.02,
  leanSpeed: 0.03,
  leanTurn: 0.045, // banking into a curve, per m/s² of sideways pull
  leanStiffness: 60,
  leanDamping: 9,
  maxLean: 25, // degrees

  // Height & bob
  hipHeight: 0.97, // nearly straight legs standing; walking, the stance leg straightens mid-stride
  crouch: 0.06,
  bobAmount: 0.035,
  hipSway: 0.03, // metres the hips shift over the stance foot
  hipSwing: 0.15, // hip turn per metre the feet are apart (radians)

  // Gait & feet
  strideBase: 1.0,
  strideScale: 0.33,
  dutyWalk: 0.62,
  dutyRun: 0.34,
  stepHeight: 0.14,
  footSpread: 0.11,
  footPivotRate: 4, // how fast a planted foot swivels on its ball to follow the legs (rad/s)
  footLead: 1.0,
  settleSpeed: 1.2,
  settleDistance: 0.1,

  // Hands & gun
  handStiffness: 500,
  handDampingRatio: 1.0,
  handMaxAccel: 120,
  contactTolerance: 0.02,
  gunRight: 0.08,
  gunUp: -0.04,
  gunFwd: 0.36,
  roundShoulders: 0.03,

  // Weapon & recoil
  fireRate: 600, // rounds per minute
  magSize: 30,
  autoReload: true,
  spread: 1.0, // degrees of random cone
  recoilKick: 1.4, // backward velocity impulse per shot (m/s)
  recoilClimb: 7, // muzzle-up angular impulse per shot (rad/s)
  recoilYaw: 2.5, // random sideways angular impulse (rad/s)
  recoilStiffness: 260,
  recoilDampingRatio: 0.75, // < 1 lets the gun bounce a little on return
  maxClimb: 30, // degrees
  torsoKick: 0.5, // how hard each shot rocks the upper body back
  cameraShake: 0.06,
  bulletDamage: 34,
  headshotMultiplier: 3,

  // Night (a visibility preset fills these in; the panel can fine-tune them)
  visibility: 'Day',
  night: false,
  ambientLight: 0.22, // overall sky light at night
  moonLight: 0.9,
  nearGlow: 2.5, // light around the player so you can see your footing
  fogRange: 20, // metres past the player before the fog swallows everything
  exposure: 1.0,

  // Flashlight (mounted under the barrel)
  flashlightOn: true,
  flashIntensity: 70,
  flashAngle: 21, // degrees, half-angle of the cone
  flashRange: 24,
  beamOpacity: 0.09, // visible beam in the fog

  // Grab & struggle
  maxHealth: 100,
  struggleGain: 0.11, // meter per Space press (split across grabbers)
  struggleDecay: 0.3, // meter lost per second
  biteTime: 2.2, // seconds until the first bite; each later bite comes 15% faster
  biteDamage: 34,
  graceTime: 1.2, // can't be grabbed again right after breaking free
  breakFreeShove: 3.5,
};

// Zombies share the humanoid body system, tuned slow, loose and broken.
export const ZOMBIE_DEFAULTS = {
  count: 8,
  wanderSpeed: 0.45,
  chaseSpeed: 1.25,
  turnRate: 3,
  detectRange: 11,
  hearingRange: 25,
  attackRange: 0.75,
  grabWindup: 0.35, // lunge time before the grab connects: back off to dodge it
  climbDelay: 4, // seconds a zombie paws at a car before clambering up after you
  climbSlowness: 2.2, // how many times slower than the player they climb
  health: 100,
  hitShove: 2.2,
  corpseTime: 30,

  limp: 0.6,
  hunch: 20, // degrees
  armReach: 0.45,

  // Humanoid body levers (same meaning as the player's).
  runSpeed: 1.6,
  acceleration: 4,
  maxHipOffset: 30,
  hipTurnRate: 4,
  legTurnRate: 180,
  pelvisTwistShare: 0.4,
  pivotStart: 45,
  pivotRate: 120,
  maxTwist: 80,
  leanAccel: 0.03,
  leanSpeed: 0.05,
  leanTurn: 0.04,
  leanStiffness: 30,
  leanDamping: 5,
  maxLean: 40,
  hipHeight: 0.88,
  crouch: 0.03,
  bobAmount: 0.05,
  hipSway: 0.045,
  hipSwing: 0.2,
  strideBase: 0.7,
  strideScale: 0.2,
  dutyWalk: 0.66,
  dutyRun: 0.56,
  stepHeight: 0.08,
  footSpread: 0.13,
  footPivotRate: 1.5,
  footLead: 1.0,
  settleSpeed: 0.8,
  settleDistance: 0.15,
  handStiffness: 60,
  handDampingRatio: 0.45,
  handMaxAccel: 30,
  roundShoulders: 0.07,
};

// How much you can see. Dark is the intended horror; the rest trade tension
// for readability.
export const VISIBILITY = {
  Dark: { night: true, ambientLight: 0.06, moonLight: 0.35, nearGlow: 1.6, fogRange: 13, exposure: 1.0 },
  Normal: { night: true, ambientLight: 0.22, moonLight: 0.9, nearGlow: 2.5, fogRange: 20, exposure: 1.25 },
  Bright: { night: true, ambientLight: 0.55, moonLight: 1.7, nearGlow: 3, fogRange: 32, exposure: 1.5 },
  Day: { night: false, exposure: 1.0 },
};

const TRANSIENT = ['paused', 'slowMo'];

export function pickKnown(source, defaults = DEFAULTS) {
  const out = {};
  for (const key of Object.keys(defaults)) {
    if (key in source && typeof source[key] === typeof defaults[key]) out[key] = source[key];
  }
  return out;
}

export function loadParams(defaults = DEFAULTS, key = 'procedural-shooter.params.v1') {
  const params = { ...defaults };
  try {
    const saved = localStorage.getItem(key);
    if (saved) Object.assign(params, pickKnown(JSON.parse(saved), defaults));
  } catch {
    // Storage unavailable or corrupt: fall back to defaults.
  }
  for (const k of TRANSIENT) if (k in defaults) params[k] = defaults[k];
  return params;
}

export const ZOMBIE_KEY = 'procedural-shooter.zombie.v1';

export function saveParams(params, key = 'procedural-shooter.params.v1') {
  try {
    localStorage.setItem(key, JSON.stringify(params));
    return true;
  } catch {
    return false;
  }
}

export function resetParams(params, defaults = DEFAULTS) {
  Object.assign(params, defaults);
}
