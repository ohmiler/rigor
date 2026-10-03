import * as THREE from 'three';

// Its own dice: looks and sounds never shift the game's seeded ones (replay.js).
const random = Math.random;

const RANGE = 40;
const _hitPoint = new THREE.Vector3();

// Muzzle flash, tracers and impact sparks. Everything is pooled and runs on
// game time, so slow motion and pause apply to the effects too.
export class Effects {
  constructor(scene, obstacles) {
    this.scene = scene;
    this.obstacles = obstacles;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = RANGE;

    // The light stays in the scene at zero intensity so shaders never recompile.
    this.flashLight = new THREE.PointLight('#ffc36b', 0, 6, 2);
    scene.add(this.flashLight);
    this.flash = new THREE.Mesh(
      new THREE.ConeGeometry(0.06, 0.22, 7).rotateX(Math.PI / 2).translate(0, 0, 0.11),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color('#ffd27a').multiplyScalar(3), // bright enough to glow
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.flash.visible = false;
    scene.add(this.flash);
    this.flashTime = 0;

    const tracerGeo = new THREE.BoxGeometry(0.012, 0.012, 1).translate(0, 0, 0.5);
    this.tracers = Array.from({ length: 24 }, () => {
      const mesh = new THREE.Mesh(
        tracerGeo,
        new THREE.MeshBasicMaterial({
          color: '#fff1b8',
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      mesh.visible = false;
      scene.add(mesh);
      return { mesh, life: 0, maxLife: 1 };
    });

    const sparkGeo = new THREE.SphereGeometry(0.05, 8, 6);
    this.sparks = Array.from({ length: 24 }, () => {
      const mesh = new THREE.Mesh(
        sparkGeo,
        new THREE.MeshBasicMaterial({
          color: '#ffb347',
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      mesh.visible = false;
      scene.add(mesh);
      return { mesh, life: 0, maxLife: 1 };
    });
    this.nextTracer = 0;
    this.nextSpark = 0;
  }

  // Distance to the nearest crate along the ray, or Infinity.
  raycastObstacles(origin, dir) {
    this.raycaster.set(origin, dir);
    const hit = this.raycaster.intersectObjects(this.obstacles, false)[0];
    return hit ? hit.distance : Infinity;
  }

  // `hit` is null (miss), 'wall', or 'flesh'.
  shot(muzzle, dir, distance, hit) {
    this.flashLight.position.copy(muzzle);
    this.flashLight.intensity = 6;
    this.flash.position.copy(muzzle);
    this.flash.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    this.flash.rotateZ(random() * Math.PI);
    this.flash.scale.setScalar(0.8 + random() * 0.6);
    this.flash.visible = true;
    this.flashTime = 0.045;

    const length = Math.min(distance, RANGE);
    _hitPoint.copy(muzzle).addScaledVector(dir, length);

    const tracer = this.tracers[this.nextTracer++ % this.tracers.length];
    tracer.mesh.position.copy(muzzle);
    tracer.mesh.quaternion.copy(this.flash.quaternion);
    tracer.mesh.scale.set(1, 1, length);
    tracer.mesh.visible = true;
    tracer.life = tracer.maxLife = 0.07;

    if (hit) {
      const spark = this.sparks[this.nextSpark++ % this.sparks.length];
      spark.mesh.position.copy(_hitPoint);
      spark.mesh.visible = true;
      const flesh = hit === 'flesh';
      spark.mesh.material.color.set(flesh ? '#7a1010' : '#ffb347');
      spark.mesh.material.blending = flesh ? THREE.NormalBlending : THREE.AdditiveBlending;
      spark.life = spark.maxLife = flesh ? 0.3 : 0.15;
    }
  }

  update(dt) {
    if (this.flashTime > 0) {
      this.flashTime -= dt;
      if (this.flashTime <= 0) {
        this.flash.visible = false;
        this.flashLight.intensity = 0;
      }
    }
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      t.mesh.material.opacity = Math.max(t.life / t.maxLife, 0);
      if (t.life <= 0) t.mesh.visible = false;
    }
    for (const s of this.sparks) {
      if (s.life <= 0) continue;
      s.life -= dt;
      const k = Math.max(s.life / s.maxLife, 0);
      s.mesh.material.opacity = k;
      s.mesh.scale.setScalar(1 + (1 - k) * 2);
      if (s.life <= 0) s.mesh.visible = false;
    }
  }
}
