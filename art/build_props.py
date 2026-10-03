# Builds the street props (car, dumpster, barrier) in Blender and exports
# each to public/models/<name>.glb. Run with `npm run models` (or
# blender --background --python art/build_props.py -- public/models).
#
# Everything is built from code so a model can be tweaked and rebuilt, and
# each one fits the collider level.js already gives it (the gameplay shape:
# what you climb, vault and stand on). Coordinates below are the game's:
# x right, y up, z forward, metres; G() turns them into Blender's.
#
# Materials the game recolours per instance are named for it: "Paint" on a
# car. Everything else keeps its colour from here.

import math
import os
import sys

import bmesh
import bpy

OUT = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else os.path.join(os.path.dirname(__file__), '..', 'public', 'models')


def G(x, y, z):
    """Game (x right, y up, z forward) to Blender (x right, y back, z up);
    the glTF exporter turns it back into y-up."""
    return (x, -z, y)


_materials = {}


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _materials.clear()


def material(name, color, rough=0.8, metal=0.0, emit=0.0):
    if name in _materials:
        return _materials[name]
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True  # always on from Blender 5
    except Exception:
        pass
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    rgb = tuple(int(color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    lin = tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb)
    bsdf.inputs['Base Color'].default_value = (*lin, 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if emit:
        bsdf.inputs['Emission Color'].default_value = (*lin, 1)
        bsdf.inputs['Emission Strength'].default_value = emit
    _materials[name] = m
    return m


def obj_from_bm(name, bm, mat):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(mat)
    return ob


def prism(name, profile, axis, w0, w1, mat):
    """A 2D outline extruded between w0 and w1 along `axis`: 'x' takes the
    outline as (z, y) points (a side view), 'z' as (x, y) (a front view)."""
    to = (lambda u, v, w: G(w, v, u)) if axis == 'x' else (lambda u, v, w: G(u, v, w))
    bm = bmesh.new()
    a = [bm.verts.new(to(u, v, w0)) for u, v in profile]
    b = [bm.verts.new(to(u, v, w1)) for u, v in profile]
    bm.faces.new(a)
    bm.faces.new(list(reversed(b)))
    n = len(profile)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([a[i], a[j], b[j], b[i]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bm(name, bm, mat)


def box(name, center, size, mat):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    sx, sy, sz = size
    for v in bm.verts:
        v.co.x *= sx
        v.co.y *= sz  # Blender y is game z
        v.co.z *= sy
    c = G(*center)
    bmesh.ops.translate(bm, verts=bm.verts, vec=c)
    return obj_from_bm(name, bm, mat)


def wheel_x(name, center, radius, width, mat, segments=18):
    """A cylinder whose axis is the game's x (a wheel, a caster)."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=radius, radius2=radius, depth=width)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=__import__('mathutils').Matrix.Rotation(math.pi / 2, 3, 'Y'))
    bmesh.ops.translate(bm, verts=bm.verts, vec=G(*center))
    return obj_from_bm(name, bm, mat)


def bevel(ob, width, segments=2, angle=40):
    m = ob.modifiers.new('Bevel', 'BEVEL')
    m.width = width
    m.segments = segments
    m.limit_method = 'ANGLE'
    m.angle_limit = math.radians(angle)
    return m


def cut(ob, cutter):
    m = ob.modifiers.new('Cut', 'BOOLEAN')
    m.operation = 'DIFFERENCE'
    m.object = cutter
    return m


def apply_all(ob):
    deps = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(deps))
    ob.modifiers.clear()
    ob.data = me


def finish(name, parts, cutters=()):
    """Bake modifiers, drop the cutters, join everything into one object
    (one mesh, a part per material) and export it."""
    for p in parts:
        apply_all(p)
    for c in cutters:
        bpy.data.objects.remove(c, do_unlink=True)
    with bpy.context.temp_override(active_object=parts[0], selected_editable_objects=parts):
        bpy.ops.object.join()
    ob = parts[0]
    ob.name = name
    for poly in ob.data.polygons:
        poly.use_smooth = False
    os.makedirs(OUT, exist_ok=True)
    path = os.path.abspath(os.path.join(OUT, name + '.glb'))
    for o in bpy.context.scene.objects:
        o.select_set(o == ob)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True)
    print('wrote', path, os.path.getsize(path), 'bytes')


# ---------------------------------------------------------------- car
# Collider (level.js): a 1.9 x 4.4 box to 0.95 m (bonnet and boot), and the
# cabin 1.62 x 2.2 to 1.5 m, set 0.2 m back.

def build_car():
    reset()
    paint = material('Paint', '#7a2b28', 0.45, 0.25)
    glass = material('Glass', '#1c2530', 0.15, 0.4)
    trim = material('Trim', '#1d1e21', 0.7)
    tire = material('Tire', '#141414', 0.95)
    rim = material('Rim', '#9a9da3', 0.35, 0.8)
    head = material('Headlight', '#d8d2bf', 0.2)  # dead: no glow
    tail = material('Taillight', '#8a1712', 0.3)

    # Body, side view: low bumpers, a flat bonnet and boot at 0.95 m.
    body = prism('body', [
        (-2.15, 0.30), (2.15, 0.30), (2.17, 0.62), (2.08, 0.9), (1.95, 0.95),
        (-1.98, 0.95), (-2.1, 0.9), (-2.17, 0.62),
    ], 'x', -0.9, 0.9, paint)
    bevel(body, 0.05, 2)
    arches = []
    for z in (1.4, -1.4):
        a = wheel_x('arch', (0, 0.36, z), 0.43, 2.2, trim, 20)
        arches.append(a)
        cut(body, a)

    # Cabin: a glass greenhouse under a painted roof and pillars.
    cab = [(-1.3, 0.95), (0.9, 0.95), (0.6, 1.5), (-1.15, 1.5)]
    cabin = prism('cabin', cab, 'x', -0.81, 0.81, paint)
    side_hole = box('side-hole', (0, 1.22, -0.27), (2, 0.42, 1.55), trim)
    front_hole = box('front-hole', (0, 1.22, -0.2), (1.42, 0.42, 3.2), trim)
    cut(cabin, side_hole)
    cut(cabin, front_hole)
    bevel(cabin, 0.03, 2)
    inner = prism('glass', [(-1.27, 0.96), (0.87, 0.96), (0.58, 1.48), (-1.13, 1.48)], 'x', -0.79, 0.79, glass)

    parts = [body, cabin, inner]
    # Bumpers, lights, mirrors.
    for z, s in ((2.19, 1), (-2.19, -1)):
        parts.append(box('bumper', (0, 0.42, z), (1.84, 0.16, 0.08), trim))
        for x in (-0.66, 0.66):
            parts.append(box('light', (x, 0.74, z), (0.36, 0.13, 0.04), head if s > 0 else tail))
    parts.append(box('grille', (0, 0.62, 2.18), (0.8, 0.14, 0.03), trim))
    for x in (-0.95, 0.95):
        parts.append(box('mirror', (x, 1.02, 0.72), (0.1, 0.09, 0.16), paint))
    # Wheels: tyre and rim.
    for x in (-0.82, 0.82):
        for z in (1.4, -1.4):
            parts.append(wheel_x('tire', (x, 0.34, z), 0.34, 0.24, tire, 20))
            parts.append(wheel_x('rim', (x + (0.125 if x > 0 else -0.125), 0.34, z), 0.2, 0.02, rim, 12))
    finish('car', parts, arches + [side_hole, front_hole])


# ---------------------------------------------------------------- dumpster
# Collider: 1.1 x 2.0, top 1.34 m (the lid you stand on).

def build_dumpster():
    reset()
    green = material('Dumpster', '#2f4a3a', 0.7, 0.1)
    lid = material('Lid', '#1f2a24', 0.8)
    metal = material('Metal', '#3a3c40', 0.5, 0.6)
    tire = material('Tire', '#141414', 0.95)

    # Front view: walls splay out toward the top.
    shell = prism('shell', [(-0.48, 0.16), (0.48, 0.16), (0.55, 1.22), (-0.55, 1.22)], 'z', -0.98, 0.98, green)
    bevel(shell, 0.03, 1)
    # The lid, sloped down toward the front like a real skip.
    top = prism('lid', [(-1.02, 1.22), (1.02, 1.22), (1.02, 1.34), (-1.02, 1.34)], 'x', -0.58, 0.58, lid)
    bevel(top, 0.02, 1)
    parts = [shell, top]
    # Lifting sleeves on the sides, a rim, casters.
    for x in (-0.57, 0.57):
        parts.append(box('sleeve', (x, 0.95, 0), (0.08, 0.14, 1.5), metal))
    parts.append(box('rim', (0, 1.19, 0), (1.14, 0.05, 2.0), metal))
    for x in (-0.38, 0.38):
        for z in (-0.78, 0.78):
            parts.append(box('fork', (x, 0.12, z), (0.06, 0.1, 0.1), metal))
            parts.append(wheel_x('caster', (x, 0.07, z), 0.07, 0.05, tire, 10))
    finish('dumpster', parts)


# ---------------------------------------------------------------- barrier
# Collider: 0.6 x 2.4, top 0.85 m. A Jersey barrier: a wide foot and a
# sloped face up to a narrow top.

def build_barrier():
    reset()
    concrete = material('Concrete', '#8d8a83', 0.95)
    stripe = material('Stripe', '#c98a2b', 0.6)
    profile = [(-0.3, 0.0), (0.3, 0.0), (0.3, 0.08), (0.2, 0.3), (0.11, 0.85), (-0.11, 0.85), (-0.2, 0.3), (-0.3, 0.08)]
    block = prism('barrier', profile, 'z', -1.2, 1.2, concrete)
    bevel(block, 0.015, 1)
    parts = [block]
    # Faded reflective stripes on both faces, following the slope.
    for s in (-1, 1):
        for z in (-0.7, 0.0, 0.7):
            p = prism('stripe', [(s * 0.155, 0.55), (s * 0.13, 0.7), (s * 0.135, 0.7), (s * 0.16, 0.55)], 'z', z - 0.18, z + 0.18, stripe)
            parts.append(p)
    finish('barrier', parts)


build_car()
build_dumpster()
build_barrier()
