import * as THREE from 'three';

// Car alarms. A few of the dead cars on the street are still armed, a red
// LED blinking at the foot of the windscreen. Shoot one, or climb up on it,
// and it goes off: a siren and the horn for twenty seconds, the lights
// flashing, and the whole street comes (main.js has the Director send a
// horde both ways).
//
// Which cars are armed is the run's (rolled on its seeded dice in reset), and
// what sets one off happens in the simulation, so a replay sets off the same
// alarm on the same step. The blinking and the noise are looks: real time.

const ARMED = 3; // cars with a live alarm, each run
const RINGS = 20; // seconds an alarm sounds
const SKIP_FIRST = 25; // the cars by the start are never armed: you'd set one off with your first shots
const SHOT_RANGE = 15; // a stray round only sets off a car you could see (its LED blinking on screen)
const LED = new THREE.Vector3(0.45, 0.98, 0.98); // car-local: on the bonnet, under the windscreen

export class CarAlarms {
  /**
   * @param {THREE.Scene} scene
   * @param {Array<{ x: number, z: number, yaw: number, model?: THREE.Object3D }>} cars level.props.car
   */
  constructor(scene, cars) {
    this.cars = cars.map((car) => {
      const led = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 10, 8),
        new THREE.MeshBasicMaterial({ color: '#ff2a1a' }),
      );
      const g = new THREE.Group();
      g.position.set(car.x, 0, car.z);
      g.rotation.y = car.yaw;
      led.position.copy(LED);
      led.visible = false;
      g.add(led);
      scene.add(g);
      return { car, led, armed: false, ringing: 0, lights: null, phase: Math.random() };
    });
    // One light for the flashing, kept in the scene always (adding and
    // removing lights recompiles every shader): only one car rings at a time
    // that's worth lighting up.
    this.flash = new THREE.PointLight('#ffb15c', 0, 14, 1.6);
    scene.add(this.flash);
    this.time = 0;
    this.lastBeat = -1;
    /** @type {((car: any) => void) | null} */
    this.onAlarm = null;
  }

  // A new run: roll which cars are armed (seeded dice).
  reset() {
    const candidates = this.cars.filter((c) => c.car.z > SKIP_FIRST);
    for (const c of this.cars) {
      c.armed = false;
      c.ringing = 0;
    }
    for (let i = 0; i < ARMED && candidates.length; i++) {
      const [c] = candidates.splice(Math.floor(Math.random() * candidates.length), 1);
      c.armed = true;
    }
    for (const c of this.cars) c.led.visible = c.armed;
    this._lights(null);
  }

  get armed() {
    return this.cars.filter((c) => c.armed).map((c) => c.car);
  }

  // Inside car `c`'s body (car-local box, a little slack): a bullet that
  // stopped here hit it.
  _contains(c, p, slack) {
    const { x, z, yaw } = c.car;
    const dx = p.x - x;
    const dz = p.z - z;
    const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    const lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    return Math.abs(lx) < 0.95 + slack && Math.abs(lz) < 2.2 + slack && p.y < 1.6 + slack;
  }

  /**
   * A bullet fired from `from` stopped at `point`: if that's an armed car
   * close enough to have been seen, off it goes.
   */
  shotAt(point, from) {
    for (const c of this.cars) {
      if (!c.armed || Math.hypot(c.car.x - from.x, c.car.z - from.z) > SHOT_RANGE) continue;
      if (this._contains(c, point, 0.15)) this._trigger(c);
    }
  }

  /** One simulation step: anyone standing on an armed car sets it off. */
  update(dt, player) {
    for (const c of this.cars) {
      if (c.ringing > 0) c.ringing = Math.max(c.ringing - dt, 0);
      const up = player.pos.y > 0.5 && player.state !== 'dead';
      if (c.armed && up && this._contains(c, player.pos, 0)) this._trigger(c);
    }
  }

  _trigger(c) {
    c.armed = false;
    c.ringing = RINGS;
    c.led.visible = false;
    this.onAlarm?.(c.car);
  }

  /**
   * Looks, each frame in real time: the LEDs blink, a ringing car flashes
   * its lights. `beat(car)` is called on each whoop of the siren.
   */
  animate(real, beat) {
    this.time += real;
    let lit = null;
    for (const c of this.cars) {
      if (c.armed) c.led.material.color.setRGB(((this.time + c.phase) % 1.2) < 0.3 ? 6 : 0.35, 0.06, 0.03);
      if (c.ringing > 0) lit = c;
    }
    if (!lit) {
      this.flash.intensity = 0;
      this._lights(null);
      return;
    }
    const on = this.time % 0.5 < 0.25; // flashing twice a second
    const { x, z } = lit.car;
    this.flash.position.set(x, 1.4, z);
    this.flash.intensity = on ? 9 : 0;
    this._lights(on ? lit : null);
    const step = Math.floor(this.time / 0.5);
    if (step !== this.lastBeat) {
      this.lastBeat = step;
      beat?.(lit.car);
    }
  }

  // Head and tail lights glowing on the ringing car (its own copies of the
  // shared materials, made when it first goes off).
  _lights(c) {
    for (const other of this.cars) {
      if (!other.lights) continue;
      for (const m of other.lights) m.emissiveIntensity = other === c ? 3 : 0;
    }
    if (!c || c.lights || !c.car.model) return;
    c.lights = [];
    c.car.model.traverse((o) => {
      const mesh = /** @type {THREE.Mesh} */ (o);
      const m = /** @type {THREE.MeshStandardMaterial} */ (mesh.material);
      if (!mesh.isMesh || (m.name !== 'Headlight' && m.name !== 'Taillight')) return;
      const own = m.clone();
      own.emissive.set(m.name === 'Headlight' ? '#ffd9a0' : '#ff2a1a');
      own.emissiveIntensity = 3;
      mesh.material = own;
      c.lights.push(own);
    });
  }
}
