# Shared helpers for the Blender build scripts (build_props.py, build_street.py,
# build_character.py). Coordinates are the game's: x right, y up, z forward,
# metres; G() turns them into Blender's, and the glTF exporter turns them
# back.

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


def box(name, center, size, mat, rot=None):
    """A box `size` (x, y, z) at `center`, turned by `rot` (radians about
    the game's x, y, z) round its own middle."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    sx, sy, sz = size
    for v in bm.verts:
        v.co.x *= sx
        v.co.y *= sz  # Blender y is game z
        v.co.z *= sy
    if rot:
        from mathutils import Euler
        # Game x is Blender x, game y is Blender z, game z is Blender -y.
        m = Euler((rot[0], -rot[2], rot[1]), 'XZY').to_matrix()
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=m)
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


def join(name, parts, cutters=(), smooth=None):
    """Bake modifiers, drop the cutters and join the parts into one object
    (one mesh, a section per material). `smooth` = None keeps each face's
    own shading; True/False sets them all."""
    for p in parts:
        apply_all(p)
    for c in cutters:
        bpy.data.objects.remove(c, do_unlink=True)
    if len(parts) > 1:
        with bpy.context.temp_override(active_object=parts[0], selected_editable_objects=parts):
            bpy.ops.object.join()
    ob = parts[0]
    ob.name = name
    if smooth is not None:
        for poly in ob.data.polygons:
            poly.use_smooth = smooth
    return ob


def export(file_name, objects):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.abspath(os.path.join(OUT, file_name + '.glb'))
    for o in bpy.context.scene.objects:
        o.select_set(o in objects)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True)
    print('wrote', path, os.path.getsize(path), 'bytes')


def finish(name, parts, cutters=()):
    """One flat-shaded prop in its own file."""
    export(name, [join(name, parts, cutters, smooth=False)])


def loft(name, rings, mat, axis='y', segments=12, smooth=True):
    """A rounded solid through elliptical rings along `axis`. For 'y' each
    ring is (y, rx, rz, cx=0, cz=0); for 'z' it's (z, rx, ry, cx=0, cy=0).
    The ends close with a fan, so start and finish on small rings."""
    bm = bmesh.new()
    loops = []
    for r in rings:
        at, ra, rb = r[0], r[1], r[2]
        ca = r[3] if len(r) > 3 else 0.0
        cb = r[4] if len(r) > 4 else 0.0
        ring = []
        for i in range(segments):
            t = 2 * math.pi * i / segments
            a = ca + ra * math.cos(t)
            b = cb + rb * math.sin(t)
            ring.append(bm.verts.new(G(a, at, b) if axis == 'y' else G(a, b, at)))
        loops.append(ring)
    for k in range(len(loops) - 1):
        for i in range(segments):
            j = (i + 1) % segments
            bm.faces.new([loops[k][i], loops[k][j], loops[k + 1][j], loops[k + 1][i]])
    for ring, r in ((loops[0], rings[0]), (loops[-1], rings[-1])):
        ca = r[3] if len(r) > 3 else 0.0
        cb = r[4] if len(r) > 4 else 0.0
        c = bm.verts.new(G(ca, r[0], cb) if axis == 'y' else G(ca, cb, r[0]))
        for i in range(segments):
            bm.faces.new([ring[i], ring[(i + 1) % segments], c])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = obj_from_bm(name, bm, mat)
    for p in ob.data.polygons:
        p.use_smooth = smooth
    return ob



def glyph(rnd, cx, cy, size, face_x, mat, thick=0.025, along='z'):
    """One made-up character in a `size` square centred on (cx, cy) of a
    sign face. The face is the plane x = face_x (a blade sign, the
    character's across running along z) or z = face_x (a flat sign, along
    x). Built like a Chinese character: one part, or two side by side or
    stacked, each a boxed part (口), a lattice of strokes, or a cross with
    sweeping diagonals (木, 人)."""
    w = 0.075  # stroke width, as a share of the square
    strokes = []  # (u, v, du, dv, angle) in the unit square, centred

    def bar(u, v, du, dv, angle=0.0):
        strokes.append((u, v, du, dv, angle))

    def part(u0, u1, v0, v1):
        uc, vc, uw, vh = (u0 + u1) / 2, (v0 + v1) / 2, u1 - u0, v1 - v0
        kind = rnd.random()
        if kind < 0.3:  # a box, maybe split inside
            i = 0.1
            bar(uc, v1 - vh * i, uw * (1 - 2 * i), w)
            bar(uc, v0 + vh * i, uw * (1 - 2 * i), w)
            bar(u0 + uw * i, vc, w, vh * (1 - 2 * i))
            bar(u1 - uw * i, vc, w, vh * (1 - 2 * i))
            if rnd.random() < 0.6:
                bar(uc, vc, uw * (1 - 2 * i), w)
        elif kind < 0.75:  # a lattice: rows across, one or two strokes down
            rows = rnd.randint(2, 4)
            for k in range(rows):
                length = uw * rnd.uniform(0.55, 0.95)
                bar(uc + rnd.uniform(-0.1, 0.1) * uw, v0 + vh * (k + 0.5) / rows, length, w)
            for _ in range(rnd.randint(1, 2)):
                h = vh * rnd.uniform(0.6, 1.0)
                bar(uc + rnd.uniform(-0.3, 0.3) * uw, vc + rnd.uniform(-0.1, 0.1) * vh, w, h)
        else:  # a cross with two sweeps down from the middle
            bar(uc, vc + vh * 0.2, uw * 0.85, w)
            bar(uc, vc, w, vh * 0.9)
            d = min(uw, vh) * 0.5
            bar(uc - uw * 0.2, vc - vh * 0.22, w, d, 0.7)
            bar(uc + uw * 0.2, vc - vh * 0.22, w, d, -0.7)

    layout = rnd.random()
    if layout < 0.3:
        part(-0.5, 0.5, -0.5, 0.5)
    elif layout < 0.7:  # side by side, the left part narrower
        split = rnd.uniform(-0.15, 0.05)
        part(-0.5, split - 0.04, -0.5, 0.5)
        part(split + 0.04, 0.5, -0.5, 0.5)
    else:  # stacked
        split = rnd.uniform(-0.05, 0.15)
        part(-0.5, 0.5, split + 0.04, 0.5)
        part(-0.5, 0.5, -0.5, split - 0.04)
    if rnd.random() < 0.35:  # a dot on top
        bar(rnd.uniform(-0.2, 0.2), 0.47, w * 1.2, w * 1.4, 0.5)

    parts = []
    for u, v, du, dv, angle in strokes:
        u, v, du, dv = u * size, v * size, du * size, dv * size
        if along == 'z':
            parts.append(box('stroke', (face_x, cy + v, cx + u), (thick, dv, du), mat, rot=(-angle, 0, 0) if angle else None))
        else:
            parts.append(box('stroke', (cx + u, cy + v, face_x), (du, dv, thick), mat, rot=(0, 0, angle) if angle else None))
    return parts
