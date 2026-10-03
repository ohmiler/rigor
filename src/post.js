import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

// The look on top of the rendered frame: lamps, the muzzle flash and the
// exit flare glow; the edges darken; film grain; and how you feel shows on
// screen. A bite flashes the edges red and splits the colours; low health
// drains the colour out and pulses red with your heartbeat; dying goes grey.

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    resolution: { value: new THREE.Vector2(1, 1) },
    vignette: { value: 0.35 },
    grain: { value: 0.06 },
    hurt: { value: 0 }, // 0..1, a fresh wound
    low: { value: 0 }, // 0..1, how close to death
    beat: { value: 0 }, // 0..1, the heartbeat pulse
    grey: { value: 0 }, // 0..1, dead
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time, vignette, grain, hurt, low, beat, grey;
    uniform vec2 resolution;
    varying vec2 vUv;

    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
    }

    void main() {
      vec2 c = vUv - 0.5;
      float r = length(c * vec2(resolution.x / resolution.y, 1.0)) / length(vec2(resolution.x / resolution.y, 1.0) * 0.5);

      // Colours split toward the edges when hurt.
      float split = (hurt * 0.012 + low * beat * 0.004) * r;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + c * split).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - c * split).b;

      // Draining colour as you weaken; grey once dead.
      float luma = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(luma), clamp(low * 0.55 + grey * 0.85, 0.0, 1.0));

      // Darkened edges, a little more when weak.
      float v = smoothstep(0.35, 1.15, r);
      col *= 1.0 - v * clamp(vignette + low * 0.25, 0.0, 1.0);

      // Blood at the edges: a bite, and the heartbeat when low.
      float edge = smoothstep(0.35, 1.05, r);
      float red = clamp(hurt * 0.85 + low * (0.4 + beat * 0.45), 0.0, 1.0) * edge;
      col = mix(col, vec3(0.32, 0.0, 0.0) + col * vec3(0.4, 0.0, 0.0), red);

      // Film grain, stronger in the dark where it reads as noise in the eye.
      float n = hash(vUv * resolution + fract(time * 13.37) * 100.0) - 0.5;
      col += n * grain * (1.2 - luma);

      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class Post {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // HDR and multisampled, so bright things can bloom and edges stay smooth.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.6, 0.5, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass()); // tone mapping and sRGB, as a plain render would
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.time = 0;
    this.beatPhase = 0;
    this.resize();
  }

  resize() {
    const r = this.renderer;
    const size = r.getSize(new THREE.Vector2());
    this.composer.setPixelRatio(r.getPixelRatio());
    this.composer.setSize(size.x, size.y);
    const buf = r.getDrawingBufferSize(new THREE.Vector2());
    this.grade.uniforms.resolution.value.copy(buf);
  }

  /**
   * @param {number} dt real seconds
   * @param {{ hurt: number, health: number, dead: boolean,
   *   bloom: number, vignette: number, grain: number }} s
   *   health is 0..1
   */
  update(dt, s) {
    const u = this.grade.uniforms;
    this.time += dt;
    // Weak below 40% health, and the heart races the closer to death.
    const low = s.dead ? 0 : THREE.MathUtils.clamp((0.4 - s.health) / 0.3, 0, 1);
    this.beatPhase += dt * (1.1 + low * 0.9);
    const p = this.beatPhase % 1;
    const beat = Math.exp(-p * 14) + 0.6 * Math.exp(-Math.max(p - 0.18, 0) * 14) * (p > 0.18 ? 1 : 0);
    u.time.value = this.time;
    u.hurt.value = s.hurt;
    u.low.value = THREE.MathUtils.damp(u.low.value, low, 2, dt);
    u.beat.value = beat;
    u.grey.value = THREE.MathUtils.damp(u.grey.value, s.dead ? 1 : 0, 1.5, dt);
    u.vignette.value = s.vignette;
    u.grain.value = s.grain;
    this.bloom.strength = s.bloom;
  }

  render() {
    this.composer.render();
  }
}
