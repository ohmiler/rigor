import * as THREE from 'three';

// Its own dice: looks and sounds never shift the game's seeded ones (replay.js).
const random = Math.random;

const MAX_DROPS = 700;
const UP = new THREE.Vector3(0, 1, 0);

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * A torn-off piece of a body. Either ballistic (flies, spins, bounces) or a
 * "topple" that pivots around a point on the ground like a falling plank.
 * The group's children keep their world-space transforms; the gib's matrix
 * moves them all as one rigid piece.
 */
class Gib {
  constructor(group, pivot, opts) {
    this.group = group;
    this.pivot = pivot.clone();
    this.offset = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.vel = opts.vel?.clone() ?? new THREE.Vector3();
    this.angVel = opts.angVel?.clone() ?? new THREE.Vector3();
    this.rest = opts.rest ?? 0.1; // pivot height when lying on the ground
    this.topple = opts.topple ?? null; // { axis, maxAngle, duration }
    this.t = 0;
    group.matrixAutoUpdate = false;
  }

  update(dt) {
    this.t += dt;
    if (this.topple) {
      const { axis, maxAngle, duration } = this.topple;
      const k = Math.min(this.t / duration, 1);
      const over = this.t - duration;
      const bounce = over > 0 ? Math.sin(over * 18) * Math.exp(-over * 9) * 0.08 : 0;
      this.quat.setFromAxisAngle(axis, maxAngle * k * k - bounce);
    } else {
      this.vel.y -= 9.8 * dt;
      this.offset.addScaledVector(this.vel, dt);
      const w = this.angVel.length();
      if (w > 1e-4) {
        _q.setFromAxisAngle(_v.copy(this.angVel).divideScalar(w), w * dt);
        this.quat.premultiply(_q);
      }
      if (this.pivot.y + this.offset.y < this.rest) {
        this.offset.y = this.rest - this.pivot.y;
        if (this.vel.y < 0) this.vel.y *= -0.25;
        this.vel.x *= 0.6;
        this.vel.z *= 0.6;
        this.angVel.multiplyScalar(0.55);
      }
    }
    _m.makeTranslation(this.pivot.x + this.offset.x, this.pivot.y + this.offset.y, this.pivot.z + this.offset.z);
    _m.multiply(_m2.makeRotationFromQuaternion(this.quat));
    _m.multiply(_m2.makeTranslation(-this.pivot.x, -this.pivot.y, -this.pivot.z));
    this.group.matrix.copy(_m);
    this.group.matrixWorldNeedsUpdate = true;
  }

  // Where a point that was at `p` (world, at the moment of tearing) is now.
  track(out, p) {
    return out.copy(p).applyMatrix4(this.group.matrix);
  }
}

// Blood drops, wound emitters, ground pools and gibs.
export class Gore {
  constructor(scene) {
    this.scene = scene;

    const dropMat = new THREE.MeshStandardMaterial({ color: '#5c0909', roughness: 0.35 });
    this.drops = new THREE.InstancedMesh(new THREE.SphereGeometry(0.018, 10, 6), dropMat, MAX_DROPS);
    this.drops.frustumCulled = false;
    this.drops.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.drops);
    this.dropState = Array.from({ length: MAX_DROPS }, () => ({
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      life: 0,
      landed: false,
      size: 1,
      stretch: 1,
      yaw: 0,
    }));
    this.nextDrop = 0;
    for (let i = 0; i < MAX_DROPS; i++) this.drops.setMatrixAt(i, _m.makeScale(0, 0, 0));

