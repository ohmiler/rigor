import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Modelled bodies (art/build_character.py, rebuilt with `npm run models`):
// one part per slot of a Humanoid (pelvis, chest, thigh, hand...), each in
// that slot's own frame. Loaded once and kept, so every body built after
// (a new run's player) is dressed straight away; Humanoid.dress fits them.

/** @type {Map<string, Promise<import('three').Object3D | null>>} */
const loading = new Map();
/** @type {Map<string, import('three').Object3D>} */
const loaded = new Map();

/** The model if it has arrived, else null (bodies keep their primitives). */
export function characterModel(name) {
  return loaded.get(name) ?? null;
}

/** @returns {Promise<import('three').Object3D | null>} null if it couldn't load */
export function loadCharacter(name) {
  if (!loading.has(name)) {
    const url = `${import.meta.env.BASE_URL}models/${name}.glb`;
    loading.set(
      name,
      new GLTFLoader()
        .loadAsync(url)
        .then((gltf) => {
          loaded.set(name, gltf.scene);
          return gltf.scene;
        })
        .catch((e) => {
          console.warn(`RIGOR: ${name} model not loaded, keeping the primitive body`, e);
          return null;
        }),
    );
  }
  return loading.get(name);
}
