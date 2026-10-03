import GUI from 'lil-gui';
import { DEFAULTS, ZOMBIE_DEFAULTS, ZOMBIE_KEY, VISIBILITY, saveParams, resetParams, pickKnown } from './params.js';

export function createPanel(params, zparams, player, { onSkeleton, onSpawn, onFullscreen, onEnvironment, onVisibility }) {
  const gui = new GUI({ title: 'Levers' });
  const refresh = () => gui.controllersRecursive().forEach((c) => c.updateDisplay());

  const play = gui.addFolder('Playback');
  play.add(params, 'timeScale', 0.05, 2, 0.05).name('Animation speed');
  play.add(params, 'slowMo').name('Slow motion ¼ (T)').listen();
  play.add(params, 'paused').name('Pause (P)').listen();
  play.add(params, 'showSkeleton').name('Skeleton (B)').listen().onChange(onSkeleton);

  const actions = gui.addFolder('Actions');
  actions.add({ fullscreen: onFullscreen }, 'fullscreen').name('Fullscreen + lock keys');
  actions.add({ spawn: onSpawn }, 'spawn').name('Spawn zombies (N)');
  actions.add({ reload: () => player.startReload() }, 'reload').name('Reload (R)');
  actions.add(player.reload, 'label').name('Stage').listen().disable();

  const night = gui.addFolder('Night & flashlight').close();
  night.add(params, 'visibility', Object.keys(VISIBILITY)).name('Visibility (V)').listen().onChange(onVisibility);
  night.add(params, 'exposure', 0.3, 3, 0.05).name('Exposure').listen().onChange(onEnvironment);
  night.add(params, 'night').name('Night').listen().onChange(onEnvironment);
  night.add(params, 'ambientLight', 0, 1, 0.01).name('Sky light').listen().onChange(onEnvironment);
  night.add(params, 'moonLight', 0, 3, 0.05).name('Moonlight').listen().onChange(onEnvironment);
  night.add(params, 'nearGlow', 0, 5, 0.05).name('Glow around you').listen().onChange(onEnvironment);
  night.add(params, 'fogRange', 3, 60, 0.5).name('Fog distance').listen();
  night.add(params, 'flashlightOn').name('Flashlight (F)').listen();
  night.add(params, 'flashIntensity', 0, 300, 5).name('Flashlight power');
  night.add(params, 'flashAngle', 5, 50, 1).name('Beam angle °');
  night.add(params, 'flashRange', 5, 50, 1).name('Beam range');
  night.add(params, 'beamOpacity', 0, 0.4, 0.01).name('Beam in fog');

  const zombies = gui.addFolder('Zombies').close();
  zombies.add(zparams, 'count', 1, 40, 1).name('Count per spawn');
  zombies.add(zparams, 'wanderSpeed', 0.1, 2, 0.05).name('Wander speed');
  zombies.add(zparams, 'chaseSpeed', 0.3, 5, 0.05).name('Chase speed');
  zombies.add(zparams, 'turnRate', 0.5, 15, 0.25).name('Turn rate');
  zombies.add(zparams, 'detectRange', 2, 40, 0.5).name('Sight range');
  zombies.add(zparams, 'hearingRange', 0, 60, 1).name('Gunshot hearing');
  zombies.add(zparams, 'health', 10, 500, 5).name('Health');
  zombies.add(zparams, 'hitShove', 0, 8, 0.1).name('Hit shove');
  zombies.add(zparams, 'limp', 0, 1, 0.05).name('Limp (on spawn)');
  zombies.add(zparams, 'hunch', 0, 45, 1).name('Hunch °');
  zombies.add(zparams, 'armReach', 0.1, 0.55, 0.01).name('Arm reach');
  zombies.add(zparams, 'handStiffness', 10, 300, 5).name('Arm stiffness');
  zombies.add(zparams, 'handDampingRatio', 0.1, 2, 0.05).name('Arm damping');
  zombies.add(zparams, 'stepHeight', 0, 0.25, 0.005).name('Step height');

  const grab = gui.addFolder('Grab & struggle').close();
  grab.add(params, 'maxHealth', 10, 500, 5).name('Player health');
  grab.add(params, 'struggleGain', 0.02, 0.5, 0.01).name('Per Space press');
  grab.add(params, 'struggleDecay', 0, 1.5, 0.05).name('Meter decay /s');
  grab.add(params, 'biteTime', 0.5, 6, 0.1).name('Time to bite (s)');
  grab.add(params, 'biteDamage', 1, 100, 1).name('Bite damage');
  grab.add(params, 'graceTime', 0, 4, 0.1).name('Grace after escape');
  grab.add(params, 'breakFreeShove', 0, 8, 0.1).name('Break-free shove');
  grab.add(zparams, 'attackRange', 0.4, 1.5, 0.05).name('Zombie grab range');
  grab.add(zparams, 'grabWindup', 0.05, 1.5, 0.05).name('Zombie lunge time');
  grab.add(zparams, 'climbDelay', 0.5, 20, 0.5).name('Zombie climb delay');
  grab.add(zparams, 'climbSlowness', 1, 5, 0.1).name('Zombie climb slowness');

  const move = gui.addFolder('Movement').close();
  move.add(params, 'runSpeed', 1, 8, 0.1).name('Sprint speed (Shift)');
  move.add(params, 'jogSpeed', 0.5, 6, 0.1).name('Normal speed');
  move.add(params, 'walkSpeed', 0.3, 4, 0.1).name('Walk speed (Ctrl)');
  move.add(params, 'acceleration', 2, 40, 0.5).name('Acceleration');
  move.add(params, 'aimTurnRate', 2, 40, 0.5).name('Aim turn rate');
  move.add(params, 'faceMouse').name('Face mouse').listen();

  const waist = gui.addFolder('Waist & spine').close();
  waist.add(params, 'maxHipOffset', 0, 90, 1).name('Max legs↔aim °');
  waist.add(params, 'hipTurnRate', 1, 30, 0.5).name('Hip turn rate');
  waist.add(params, 'legTurnRate', 90, 1080, 10).name('Max leg turn °/s');
  waist.add(params, 'pelvisTwistShare', 0, 1, 0.05).name('Pelvis twist share');
  waist.add(params, 'pivotStart', 10, 90, 1).name('Turn-in-place start °');
  waist.add(params, 'pivotRate', 60, 540, 10).name('Turn-in-place °/s');
  waist.add(params, 'maxTwist', 30, 120, 1).name('Max waist twist °');
  waist.add(params, 'gunLead', -40, 40, 1).name('Gun lead °');

  const torso = gui.addFolder('Torso physics').close();
  torso.add(params, 'leanAccel', 0, 0.08, 0.002).name('Lean from accel');
  torso.add(params, 'leanSpeed', 0, 0.1, 0.002).name('Lean from speed');
  torso.add(params, 'leanTurn', 0, 0.1, 0.002).name('Bank into turns');
  torso.add(params, 'leanStiffness', 5, 200, 1).name('Spring stiffness');
  torso.add(params, 'leanDamping', 0, 30, 0.5).name('Spring damping');
  torso.add(params, 'maxLean', 0, 45, 1).name('Max lean °');

  const height = gui.addFolder('Height & bob').close();
  height.add(params, 'hipHeight', 0.7, 1.0, 0.01).name('Hip height');
  height.add(params, 'crouch', 0, 0.2, 0.005).name('Run crouch');
  height.add(params, 'bobAmount', 0, 0.1, 0.002).name('Bob');
  height.add(params, 'hipSway', 0, 0.08, 0.002).name('Hip sway');
  height.add(params, 'hipSwing', 0, 0.5, 0.01).name('Hip swing');

  const gait = gui.addFolder('Gait & feet').close();
  gait.add(params, 'strideBase', 0.3, 1.5, 0.01).name('Stride base');
  gait.add(params, 'strideScale', 0, 0.6, 0.01).name('Stride per m/s');
  gait.add(params, 'dutyWalk', 0.52, 0.8, 0.01).name('Stance % walk');
  gait.add(params, 'dutyRun', 0.3, 0.7, 0.01).name('Stance % run');
  gait.add(params, 'stepHeight', 0, 0.35, 0.005).name('Step height');
  gait.add(params, 'footSpread', 0.03, 0.25, 0.005).name('Foot spread');
  gait.add(params, 'footLead', 0, 2, 0.05).name('Foot lead');
  gait.add(params, 'settleSpeed', 0.3, 3, 0.05).name('Settle step speed');
  gait.add(params, 'settleDistance', 0.02, 0.4, 0.01).name('Settle distance');

  const hands = gui.addFolder('Hands & gun').close();
  hands.add(params, 'handStiffness', 20, 2000, 10).name('Hand stiffness');
  hands.add(params, 'handDampingRatio', 0.2, 2, 0.05).name('Hand damping');
  hands.add(params, 'handMaxAccel', 5, 400, 5).name('Hand max accel');
  hands.add(params, 'contactTolerance', 0.005, 0.1, 0.005).name('Contact tolerance');
  hands.add(params, 'gunRight', -0.2, 0.3, 0.005).name('Gun right');
  hands.add(params, 'gunUp', -0.3, 0.2, 0.005).name('Gun up');
  hands.add(params, 'gunFwd', 0.15, 0.55, 0.005).name('Gun forward');
  hands.add(params, 'roundShoulders', -0.05, 0.1, 0.005).name('Round shoulders');

  const recoil = gui.addFolder('Weapon & recoil').close();
  recoil.add(params, 'fireRate', 60, 1200, 10).name('Fire rate (rpm)');
  recoil.add(params, 'magSize', 1, 100, 1).name('Mag size');
  recoil.add(params, 'autoReload').name('Auto reload');
  recoil.add(params, 'bulletDamage', 1, 200, 1).name('Bullet damage');
  recoil.add(params, 'headshotMultiplier', 1, 10, 0.5).name('Headshot ×');
  recoil.add(params, 'spread', 0, 10, 0.1).name('Spread °');
  recoil.add(params, 'recoilKick', 0, 5, 0.05).name('Kick back');
  recoil.add(params, 'recoilClimb', 0, 25, 0.25).name('Muzzle climb');
  recoil.add(params, 'recoilYaw', 0, 10, 0.1).name('Side wobble');
  recoil.add(params, 'recoilStiffness', 20, 800, 5).name('Return stiffness');
  recoil.add(params, 'recoilDampingRatio', 0.1, 2, 0.05).name('Return damping');
  recoil.add(params, 'maxClimb', 0, 60, 1).name('Max climb °');
  recoil.add(params, 'torsoKick', 0, 2, 0.05).name('Torso kick');
  recoil.add(params, 'cameraShake', 0, 0.3, 0.005).name('Camera shake');

  const settings = gui.addFolder('Settings');
  const status = { text: '' };
  const flash = (text) => {
    status.text = text;
    setTimeout(() => (status.text = ''), 1500);
  };
  settings
    .add(
      {
        save: () =>
          flash(saveParams(params) && saveParams(zparams, ZOMBIE_KEY) ? 'Saved' : 'Could not save'),
      },
      'save',
    )
    .name('Save settings');
  settings
    .add(
      {
        copy: async () => {
          try {
            await navigator.clipboard.writeText(JSON.stringify({ player: params, zombie: zparams }, null, 2));
            flash('Copied JSON');
          } catch {
            flash('Clipboard blocked');
          }
        },
      },
      'copy',
    )
    .name('Copy JSON');
  settings
    .add(
      {
        paste: async () => {
          try {
            const data = JSON.parse(await navigator.clipboard.readText());
            Object.assign(params, pickKnown(data.player ?? data, DEFAULTS));
            if (data.zombie) Object.assign(zparams, pickKnown(data.zombie, ZOMBIE_DEFAULTS));
            onSkeleton(params.showSkeleton);
          onEnvironment();
            refresh();
            flash('Pasted');
          } catch {
            flash('Paste failed');
          }
        },
      },
      'paste',
    )
    .name('Paste JSON');
  settings
    .add(
      {
        reset: () => {
          resetParams(params, DEFAULTS);
          resetParams(zparams, ZOMBIE_DEFAULTS);
          onSkeleton(params.showSkeleton);
          onEnvironment();
          refresh();
          flash('Reset to defaults');
        },
      },
      'reset',
    )
    .name('Reset all');
  settings.add(status, 'text').name('').listen().disable();

  return gui;
}