    this.poolMat = new THREE.MeshStandardMaterial({
      color: '#3d0505',
      roughness: 0.25,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    this.poolGeo = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
    this.pools = [];
    this.emitters = [];
    this.gibs = [];
  }

  spray(origin, dir, count, speed = 2.5, spread = 0.6) {
    for (let i = 0; i < count; i++) {
      const d = this.dropState[this.nextDrop];
      this.nextDrop = (this.nextDrop + 1) % MAX_DROPS;
      d.pos.copy(origin);
      d.vel
        .copy(dir)
        .add(_v.set(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).multiplyScalar(spread))
        .normalize()
        .multiplyScalar(speed * (0.4 + random() * 0.8));
      d.life = 25;
      d.landed = false;
      d.size = 0.4 + random() * random() * 1.2; // mostly small, a few big
      d.stretch = 0.6 + random() * 0.8;
      d.yaw = random() * Math.PI;
    }
  }

  pool(position, radius, growTime = 5) {
    const mesh = new THREE.Mesh(this.poolGeo, this.poolMat);
    mesh.position.set(position.x, 0.004, position.z);
    mesh.scale.setScalar(0.01);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.pools.push({ mesh, radius, growTime, t: 0 });
  }

  // A wound that keeps spurting. `point` is in world space at creation time;
  // if `gib` is given, the point (and direction) ride along with it, or
  // `follow(outPoint, outDir)` can say where it is now (a ragdoll piece).
  wound(point, dir, { gib = null, follow = null, rate = 90, duration = 3, speed = 2.2 } = {}) {
    this.emitters.push({ point: point.clone(), dir: dir.clone(), gib, follow, rate, duration, speed, t: 0, carry: 0 });
  }

  // Moves `parts` (already in world space) into a new rigid piece.
  tear(parts, pivot, opts) {
    const group = new THREE.Group();
    this.scene.add(group);
    for (const p of parts) if (p) group.add(p);
    const gib = new Gib(group, pivot, opts);
    gib.update(0);
    this.gibs.push(gib);
    return gib;
  }

  update(dt) {
    for (const g of this.gibs) g.update(dt);

    for (const e of this.emitters) {
      if (e.t >= e.duration) continue;
      e.t += dt;
      // Pulsing, fading spurts, like a heartbeat running down.
      const fade = 1 - e.t / e.duration;
      const pulse = 0.5 + 0.5 * Math.sin(e.t * 11);
      e.carry += e.rate * fade * pulse * dt;
      if (e.carry < 1) continue;
      const n = Math.floor(e.carry);
      e.carry -= n;
      let origin;
      let dir;
      if (e.follow) {
        e.follow(_v2, _s);
        origin = _v2;
        dir = _s;
      } else {
        origin = e.gib ? e.gib.track(_v2, e.point) : _v2.copy(e.point);
        dir = e.gib ? _s.copy(e.dir).applyQuaternion(e.gib.quat) : _s.copy(e.dir);
      }
      this.spray(origin, dir, n, e.speed * (0.5 + fade * 0.5), 0.35);
    }
    this.emitters = this.emitters.filter((e) => e.t < e.duration);

    for (const p of this.pools) {
      if (p.t >= p.growTime) continue;
      p.t += dt;
      const k = Math.min(p.t / p.growTime, 1);
      p.mesh.scale.setScalar(p.radius * Math.sqrt(k));
    }

    for (let i = 0; i < MAX_DROPS; i++) {
      const d = this.dropState[i];
      if (d.life <= 0) continue;
      d.life -= dt;
      if (!d.landed) {
        d.vel.y -= 9.8 * dt;
        d.pos.addScaledVector(d.vel, dt);
        if (d.pos.y <= 0.006) {
          d.pos.y = 0.006;
          d.landed = true; // becomes a flat splat on the ground
        }
      }
      const s = d.life <= 0 ? 0 : d.size;
      if (d.landed) _s.set(s * 1.7 * d.stretch, s * 0.1, s * 1.7 / d.stretch);
      else _s.setScalar(s);
      _m.compose(d.pos, d.landed ? _q.setFromAxisAngle(UP, d.yaw) : _q.identity(), _s);
      this.drops.setMatrixAt(i, _m);
    }
    this.drops.instanceMatrix.needsUpdate = true;
  }

  clear() {
    for (const g of this.gibs) this.scene.remove(g.group);
    for (const p of this.pools) this.scene.remove(p.mesh);
    this.gibs = [];
    this.pools = [];
    this.emitters = [];
    for (const d of this.dropState) d.life = 0;
  }
}

export { UP };
