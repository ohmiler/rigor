import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// The rescue helicopter, as seen: where it is comes from the finale
// (finale.js, simulation); this spins the rotors, tips the nose as it
// comes in, and sweeps a searchlight round the extraction point. Real time,
// looks only.

const ROTOR_HUB = new THREE.Vector3(0, 2.25, 0); // on the airframe (art/build_props.py)
const TAIL_HUB = new THREE.Vector3(0.15, 2.0, -5.1);

const _pos = new THREE.Vector3();
const _last = new THREE.Vector3();

export class HeliView {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    // Side on across the street, so the camera sees all of it (the nose is +z).
    this.body = new THREE.Group();
    this.body.rotation.y = -Math.PI / 2;
    this.group.add(this.body);
    this.rotor = null;
    this.tail = null;
    // The searchlight is in the scene from the start (adding a light later
    // recompiles every shader), dark until it's needed.
    this.light = new THREE.SpotLight('#e8f0ff', 0, 40, 0.22, 0.5, 1.2);
    this.target = new THREE.Object3D();
    this.light.target = this.target;
    scene.add(this.light, this.target);
    this.time = 0;
    this.seen = false;

    new GLTFLoader()
      .loadAsync(`${import.meta.env.BASE_URL}models/helicopter.glb`)
      .then((gltf) => {
        const get = (name) => gltf.scene.getObjectByName(name);
        const heli = get('heli');
        if (heli) this.body.add(heli);
        this.rotor = get('rotor') ?? null;
        this.tail = get('tailrotor') ?? null;
        // Each rotor modelled round its own hub: put the hub where it goes.
        if (this.rotor) {
          this.rotor.position.copy(ROTOR_HUB);
          this.body.add(this.rotor);
        }
        if (this.tail) {
          this.tail.position.copy(TAIL_HUB);
          this.body.add(this.tail);
        }
        this.body.traverse((o) => (o.castShadow = true));
      })
      .catch((e) => console.warn('RIGOR: helicopter not loaded', e));
  }

  /**
   * Each frame. `finale` says where it is; `goal` is the extraction point.
   * Returns where it is (for the sound), or null while it's not here.
   */
  update(real, finale, goal) {
    this.time += real;
    const here = finale.heliPose(_pos);
    this.group.visible = here;
    this.light.intensity = here ? 260 : 0;
    if (!here) {
      this.seen = false;
      return null;
    }
    // Leaning into the way it's going as it comes in, level once it hangs there.
    const speed = this.seen ? _pos.distanceTo(_last) / Math.max(real, 1e-3) : 0;
    _last.copy(_pos);
    this.seen = true;
    this.group.position.copy(_pos);
    this.group.position.y += Math.sin(this.time * 1.3) * 0.15; // it never sits quite still
    this.body.rotation.z = THREE.MathUtils.damp(this.body.rotation.z, -Math.min(speed * 0.02, 0.35), 3, real); // banking in
    if (this.rotor) this.rotor.rotation.y += real * 38;
    if (this.tail) this.tail.rotation.x += real * 60;
    // The searchlight hunts round the point, then finds it.
    this.light.position.copy(this.group.position).y -= 1; // under the belly
    const r = finale.phase === 'arriving' ? 6 : 2.2;
    this.target.position.set(goal.pos.x + Math.sin(this.time * 0.9) * r, 0, goal.pos.z + Math.cos(this.time * 0.7) * r);
    return this.group.position;
  }
}
