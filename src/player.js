import * as THREE from 'three';
import { Humanoid } from './humanoid.js';
import { traversalTiming } from './traversal.js';
import { Ragdoll } from './ragdoll.js';
import { WEAPONS, HOLSTERS, MELEE, buildWeaponMeshes } from './weapons.js';
import { DEG, wrapAngle, dampAngle, damp, localPoint, localDir, quatFrom } from './rig-utils.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();

const HOLSTER_TIME = 0.2; // seconds to put a gun away
const DRAW_TIME = 0.25; // and to bring the next one up
const SHOVE_TIME = 0.38;
const SHOVE_HIT = 0.1; // when in the thrust it connects
const THROW_TIME = 0.45;
const THROW_RELEASE = 0.24; // when the bottle leaves the hand
const GRAB_STAB_TIME = 0.75; // slow enough that two holding on is still a race against the bite
const GRAB_STAB_HIT = 0.5;
const smooth = (k) => k * k * (3 - 2 * k);

// Unit cone, apex at the origin, opening along +Z to radius 1 at z = 1.
const BEAM_GEOMETRY = new THREE.ConeGeometry(1, 1, 40, 1, true)
  .translate(0, -0.5, 0)
  .rotateX(-Math.PI / 2);

// Fake volumetric beam: brightest along the axis and near the lens,
// fading out toward the cone's silhouette and its far end.
const BEAM_MATERIAL = new THREE.ShaderMaterial({
  uniforms: {
    opacity: { value: 0.1 },
    color: { value: new THREE.Color('#fff1d6') },
  },
  vertexShader: /* glsl */ `
    varying float vAlong;
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
      vAlong = position.z;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vNormal = normalize(normalMatrix * normal);
      vView = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float opacity;
    uniform vec3 color;
    varying float vAlong;
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
      float edge = pow(abs(dot(normalize(vNormal), normalize(vView))), 2.0);
      float fade = pow(clamp(1.0 - vAlong, 0.0, 1.0), 1.8);
      float a = opacity * edge * fade;
      gl_FragColor = vec4(color * a, a);
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
});

const PLAYER_LOOK = {
  skin: '#e0ac86',
  shirt: '#3f86d4',
  pants: '#283447',
  shoes: '#1d2129',
  cap: '#24324f',
  brim: true,
};

export class Player extends Humanoid {
  constructor(scene, params) {
    super(scene, params, PLAYER_LOOK);

    this.gunPos = new THREE.Vector3();
    this.gunQuat = new THREE.Quaternion();
    this.reload = { active: false, step: -1, t: 0, label: 'Ready', steps: [] };
    this.magState = 'gun';
    this.drops = [];

    // Recoil is a set of springs on the gun: kick back, muzzle climb, sideways yaw.
    this.recoil = { back: 0, backVel: 0, pitch: 0, pitchVel: 0, yaw: 0, yawVel: 0 };
    this.dryFire = false; // trigger pulled on an empty gun with nothing to reload
    this.fireCooldown = 0;
    this.triggerWas = false;
    this.bloom = 0; // extra spread from firing fast (degrees), recovers over time
    this.spreadNow = params.spread; // the cone a shot can go in right now (degrees)
    this.onShot = null; // (muzzle: Vector3, dir: Vector3, damage: number) => void
    this.onShove = null; // (dir: Vector3) => void, at the moment a shove connects
    this.onWeaponEvent = null; // ('holster' | 'draw' | 'shove' | 'slash' | 'stab' | 'throw') => void, for sounds
    this.onMeleeFrame = null; // (tip, kind, alreadyHit: Set, dir) => void, each frame the blade can connect
    this.onGrabStab = null; // (zombie) => void, the knife going into whatever holds you
    this.onThrow = null; // (from: Vector3, to: Vector3) => void, a bottle leaving the hand
    this.onReloadEvent = null; // (step) => void, for sounds
    this.moveMode = 'jog';
    this.aimPitch = 0;
    this.parkourHint = null; // 'vault' | 'climb' | null

    this.health = params.maxHealth;
    this.state = 'normal'; // 'normal' | 'grabbed' | 'dead'
    this.grabbedBy = null;
    this.stun = 0; // knocked back and reeling: no control for a moment
    this.deathPos = new THREE.Vector3();

    this._buildGuns();
    this._resetWeapons();
    this._settle();
  }

  // Stand at `position` with feet and hands settled.
  teleport(position) {
    this.pos.copy(position);
    this.vel.set(0, 0, 0);
    this._settle();
  }

  // Fresh body at `spawn` (the old one may be in pieces).
  reset(spawn = new THREE.Vector3()) {
    this.dispose();
    for (const d of this.drops) this.body.remove(d.mesh);
    this.drops = [];
    this._buildBody(PLAYER_LOOK);
    this._buildGuns();
    this._resetWeapons();
    this.pos.copy(spawn);
    this.vel.set(0, 0, 0);
    this.accel.set(0, 0, 0);
    this.lean.set(0, 0);
    this.leanVel.set(0, 0);
    this.health = this.params.maxHealth;
    this.state = 'normal';
    this.grabbedBy = null;
    this.stun = 0;
    this.traversal = null;
    this.ragdoll = null;
    this.traversalPose.pitch = this.traversalPose.roll = 0;
    this.vy = 0;
    this.aimPitch = 0;
    this.aimConverge = 0;
    this._settle();
  }

  // ---------------------------------------------------------------- guns

  _buildGuns() {
    this.lensMaterial = new THREE.MeshBasicMaterial({ color: '#fff6dc' });
    this.weapons = {};
    for (const name of Object.keys(WEAPONS)) {
      const meshes = buildWeaponMeshes(name, this.lensMaterial);
      this.body.add(meshes.group, meshes.mag);
      this.weapons[name] = { name, def: WEAPONS[name], ...meshes, ammo: 0, chambered: false, slideBack: 0, slideLocked: false };
    }

    // One flashlight, clipped to whichever gun is in hand so the beam follows
    // the aim and every bit of recoil.
    this.flashlight = new THREE.SpotLight('#fff1d6', 0, 24, 0.37, 0.55, 1.3);
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(1024, 1024);
    this.flashlight.shadow.camera.near = 0.2;
    this.flashlight.shadow.bias = -0.0004;
    this.flashlight.shadow.normalBias = 0.02;
    this.beam = new THREE.Mesh(BEAM_GEOMETRY, BEAM_MATERIAL);

    // A bottle in the free hand while winding up a throw.
    const glass = new THREE.MeshStandardMaterial({ color: '#3f6b3a', roughness: 0.2, transparent: true, opacity: 0.85 });
    this.bottleMesh = new THREE.Group();
    const b1 = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.16, 10), glass);
    const b2 = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.02, 0.08, 8), glass);
    b2.position.y = 0.12;
    this.bottleMesh.add(b1, b2);
    this.bottleMesh.visible = false;
    this.body.add(this.bottleMesh);

    this.casingGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.03, 6).rotateX(Math.PI / 2);
    this.casingMat = new THREE.MeshStandardMaterial({ color: '#d9b45a', metalness: 0.8, roughness: 0.35 });
  }

  // Full mags (and a round chambered), the rifle in hand.
  _resetWeapons() {
    const p = this.params;
    for (const w of Object.values(this.weapons)) {
      w.ammo = w.def.melee ? 0 : (w.def.stat.magSize ?? p.magSize);
      w.chambered = w.def.chamber;
      w.slideLocked = false;
      w.slideBack = 0;
    }
    this.reserves = { rifle: p.startReserve, pistol: p.startPistolReserve ?? 15 };
    Object.assign(this.recoil, { back: 0, backVel: 0, pitch: 0, pitchVel: 0, yaw: 0, yawVel: 0 });
    Object.assign(this.reload, { active: false, step: -1, t: 0, label: 'Ready', steps: [] });
    this.magState = 'gun';
    this.dryFire = false;
    this.bloom = 0;
    this.switchTo = null;
    this.drawBlend = 1; // 1 = gun up and ready, 0 = put away
    this.shoveT = -1;
    this.shoveCooldown = 0;
    this.meleeT = -1;
    this.meleeNext = 'slash';
    this.grabStabT = -1;
    this.throwT = -1;
    this.bottles = p.startBottles ?? 1;
    this.fireWas = false;
    this.lastWeapon = null;
    this.weapon = null;
    this._equip('rifle');
  }

  _equip(name) {
    if (this.weapon && this.weapon.name !== name) this.lastWeapon = this.weapon.name;
    this.weapon = this.weapons[name];
    const def = this.weapon.def;
    if (def.melee) {
      // No light on a knife: the free hand holds the torch out in front.
      this.flashlight.position.set(0, 0.01, 0.07);
      this.flashlight.target.position.set(0, 0.01, 6);
      this.beam.position.copy(this.flashlight.position);
      this.arms[0].hand.add(this.flashlight, this.flashlight.target, this.beam);
      return;
    }
    this.flashlight.position.set(0, name === 'rifle' ? -0.045 : -0.033, def.torch);
    this.flashlight.target.position.set(0, this.flashlight.position.y, def.torch + 6);
    this.beam.position.copy(this.flashlight.position);
    this.weapon.group.add(this.flashlight, this.flashlight.target, this.beam);
  }

  // A lever for the gun in hand: its own value if it has one, else the panel's.
  stat(key) {
    return this.weapon.def.stat[key] ?? this.params[key];
  }

  get gun() {
    return this.weapon.group;
  }
  get mag() {
    return this.weapon.mag;
  }
  get ammo() {
    return this.weapon.ammo;
  }
  set ammo(v) {
    this.weapon.ammo = v;
  }
  get magSize() {
    return this.stat('magSize');
  }
  // Rounds ready to fire: the mag, plus the one in the chamber.
  get rounds() {
    return this.weapon.ammo + (this.weapon.def.chamber && this.weapon.chambered ? 1 : 0);
  }
  get reserve() {
    return this.weapon.def.ammo ? this.reserves[this.weapon.def.ammo] : 0;
  }
  set reserve(v) {
    if (this.weapon.def.ammo) this.reserves[this.weapon.def.ammo] = v;
  }
  get weaponReady() {
    return !this.switchTo && this.drawBlend >= 0.999 && this.shoveT < 0 && this.meleeT < 0 && this.throwT < 0;
  }

  // Put the gun in hand away and draw another (1/2 or Q). Not mid-reload,
  // mid-climb or while something has hold of you.
  switchWeapon(name) {
    if (!this.weapons[name] || this.state !== 'normal' || this.traversal || this.reload.active) return;
    if (this.meleeT >= 0 || this.throwT >= 0) return;
    if (name === this.weapon.name && !this.switchTo) return;
    if (this.switchTo !== name) this.onWeaponEvent?.('holster');
    this.switchTo = name === this.weapon.name ? null : name;
  }

  // Q goes back to the last weapon used (or the next one along).
  otherWeapon() {
    if (this.lastWeapon && this.lastWeapon !== this.weapon.name) return this.lastWeapon;
    return Object.keys(this.weapons).find((n) => n !== this.weapon.name);
  }

  // Knife: alternate a slash and a stab on each click.
  startMelee() {
    if (!this.weapon.def.melee || !this.weaponReady || this.state !== 'normal') return;
    this.meleeKind = this.meleeNext;
    this.meleeNext = this.meleeKind === 'slash' ? 'stab' : 'slash';
    this.meleeT = 0;
    this.meleeHits = new Set();
    this.onWeaponEvent?.(this.meleeKind);
  }

  // Throw a bottle at `target` (G). Lands where it's aimed (up to 13 m) and
  // breaks loudly: anything that hasn't seen you goes to look.
  startThrow(target) {
    if (!target || this.bottles <= 0 || this.state !== 'normal' || this.traversal) return;
    if (this.reload.active || this.switchTo || this.throwT >= 0 || this.meleeT >= 0 || this.shoveT >= 0) return;
    this.throwTarget = target.clone();
    _v1.subVectors(this.throwTarget, this.pos).setY(0);
    if (_v1.length() > 13) this.throwTarget.copy(this.pos).addScaledVector(_v1.setLength(13), 1);
    this.throwT = 0;
    this.thrown = false;
    this.onWeaponEvent?.('throw');
  }

  // Shove whatever is in front with the gun (right click): a short thrust
  // that knocks zombies back and stops a lunge. A brief cooldown.
  startShove() {
    if (this.shoveT >= 0 || this.shoveCooldown > 0 || this.state !== 'normal' || this.traversal) return;
    if (this.reload.active || this.switchTo || this.stun > 0) return;
    this.shoveT = 0;
    this.shoveHit = false;
    this.shoveCooldown = this.params.shoveCooldown ?? 0.8;
    this.onWeaponEvent?.('shove');
  }

  _updateHands(dt) {
    // Holstering, then drawing.
    if (this.switchTo) {
      this.drawBlend = Math.max(this.drawBlend - dt / HOLSTER_TIME, 0);
      if (this.drawBlend <= 0) {
        this._equip(this.switchTo);
        this.switchTo = null;
        this.bloom = 0;
        this.onWeaponEvent?.('draw');
      }
    } else {
      this.drawBlend = Math.min(this.drawBlend + dt / DRAW_TIME, 1);
    }
    if (this.meleeT >= 0) {
      const m = MELEE[this.meleeKind];
      this.meleeT += dt;
      if (this.meleeT >= m.from && this.meleeT <= m.to + dt) {
        this.onMeleeFrame?.(localPoint(_v2, this.gunPos, this.gunQuat, ...this.weapon.def.muzzle), this.meleeKind, this.meleeHits, _v1.set(Math.sin(this.aimYaw), 0, Math.cos(this.aimYaw)));
      }
      if (this.meleeT >= m.time || this.state !== 'normal') this.meleeT = -1;
    }
    if (this.throwT >= 0) {
      this.throwT += dt;
      if (!this.thrown && this.throwT >= THROW_RELEASE) {
        this.thrown = true;
        this.bottles--;
        this.onThrow?.(this.arms[0].wrist.clone(), this.throwTarget);
      }
      if (this.throwT >= THROW_TIME || this.state !== 'normal') this.throwT = -1;
    }
    this.shoveCooldown = Math.max(this.shoveCooldown - dt, 0);
    if (this.shoveT >= 0) {
      this.shoveT += dt;
      if (!this.shoveHit && this.shoveT >= SHOVE_HIT) {
        this.shoveHit = true;
        this.onShove?.(_v1.set(Math.sin(this.aimYaw), 0, Math.cos(this.aimYaw)));
      }
      if (this.shoveT >= SHOVE_TIME || this.state !== 'normal') this.shoveT = -1;
    }
  }

  // ---------------------------------------------------------------- update

  update(dt, input) {
    const p = this.params;
    if (this.state === 'dead') {
      // The pieces fall and roll where they were thrown.
      this.ragdoll?.update(dt);
      this.ragdoll?.apply();
      this._updateDrops(dt);
      return;
    }
    const grabbed = this.state === 'grabbed' && this.grabbedBy;

    // Mid-vault or mid-climb: the path drives the body, no other input.
    if (this.traversal) {
      this._updateTraversal(dt);
      this._updateRecoil(dt);
      this._updateYaws(dt);
      this._updateLean(dt);
      this._updateDrops(dt);
      this._poseBody(dt);
      return;
    }

    _v1.set(input.x, 0, input.z);
    if (_v1.lengthSq() > 1) _v1.normalize();

    // Vault/climb toward where you're moving, or where you're facing if still.
    const canParkour =
      !grabbed && this.state === 'normal' && !this.reload.active && this.vy === 0 && this.stun <= 0 && !this.switchTo;
    if (_v1.lengthSq() > 0.01) _v2.copy(_v1).normalize();
    else _v2.set(Math.sin(this.aimYaw), 0, Math.cos(this.aimYaw));
    const ledge = canParkour ? Humanoid.terrain.findLedge(this.pos, _v2) : null;
    this.parkourHint = ledge?.type ?? null;
    if (ledge && input.jump) {
      // Vault one-handed with the gun kept; climb with both hands, gun swung aside.
      this.startTraversal(ledge, traversalTiming(ledge, this.pos.y));
      this.parkourHint = null;
      this.shoveT = -1;
      // Start moving this frame; skipping it is a one-frame stall.
      this._updateTraversal(dt);
      this._updateRecoil(dt);
      this._updateYaws(dt);
      this._updateLean(dt);
      this._updateDrops(dt);
      this._poseBody(dt);
      return;
    }
    // Walk wins over sprint so a careful player is never surprised.
    this.moveMode = input.walk ? 'walk' : input.sprint ? 'sprint' : 'jog';
    // Badly hurt you favour one leg: it lifts less and takes weight briefly, and you're slower.
    const hurt = this.health < p.maxHealth * 0.35;
    this.feet[1].stepScale = hurt ? 0.55 : 1;
    this.feet[1].dutyScale = hurt ? 0.8 : 1;
    const topSpeed = { walk: p.walkSpeed, jog: p.jogSpeed, sprint: p.runSpeed }[this.moveMode] * this.weapon.def.moveSpeed * (hurt ? 0.85 : 1);
    // Held in place while grabbed; knocked back, you slide with the blow.
    this.stun = Math.max(this.stun - dt, 0);
    const reeling = this.stun > 0;
    this._locomote(dt, grabbed || reeling ? _v1.set(0, 0, 0) : _v1.multiplyScalar(topSpeed), reeling ? 0.2 : 1);

    let aimTarget = this.aimYaw;
    if (grabbed) {
      // Face whoever has hold of you.
      aimTarget = Math.atan2(this.grabbedBy.pos.x - this.pos.x, this.grabbedBy.pos.z - this.pos.z);
    } else if (p.faceMouse && input.aimPoint) {
      const dx = input.aimPoint.x - this.pos.x;
      const dz = input.aimPoint.z - this.pos.z;
      if (dx * dx + dz * dz > 0.16) aimTarget = Math.atan2(dx, dz);
      // Point the gun at the aim point itself, up or down: a head, the legs,
      // a crawler on the road, or (from a car roof) chest height on the
      // ground. And angle it in a touch, since it's held off to one side of
      // the body, so the shot goes where the reticle is.
      const gx = input.aimPoint.x - this.gunPos.x;
      const gz = input.aimPoint.z - this.gunPos.z;
      const flat = Math.max(Math.hypot(gx, gz), 0.8);
      const pitch = THREE.MathUtils.clamp(Math.atan2(this.gunPos.y - input.aimPoint.y, flat), -0.5, 0.8);
      this.aimPitch = damp(this.aimPitch, pitch, 14, dt);
      const converge = THREE.MathUtils.clamp(wrapAngle(Math.atan2(gx, gz) - this.aimYaw), -0.25, 0.25);
      this.aimConverge = damp(this.aimConverge ?? 0, flat > 0.9 ? converge : 0, 14, dt);
    } else if (!p.faceMouse && this.speed > 0.3) {
      aimTarget = Math.atan2(this.vel.x, this.vel.z);
    }
    this.aimYaw = dampAngle(this.aimYaw, aimTarget, p.aimTurnRate, dt);
    this.chestYawOffset = p.gunLead * DEG;

    // Grabbed with a knife in hand: a click drives it into the head of
    // whatever has hold of you, instead of only struggling.
    const firePressed = input.fire && !this.fireWas;
    this.fireWas = input.fire;
    if (grabbed && this.weapon.def.melee && firePressed && this.grabStabT < 0) {
      this.grabStabT = 0;
      this.grabStabTarget = this.grabbedBy;
      this.grabStabDone = false;
      this.onWeaponEvent?.('stab');
    }
    if (this.grabStabT >= 0) {
      this.grabStabT += dt;
      if (!this.grabStabDone && this.grabStabT >= GRAB_STAB_HIT) {
        this.grabStabDone = true;
        this.onGrabStab?.(this.grabStabTarget);
      }
      if (this.grabStabT >= GRAB_STAB_TIME) this.grabStabT = -1;
    }

    this._updateHands(dt);
    this._updateFiring(dt, input.fire && !grabbed);
    this._updateRecoil(dt);
    this._updateBody(dt);
    this._updateReload(dt);
    this._updateDrops(dt);
    this._poseBody(dt);
  }

  // A heavy blow (a brute's swing): health off, shoved along `dir`, and no
  // control until you find your feet.
  knock(dir, speed, damage) {
    this.health -= damage;
    this.vel.addScaledVector(dir, speed);
    this.stun = 0.7;
    this.shoveT = -1;
    this.jolt(dir, speed * 0.8);
  }

  // ---------------------------------------------------------------- death

  /**
   * Torn apart by whoever had hold. The body becomes a ragdoll cut at the
   * neck, waist, shoulders and hips (elbows and knees too, sometimes), and
   * every piece is flung off, mostly toward the zombie pulling that way, each
   * one bleeding from where it tore. `pulls` are ground directions from the
   * player toward each grabber. The guns go flying on their own.
   */
  die(mode, pulls, gore) {
    this.state = 'dead';
    this.grabbedBy = null;
    this.reload.active = false;
    this.deathPos.copy(this.pos);
    for (const m of this.markers) m.visible = false;
    if (this.magState !== 'gun') this.mag.visible = false;

    const up = new THREE.Vector3(0, 1, 0);
    const pull = pulls[0] ?? new THREE.Vector3(0, 0, 1);
    for (const w of Object.values(this.weapons)) {
      const inHand = w === this.weapon;
      gore.tear([w.group, !inHand || this.magState === 'gun' ? w.mag : null], w.group.position.clone(), {
        vel: pull.clone().multiplyScalar(inHand ? -2 : -0.8).add(new THREE.Vector3(0, inHand ? 2.5 : 1.5, 0)),
        angVel: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(18),
        rest: 0.04,
      });
    }

    this.ragdoll = new Ragdoll(this, { vel: this.vel });
    const rd = this.ragdoll;
    const coin = () => Math.random() < 0.5;
    const wounds = rd.dismember({ elbows: [coin(), coin()], knees: [coin(), coin()] });
    const strength = mode === 'halves' ? 3.2 : 2.6; // more of them, more violent
    rd.scatter(this.chestPos.clone(), pulls.length ? pulls : [pull], strength);

    // Every torn end bleeds: a burst now, then spurts that ride along with the piece.
    for (const w of wounds) {
      const end = rd.particle(w.index);
      const from = rd.particle(w.from);
      const dir = end.clone().sub(from).normalize();
      gore.spray(end.clone(), dir.clone().add(up), 14, 3);
      gore.wound(end.clone(), dir, {
        rate: 55,
        duration: 2.5 + Math.random() * 2,
        speed: 1.6,
        follow: (outPoint, outDir) => {
          outPoint.copy(rd.particle(w.index));
          outDir.subVectors(outPoint, rd.particle(w.from)).normalize();
        },
      });
    }
    gore.spray(this.chestPos.clone(), up, 70, 4);
    gore.pool(this.pos, 1.3, 6);
    for (const p of pulls) gore.pool(this.pos.clone().addScaledVector(p, 1.2), 0.7, 6);
  }

  // ---------------------------------------------------------------- firing

  _canFire() {
    const w = this.weapon;
    return w.def.chamber ? w.chambered : w.ammo > 0;
  }

  _updateFiring(dt, triggerHeld) {
    const p = this.params;
    const w = this.weapon;
    const pressed = triggerHeld && !this.triggerWas;
    this.triggerWas = triggerHeld;
    this.fireCooldown = Math.max(this.fireCooldown - dt, 0);

    // Accuracy: a tight cone standing still, wider on the move, wider still
    // while firing fast (it only settles once you ease off the trigger).
    // Walking (C) steadies it.
    this.sinceShot = (this.sinceShot ?? 1) + dt;
    if (this.sinceShot > 0.12) this.bloom = Math.max(this.bloom - this.stat('bloomRecover') * dt, 0);
    const moving = Math.min(this.speed / p.runSpeed, 1);
    this.spreadNow = (this.stat('spread') + this.stat('spreadMove') * moving + this.bloom) * (this.moveMode === 'walk' ? 0.75 : 1);

    if (!triggerHeld) this.dryFire = false;
    if (w.def.melee) {
      if (pressed) this.startMelee();
      return;
    }
    if (!triggerHeld || this.reload.active || !this.weaponReady) return;
    if (!w.def.auto && !pressed) return; // one shot per pull
    this.dryFire = false;
    if (!this._canFire()) {
      if (p.autoReload && this.reserve > 0) this.startReload();
      else if (this.reserve <= 0) this.dryFire = true;
      return;
    }
    if (w.def.auto) {
      while (this.fireCooldown <= 0 && this._canFire()) {
        this._shoot();
        this.fireCooldown += 60 / this.stat('fireRate');
      }
    } else if (this.fireCooldown <= 0) {
      this._shoot();
      this.fireCooldown = 60 / this.stat('fireRate');
    }
  }

  _shoot() {
    const w = this.weapon;
    const def = w.def;
    const r = this.recoil;
    // Spend the round: from the mag, or for a pistol the chambered one, with
    // the slide feeding the next (and locking back on an empty mag).
    if (def.chamber) {
      if (w.ammo > 0) w.ammo--;
      else {
        w.chambered = false;
        w.slideLocked = true;
      }
      w.slideBack = 1;
    } else {
      w.ammo--;
    }

    // Impulses go into velocities; the springs turn them into a kick and a settle.
    r.backVel += this.stat('recoilKick') * (0.85 + Math.random() * 0.3);
    r.pitchVel += this.stat('recoilClimb') * (0.8 + Math.random() * 0.4);
    r.yawVel += this.stat('recoilYaw') * (Math.random() * 2 - 1);

    // Rock the upper body backwards, against the aim direction.
    const kick = this.stat('torsoKick');
    this.leanVel.x -= Math.sin(this.aimYaw) * kick;
    this.leanVel.y -= Math.cos(this.aimYaw) * kick;

    // Anywhere in the current cone, evenly over its area. The cone is aimed
    // where the gun is pointed except for most of the muzzle climb: from
    // above you can't see a shot going high, so the climb is shown (the gun
    // rears up) but spends itself in the spread you can see instead.
    const muzzle = localPoint(new THREE.Vector3(), this.gunPos, this.gunQuat, ...def.muzzle);
    const s = Math.tan(this.spreadNow * DEG) * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    quatFrom(_q1, this.pitch * 0.15 - r.pitch * 0.15 + this.aimPitch, this.aimYaw + r.yaw + (this.aimConverge ?? 0), 0);
    const dir = localDir(new THREE.Vector3(), _q1, Math.cos(a) * s, Math.sin(a) * s, 1).normalize();
    this.bloom = Math.min(this.bloom + this.stat('bloomPerShot'), this.stat('bloomMax'));
    this.sinceShot = 0;
    this.onShot?.(muzzle, dir, this.stat('bulletDamage'));

    // Eject a casing out of the right side of the gun.
    const casing = new THREE.Mesh(this.casingGeo, this.casingMat);
    localPoint(casing.position, this.gunPos, this.gunQuat, ...def.ejection);
    casing.quaternion.copy(this.gunQuat);
    casing.castShadow = true;
    this.body.add(casing);
    const vel = localDir(new THREE.Vector3(), this.gunQuat, 1.6 + Math.random(), 1.4 + Math.random(), -0.3);
    // Lands on whatever is under it (a car roof, the sidewalk), not the road below.
    const floor = Humanoid.terrain.heightAt(casing.position.x, casing.position.z, this.pos.y + 0.6) + 0.006;
    this.drops.push({ mesh: casing, vel: vel.add(this.vel), spin: 25 + Math.random() * 20, floor, life: 3 });
  }

  _updateRecoil(dt) {
    const r = this.recoil;
    const k = this.stat('recoilStiffness');
    const c = 2 * Math.sqrt(k) * this.stat('recoilDampingRatio');
    r.backVel += (-k * r.back - c * r.backVel) * dt;
    r.pitchVel += (-k * r.pitch - c * r.pitchVel) * dt;
    r.yawVel += (-k * r.yaw - c * r.yawVel) * dt;
    r.back += r.backVel * dt;
    r.pitch = Math.min(r.pitch + r.pitchVel * dt, this.stat('maxClimb') * DEG);
    r.yaw += r.yawVel * dt;
    // The pistol's slide snaps back and forward, or stays locked open.
    for (const w of Object.values(this.weapons)) {
      if (!w.slide) continue;
      w.slideBack = w.slideLocked ? 1 : Math.max(w.slideBack - dt * 22, 0);
    }
  }

  // ---------------------------------------------------------------- reload

  // Nothing to reload from, or nothing to gain: the mag stays in. A pistol
  // reloaded from empty adds racking the slide to chamber a round.
  startReload() {
    const w = this.weapon;
    if (w.def.melee || this.reload.active || !this.weaponReady || this.reserve <= 0) return;
    if (w.ammo >= this.magSize && (!w.def.chamber || w.chambered)) return;
    this.reload.steps = w.def.reload(w.def.chamber && !w.chambered);
    this.reload.active = true;
    this._startReloadStep(0);
  }

  _startReloadStep(i) {
    const r = this.reload;
    if (i >= r.steps.length) {
      r.active = false;
      r.step = -1;
      r.label = 'Ready';
      return;
    }
    r.step = i;
    r.t = 0;
    r.label = `${i + 1}/${r.steps.length} ${r.steps[i].name}`;
    if (r.steps[i].start) this._reloadEvent(r.steps[i].start);
  }

  _updateReload(dt) {
    const r = this.reload;
    if (!r.active) return;
    r.t += dt;
    const step = r.steps[r.step];
    const touching = this.hands.left.error < this.params.contactTolerance;
    if ((touching && r.t >= (step.minTime ?? 0.06)) || r.t > 2.5) {
      if (step.end) this._reloadEvent(step.end);
      this._startReloadStep(r.step + 1);
    }
  }

  _reloadEvent(name) {
    this.onReloadEvent?.(name);
    const w = this.weapon;
    if (name === 'eject') {
      const drop = new THREE.Mesh(w.mag.geometry, w.mag.material);
      drop.position.copy(w.mag.position);
      drop.quaternion.copy(w.mag.quaternion);
      drop.castShadow = true;
      this.body.add(drop);
      this.drops.push({
        mesh: drop,
        vel: this.vel.clone().add(_v1.set(0, -0.5, 0)),
        spin: (Math.random() - 0.5) * 8,
        floor: Humanoid.terrain.heightAt(drop.position.x, drop.position.z, this.pos.y + 0.6) + 0.035,
        life: 4,
      });
      this.magState = 'none';
      // Rounds left in the old mag go back to the pile (no punishing a top-up).
      this.reserve += w.ammo;
      w.ammo = 0;
    } else if (name === 'take') {
      this.magState = 'hand';
    } else if (name === 'seat') {
      this.magState = 'gun';
      const n = Math.min(this.magSize, this.reserve);
      this.reserve -= n;
      w.ammo = n;
    } else if (name === 'rack' && w.ammo > 0) {
      // Slide forward: the top round goes into the chamber.
      w.ammo--;
      w.chambered = true;
      w.slideLocked = false;
    }
  }

  _updateDrops(dt) {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.life -= dt;
      if (d.mesh.position.y > d.floor) {
        d.vel.y -= 9.8 * dt;
        d.mesh.position.addScaledVector(d.vel, dt);
        d.mesh.rotation.x += d.spin * dt;
      } else {
        d.mesh.position.y = d.floor;
        d.vel.set(0, 0, 0);
      }
      if (d.life <= 0) {
        this.body.remove(d.mesh);
        this.drops.splice(i, 1);
      }
    }
  }

  // ---------------------------------------------------------------- pose hooks

  // Where a gun sits when it's put away: rifle across the back, pistol on the hip.
  _holsterPose(w, outPos, outQuat) {
    const h = HOLSTERS[w.def.holster];
    const [origin, quat] = h.frame === 'chest' ? [this.chestPos, this.chestQuat] : [this.pelvisPos, this.pelvisQuat];
    localPoint(outPos, origin, quat, ...h.p);
    outQuat.copy(quat).multiply(h.q);
  }

  _afterFrames() {
    // Recoil: negative pitch raises the muzzle; "back" pulls the gun toward the chest.
    const r = this.recoil;
    const w = this.weapon;
    quatFrom(this.gunQuat, this.pitch * 0.15 - r.pitch + this.aimPitch, this.aimYaw + r.yaw + (this.aimConverge ?? 0), 0);
    let fwd = this.stat('gunFwd') - r.back;
    let up = this.stat('gunUp') + r.pitch * 0.05;
    if (this.shoveT >= 0) {
      // The shove: thrust out hard, then draw back.
      const k = this.shoveT < SHOVE_HIT ? this.shoveT / SHOVE_HIT : Math.max(1 - (this.shoveT - SHOVE_HIT) / (SHOVE_TIME - SHOVE_HIT), 0);
      const s = k * k * (3 - 2 * k);
      fwd += 0.2 * s;
      up += 0.06 * s;
    }
    let right = this.stat('gunRight');
    if (this.meleeT >= 0) {
      // The knife's path: wind up, cut through, recover.
      const m = MELEE[this.meleeKind];
      const t = this.meleeT;
      const wind = smooth(Math.min(t / m.from, 1));
      const cut = smooth(Math.min(Math.max((t - m.from) / (m.to - m.from), 0), 1));
      const back = smooth(Math.min(Math.max((t - m.to) / (m.time - m.to), 0), 1));
      let yaw = 0;
      if (this.meleeKind === 'slash') {
        // Right to left across the front, blade flat.
        right += (0.22 * wind - 0.6 * cut) * (1 - back) + 0.0 * back;
        up += (0.12 * wind) * (1 - back) + 0.08 * cut * (1 - back);
        fwd += Math.sin(Math.PI * cut) * 0.22;
        yaw = (-0.9 * wind + 1.9 * cut) * (1 - back);
        quatFrom(this.gunQuat, this.aimPitch, this.aimYaw + yaw, -1.3 * (1 - back));
      } else {
        // Drawn back, then driven straight in at chest height.
        fwd += (-0.12 * wind + 0.46 * cut) * (1 - back);
        up += (0.14 * wind + 0.06 * cut) * (1 - back);
        right -= 0.12 * cut * (1 - back);
        quatFrom(this.gunQuat, this.aimPitch - 0.1 * (1 - back), this.aimYaw - 0.15 * cut * (1 - back), 0);
      }
    }
    localPoint(this.gunPos, this.chestPos, this.chestQuat, right, up, fwd);
    if (this.grabStabT >= 0 && this.grabStabTarget) {
      // Into the head of whatever has hold of you.
      const t = this.grabStabT;
      const reach = smooth(Math.min(t / GRAB_STAB_HIT, 1)) * (1 - smooth(Math.max((t - GRAB_STAB_HIT) / (GRAB_STAB_TIME - GRAB_STAB_HIT), 0)));
      this.gunPos.lerp(this.grabStabTarget.headPos, reach * 0.85);
      _v1.subVectors(this.grabStabTarget.headPos, this.gunPos);
      if (_v1.lengthSq() > 1e-4) this.gunQuat.slerp(_q1.setFromUnitVectors(_v2.set(0, 0, 1), _v1.normalize()), reach);
    }
    // Put away: mid-swap, or slung while climbing.
    const stow = Math.max(this.gunStow, 1 - this.drawBlend);
    if (stow > 0) {
      this._holsterPose(w, _v1, _q1);
      const s = stow * stow * (3 - 2 * stow);
      this.gunPos.lerp(_v1, s);
      this.gunQuat.slerp(_q1, s);
    }
    w.group.position.copy(this.gunPos);
    w.group.quaternion.copy(this.gunQuat);
    for (const o of Object.values(this.weapons)) {
      if (o !== w) this._holsterPose(o, o.group.position, o.group.quaternion);
      if (o.slide) o.slide.position.z = o.slideZ - 0.04 * o.slideBack;
    }
    this._updateFlashlight();
  }

  _updateFlashlight() {
    const p = this.params;
    // Off while the gun is put away (it points at the ground); a torch in the
    // hand (with the knife) stays on.
    const on = p.flashlightOn && (this.weapon.def.melee || (this.drawBlend > 0.5 && this.gunStow < 0.5));
    const angle = p.flashAngle * DEG;
    // Intensity 0 rather than visible = false: toggling lights recompiles shaders.
    this.flashlight.intensity = on ? p.flashIntensity * (this.weapon.name === 'rifle' ? 1 : 0.8) : 0;
    this.flashlight.angle = angle;
    this.flashlight.distance = p.flashRange;
    this.flashlight.shadow.camera.far = p.flashRange;
    this.lensMaterial.color.set(p.flashlightOn ? '#fff6dc' : '#3a3d44');
    this.beam.visible = on && p.beamOpacity > 0;
    BEAM_MATERIAL.uniforms.opacity.value = p.beamOpacity;
    const length = p.flashRange * 0.55;
    const radius = Math.tan(angle) * length;
    this.beam.scale.set(radius, radius, length);
  }

  toggleFlashlight() {
    this.params.flashlightOn = !this.params.flashlightOn;
  }

  _setHandTargets() {
    const { left, right } = this.hands;
    const def = this.weapon.def;
    localPoint(right.target, this.gunPos, this.gunQuat, ...def.grip);
    if (this.throwT >= 0) {
      // Bottle back over the left shoulder, then flung forward.
      const t = this.throwT;
      const wind = smooth(Math.min(t / THROW_RELEASE, 1));
      const fling = smooth(Math.min(Math.max((t - THROW_RELEASE * 0.7) / 0.12, 0), 1));
      const settle = smooth(Math.min(Math.max((t - THROW_RELEASE - 0.08) / (THROW_TIME - THROW_RELEASE - 0.08), 0), 1));
      localPoint(_v1, this.chestPos, this.chestQuat, -0.2, 0.28, -0.18);
      localPoint(_v2, this.chestPos, this.chestQuat, -0.12, 0.22, 0.52);
      left.target.lerpVectors(_v1, _v2, fling);
      if (t < THROW_RELEASE * 0.7) left.target.lerp(localPoint(_v2, this.chestPos, this.chestQuat, -0.24, -0.3, 0.1), 1 - wind);
      if (settle > 0) left.target.lerp(localPoint(_v2, this.chestPos, this.chestQuat, -0.16, 0.02, 0.36), settle);
      return;
    }
    if (this.state === 'grabbed' && this.grabbedBy) {
      // Free hand shoves against the zombie's chest.
      left.target.lerpVectors(this.chestPos, this.grabbedBy.chestPos, 0.75);
    } else if (this.reload.active) {
      const step = this.reload.steps[this.reload.step];
      const [origin, quat] = step.frame === 'gun' ? [this.gunPos, this.gunQuat] : [this.pelvisPos, this.pelvisQuat];
      localPoint(left.target, origin, quat, ...step.p);
    } else if (this.drawBlend < 0.6) {
      // Mid-swap the free hand drops to the side.
      localPoint(left.target, this.chestPos, this.chestQuat, -0.24, -0.42, 0.08);
    } else if (!def.support) {
      // With the knife, the torch held out in front at shoulder height.
      localPoint(left.target, this.chestPos, this.chestQuat, -0.16, 0.02, 0.36);
    } else {
      localPoint(left.target, this.gunPos, this.gunQuat, ...def.support);
    }
  }

  _afterPose() {
    // The bottle rides in the left hand until it's thrown.
    this.bottleMesh.visible = this.throwT >= 0 && !this.thrown;
    if (this.bottleMesh.visible) {
      this.bottleMesh.position.copy(this.arms[0].wrist);
      this.bottleMesh.quaternion.copy(this.arms[0].hand.quaternion);
    }
    for (const w of Object.values(this.weapons)) {
      const def = w.def;
      const inHand = w === this.weapon;
      const state = inHand ? this.magState : 'gun';
      w.mag.visible = state !== 'none';
      const pos = inHand ? this.gunPos : w.group.position;
      const quat = inHand ? this.gunQuat : w.group.quaternion;
      if (state === 'gun') localPoint(w.mag.position, pos, quat, ...def.magSeat);
      else if (state === 'hand') w.mag.position.copy(this.arms[0].wrist).add(localDir(_v1, quat, 0, def.magInHand, 0));
      w.mag.quaternion.copy(quat);
    }
  }

  // ---------------------------------------------------------------- debug

  getDebug() {
    const p = this.params;
    const deg = (r) => Math.round(r / DEG);
    let gait = 'idle';
    if (this.speed > 0.15) {
      const rel = wrapAngle(Math.atan2(this.vel.x, this.vel.z) - this.aimYaw) / DEG;
      if (Math.abs(rel) < 35) gait = 'forward';
      else if (Math.abs(rel) > 145) gait = 'backpedal';
      else gait = rel > 0 ? 'strafe left' : 'strafe right';
    }
    const foot = (f, name) =>
      `${name} ${f.planted ? 'planted' : 'swing  '} ${String(Math.round(f.progress * 100)).padStart(3)}%`;
    const cm = (h) => (h.error * 100).toFixed(1);
    return [
      `${this.speed.toFixed(2)} m/s · ${this.moveMode} · ${gait} · phase ${this.phase.toFixed(2)} · duty ${this.duty.toFixed(2)}`,
      `lower body ${deg(wrapAngle(this.lowerYaw - this.aimYaw))}° from aim · waist twist ${deg(this.twist)}° · gun lead ${p.gunLead}°`,
      `lean fwd ${deg(this.pitch)}° side ${deg(this.roll)}°`,
      `${foot(this.feet[0], 'L')}   ${foot(this.feet[1], 'R')}`,
      `hand error  right ${cm(this.hands.right)} cm · left ${cm(this.hands.left)} cm`,
      `${this.weapon.def.label} ${this.rounds}/${this.magSize} + ${this.reserve} · spread ${this.spreadNow.toFixed(1)}° · recoil back ${(this.recoil.back * 100).toFixed(1)} cm climb ${deg(this.recoil.pitch)}°`,
      `reload  ${this.reload.label}`,
      `health ${Math.max(Math.round(this.health), 0)}/${p.maxHealth} · ${this.state}`,
    ].join('\n');
  }
}
