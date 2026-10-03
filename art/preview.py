# Renders the exported props side by side to a PNG, to check them without
# opening the game: blender --background --python art/preview.py -- out.png

import math
import os
import sys

import bpy

out = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'preview.png'
models = os.path.join(os.path.dirname(__file__), '..', 'public', 'models')

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
for i, name in enumerate(['car', 'dumpster', 'barrier']):
    bpy.ops.import_scene.gltf(filepath=os.path.abspath(os.path.join(models, name + '.glb')))
    for ob in bpy.context.selected_objects:
        ob.location.x += [0, 3.2, 5.6][i]

ground = bpy.data.meshes.new('ground')
ground.from_pydata([(-20, -20, 0), (20, -20, 0), (20, 20, 0), (-20, 20, 0)], [], [(0, 1, 2, 3)])
g = bpy.data.objects.new('ground', ground)
scene.collection.objects.link(g)
gm = bpy.data.materials.new('asphalt')
gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.03, 0.03, 0.035, 1)
ground.materials.append(gm)

sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sun.data.energy = 4
sun.rotation_euler = (math.radians(50), 0, math.radians(35))
scene.collection.objects.link(sun)
world = bpy.data.worlds.new('w')
world.color = (0.25, 0.28, 0.33)
scene.world = world

cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
cam.location = (9.5, -8.5, 5.2)
cam.data.lens = 38
scene.collection.objects.link(cam)
target = bpy.data.objects.new('target', None)
target.location = (2.8, 0, 0.6)
scene.collection.objects.link(target)
c = cam.constraints.new('TRACK_TO')
c.target = target
scene.camera = cam

scene.render.engine = 'BLENDER_EEVEE' if 'BLENDER_EEVEE' in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items] else 'BLENDER_EEVEE_NEXT'
scene.render.resolution_x = 1280
scene.render.resolution_y = 720
scene.render.filepath = os.path.abspath(out)
bpy.ops.render.render(write_still=True)
print('rendered', scene.render.filepath)
