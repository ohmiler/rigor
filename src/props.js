import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Street props modelled in Blender (art/build_props.py, rebuilt with
// `npm run models`) dressed over the boxes level.js builds. The boxes stay
// as they are for gameplay, hidden: what bullets hit, and the shape the
// colliders were made from. If a model fails to load, its boxes just show.

/**
 * @param {{ props: Record<string, Array<{ x: number, z: number, yaw: number, standIns: import('three').Mesh[], color?: string }>> }} level
 * @returns {Promise<void>} once every model is in (or has failed)
 */
export function dressProps(level) {
  const loader = new GLTFLoader();
  const base = import.meta.env.BASE_URL;
  return Promise.all(
    Object.entries(level.props).map(([name, slots]) =>
      loader
        .loadAsync(`${base}models/${name}.glb`)
        .then((gltf) => {
          for (const slot of slots) {
            const model = gltf.scene.clone(true);
            model.position.set(slot.x, 0, slot.z);
            model.rotation.y = slot.yaw;
            model.traverse((o) => {
              if (!(/** @type {any} */ (o).isMesh)) return;
              const mesh = /** @type {import('three').Mesh} */ (o);
              mesh.castShadow = mesh.receiveShadow = true;
              // Each car its own colour.
              const m = /** @type {import('three').MeshStandardMaterial} */ (mesh.material);
              if (slot.color && m.name === 'Paint') {
                mesh.material = m.clone();
                /** @type {import('three').MeshStandardMaterial} */ (mesh.material).color.set(slot.color);
              }
            });
            slot.standIns[0].parent.add(model);
            for (const s of slot.standIns) s.visible = false;
          }
        })
        .catch((e) => console.warn(`RIGOR: ${name} model not loaded, keeping boxes`, e)),
    ),
  ).then(() => {});
}
