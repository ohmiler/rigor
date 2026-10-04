# Builds the street props (car, dumpster, barrier, food stall, tables) in Blender and exports
# each to public/models/<name>.glb. Run with `npm run models` (or
# blender --background --python art/build_props.py -- public/models).
#
# Everything is built from code so a model can be tweaked and rebuilt, and
# each one fits the collider level.js already gives it (the gameplay shape:
# what you climb, vault and stand on). Coordinates below are the game's:
# x right, y up, z forward, metres; G() turns them into Blender's.
#
# Materials the game recolours per instance are named for it: "Paint" on a
# car or a food stall. Everything else keeps its colour from here.


import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kit import G, reset, material, prism, box, wheel_x, bevel, cut, finish, loft, join, export, glyph  # noqa: E402

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


# ---------------------------------------------------------------- street stall
# Collider (level.js): 0.8 x 1.5, top 1.0 m (you can get up on it). A food
# cart left where it stood: a steel body on wheels, a glass case of the
# night's noodles, a little roof, a bulb still burning.

def build_stall():
    reset()
    paint = material('Paint', '#3a6b8a', 0.5, 0.2)  # recoloured per stall
    steel = material('Steel', '#a9adb2', 0.3, 0.8)
    glass = material('Glass', '#9fc3cf', 0.1, 0.0)
    trim = material('Trim', '#1d1e21', 0.7)
    tire = material('Tire', '#141414', 0.95)
    bulb = material('Bulb', '#ffd28a', 0.4, 0.0, 4.0)
    pot = material('Pot', '#5a5d61', 0.4, 0.7)
    roof = material('Roof', '#c8c2b0', 0.8)

    parts = [
        box('body', (0, 0.6, 0), (0.8, 0.7, 1.5), paint),
        box('top', (0, 0.97, 0), (0.84, 0.04, 1.54), steel),
        box('kick', (0, 0.22, 0), (0.76, 0.06, 1.44), trim),
        box('case', (0.05, 1.17, -0.25), (0.6, 0.36, 0.9), glass),
        box('caseframe', (0.05, 1.36, -0.25), (0.64, 0.03, 0.94), steel),
        loft('pot', [(0.99, 0.02, 0.02, 0, 0.45), (1.0, 0.17, 0.17, 0, 0.45), (1.3, 0.17, 0.17, 0, 0.45), (1.31, 0.02, 0.02, 0, 0.45)], pot, segments=14, smooth=True),
        box('handle', (0, 0.95, 0.85), (0.6, 0.04, 0.04), steel),
        box('pole', (-0.36, 1.6, 0.6), (0.04, 1.3, 0.04), steel),
        box('pole', (-0.36, 1.6, -0.6), (0.04, 1.3, 0.04), steel),
        box('roof', (-0.05, 2.27, 0), (0.95, 0.04, 1.7), roof, rot=(0, 0, -0.18)),
        box('bulb', (0, 2.05, 0.2), (0.07, 0.1, 0.07), bulb),
    ]
    for z in (-0.5, 0.5):
        parts.append(wheel_x('wheel', (0.42, 0.22, z), 0.22, 0.06, tire, 14))
        parts.append(wheel_x('wheel', (-0.42, 0.22, z), 0.22, 0.06, tire, 14))
    finish('stall', parts)


# ---------------------------------------------------------------- tables
# Collider: 0.7 x 1.2, top 0.75 m (over it, or up on it). A folding table
# and plastic stools, one kicked over, bowls left half eaten.

def build_tables():
    reset()
    top = material('TableTop', '#d8d4c8', 0.6)
    steel = material('Steel', '#8c9095', 0.4, 0.7)
    stool = material('Stool', '#c62f2a', 0.6)  # the red plastic kind
    stool2 = material('Stool2', '#2f5fae', 0.6)
    bowl = material('Bowl', '#f0ece2', 0.4)

    def seat(x, z, mat, tipped=False):
        legs = [box('leg', (x + dx, 0.2, z + dz), (0.04, 0.4, 0.04), mat) for dx in (-0.13, 0.13) for dz in (-0.13, 0.13)]
        if tipped:  # on its side, legs out along x
            return [box('seat', (x - 0.2, 0.17, z), (0.04, 0.32, 0.32), mat),
                    *[box('leg', (x, 0.17 + dy, z + dz), (0.4, 0.04, 0.04), mat) for dy in (-0.13, 0.13) for dz in (-0.13, 0.13)]]
        return [box('seat', (x, 0.42, z), (0.32, 0.04, 0.32), mat), *legs]

    parts = [
        box('top', (0, 0.73, 0), (0.7, 0.03, 1.2), top),
        *[box('leg', (x, 0.36, z), (0.035, 0.72, 0.035), steel) for x in (-0.3, 0.3) for z in (-0.54, 0.54)],
        box('brace', (0, 0.2, 0), (0.62, 0.03, 0.03), steel),
        *seat(-0.55, -0.35, stool),
        *seat(0.6, 0.3, stool2),
        *seat(-0.6, 0.45, stool),
        *seat(0.62, -0.7, stool, tipped=True),
        loft('bowl', [(0.75, 0.02, 0.02, 0.15, -0.2), (0.76, 0.06, 0.06, 0.15, -0.2), (0.82, 0.08, 0.08, 0.15, -0.2)], bowl, segments=10),
        loft('bowl', [(0.75, 0.02, 0.02, -0.1, 0.3), (0.76, 0.06, 0.06, -0.1, 0.3), (0.82, 0.08, 0.08, -0.1, 0.3)], bowl, segments=10),
    ]
    finish('tables', parts)


# ---------------------------------------------------------------- tuk-tuk
# Collider: 1.3 x 2.6, top 1.75 m (the canopy; you can climb up on it). The
# three-wheeled taxi: a single wheel and the driver up front, a bench for
# two behind, a bright canopy over all of it ("Paint").

def build_tuktuk():
    reset()
    paint = material('Paint', '#1f6fb5', 0.45, 0.2)  # the canopy and panels
    body = material('Body', '#2a2d31', 0.6, 0.3)
    chrome = material('Chrome', '#c9ccd0', 0.25, 0.9)
    seat = material('Seat', '#7a1f1a', 0.7)
    tire = material('Tire', '#141414', 0.95)
    head = material('Headlight', '#d8d2bf', 0.2)
    tail = material('Taillight', '#8a1712', 0.3)

    parts = [
        box('floor', (0, 0.37, -0.35), (1.24, 0.1, 1.8), body),
        box('nose', (0, 0.6, 1.0), (0.6, 0.55, 0.45), paint),
        box('dash', (0, 0.95, 0.75), (0.7, 0.12, 0.2), body),
        box('screen', (0, 1.2, 0.85), (0.72, 0.4, 0.03), chrome),
        box('bars', (0, 1.0, 0.9), (0.6, 0.03, 0.03), chrome),
        box('driver', (0, 0.65, 0.35), (0.45, 0.12, 0.4), seat),
        box('bench', (0, 0.62, -0.75), (1.14, 0.14, 0.5), seat),
        box('back', (0, 0.95, -1.02), (1.14, 0.55, 0.1), seat),
        box('side', (0.6, 0.6, -0.55), (0.04, 0.35, 1.2), paint),
        box('side', (-0.6, 0.6, -0.55), (0.04, 0.35, 1.2), paint),
        box('rear', (0, 0.55, -1.24), (1.24, 0.35, 0.06), paint),
        # Canopy on posts.
        box('canopy', (0, 1.72, -0.2), (1.32, 0.06, 2.3), paint),
        box('canopyrim', (0, 1.64, -0.2), (1.34, 0.1, 2.32), paint),
        *[box('post', (x, 1.15, z), (0.04, 1.1, 0.04), chrome) for x in (-0.6, 0.6) for z in (-1.2, 0.7)],
        box('headlight', (0, 0.75, 1.24), (0.18, 0.12, 0.04), head),
        box('tail', (-0.48, 0.55, -1.28), (0.16, 0.08, 0.03), tail),
        box('tail', (0.48, 0.55, -1.28), (0.16, 0.08, 0.03), tail),
        wheel_x('wheel', (0, 0.25, 1.0), 0.25, 0.12, tire, 16),
        wheel_x('wheel', (0.64, 0.25, -0.75), 0.25, 0.12, tire, 16),
        wheel_x('wheel', (-0.64, 0.25, -0.75), 0.25, 0.12, tire, 16),
    ]
    finish('tuktuk', parts)


# ---------------------------------------------------------------- the gate
# Colliders (level.js): the two great pillars at x = +-4.6 and the outer
# posts at +-6.0. A Chinatown gate across the end of the street: red
# pillars, beams, a plaque of gold characters, brackets under tiers of green
# tiled roof with upturned eaves. Its face is -z, toward the street.

def build_gate():
    reset()
    red = material('Lacquer', '#9c1a14', 0.5)
    gold = material('Gold', '#d4a531', 0.3, 0.8, 0.3)
    tile = material('Tile', '#2f6b4a', 0.6)
    stone = material('Stone', '#9a958a', 0.95)
    plaque = material('Plaque', '#6b0f0b', 0.6)

    def roof(name, x0, x1, profile, ridge_y):
        parts = [prism(name, profile, 'x', x0, x1, tile), box('ridge', ((x0 + x1) / 2, ridge_y, 0), (x1 - x0 + 0.3, 0.16, 0.24), gold)]
        eave_y = profile[0][1] + 0.18
        reach = max(abs(p[0]) for p in profile)
        for x, s in ((x0 - 0.1, -1), (x1 + 0.1, 1)):
            for z in (-reach + 0.12, reach - 0.12):
                parts.append(box('eave', (x, eave_y, z), (0.8, 0.12, 0.26), tile, rot=(0, 0, s * 0.38)))
            parts.append(box('finial', (x + s * 0.05, ridge_y + 0.25, 0), (0.24, 0.45, 0.22), gold, rot=(0, 0, s * 0.3)))
        return parts

    parts = []
    for s in (-1, 1):
        parts += [
            box('plinth', (s * 4.6, 0.3, 0), (1.1, 0.6, 1.1), stone),
            box('pillar', (s * 4.6, 3.6, 0), (0.7, 6.6, 0.7), red),
            box('collar', (s * 4.6, 0.75, 0), (0.8, 0.12, 0.8), gold),
            box('plinth', (s * 6.0, 0.25, 0), (0.8, 0.5, 0.8), stone),
            box('post', (s * 6.0, 2.4, 0), (0.5, 4.8, 0.5), red),
            box('beam', (s * 5.3, 4.2, 0), (1.4, 0.3, 0.4), red),
        ]
        x0, x1 = sorted((s * 5.2, s * 6.8))
        parts += roof('sideroof', x0, x1, [(-0.8, 4.8), (0.8, 4.8), (0.25, 5.4), (-0.25, 5.4)], 5.42)
    parts += [
        box('beam', (0, 5.4, 0), (9.9, 0.45, 0.55), red),
        box('band', (0, 5.4, -0.29), (9.9, 0.1, 0.02), gold),
        box('beam', (0, 6.75, 0), (9.9, 0.4, 0.5), red),
        box('plaque', (0, 6.05, -0.32), (2.8, 1.05, 0.1), plaque),
        box('plaqueframe', (0, 6.6, -0.38), (2.9, 0.06, 0.04), gold),
        box('plaqueframe', (0, 5.5, -0.38), (2.9, 0.06, 0.04), gold),
        box('plaqueframe', (-1.43, 6.05, -0.38), (0.06, 1.15, 0.04), gold),
        box('plaqueframe', (1.43, 6.05, -0.38), (0.06, 1.15, 0.04), gold),
    ]
    rnd = random.Random(888)
    for i in range(4):
        parts += glyph(rnd, -0.99 + i * 0.66, 6.05, 0.56, -0.39, gold, along='x')
    # Brackets under the main roof, red and gold in turn.
    for i in range(17):
        x = -4.8 + i * 0.6
        parts.append(box('bracket', (x, 7.08, 0), (0.26, 0.26, 0.7), gold if i % 2 else red))
    parts += roof('roof', -5.6, 5.6, [(-1.3, 7.2), (1.3, 7.2), (1.0, 7.5), (0.35, 8.3), (-0.35, 8.3), (-1.0, 7.5)], 8.38)
    parts += [box('drum', (0, 8.6, 0), (2.6, 0.5, 0.6), red)]
    parts += roof('crown', -2.0, 2.0, [(-0.9, 8.8), (0.9, 8.8), (0.6, 9.05), (0.22, 9.6), (-0.22, 9.6), (-0.6, 9.05)], 9.66)
    finish('gate', parts)


# ---------------------------------------------------------------- helicopter
# Not a collider: it comes for you at the end. Three objects, so the game
# can spin the rotors: "heli" (the airframe), "rotor" (centred on its hub,
# which sits at (0, 2.25, 0) on the airframe) and "tailrotor" (hub at
# (0.15, 2.0, -5.1), spinning about x). The nose is +z.

def build_helicopter():
    reset()
    body_m = material('HeliBody', '#2c3035', 0.5, 0.3)
    stripe = material('Stripe', '#e06a1b', 0.5)
    glass = material('Glass', '#1c2530', 0.15, 0.4)
    metal = material('Metal', '#3a3c40', 0.5, 0.6)
    blade = material('Blade', '#151617', 0.6)
    lamp = material('Lamp', '#ff3b30', 0.4, 0.0, 4.0)

    body = [
        loft('body', [(2.3, 0.1, 0.1, 0, 1.0), (2.0, 0.55, 0.6, 0, 1.05), (1.0, 0.85, 0.85, 0, 1.1), (-0.6, 0.8, 0.8, 0, 1.15), (-1.4, 0.4, 0.45, 0, 1.3), (-1.8, 0.12, 0.15, 0, 1.45)], body_m, axis='z', segments=16),
        loft('canopy', [(2.25, 0.08, 0.08, 0, 1.25), (1.95, 0.45, 0.4, 0, 1.35), (1.25, 0.7, 0.55, 0, 1.5), (0.65, 0.6, 0.45, 0, 1.6), (0.55, 0.05, 0.05, 0, 1.6)], glass, axis='z', segments=16),
        box('stripe', (0, 0.92, 0.2), (1.66, 0.16, 2.6), stripe),
        box('boom', (0, 1.42, -3.4), (0.22, 0.26, 3.4), body_m),
        box('fin', (0, 1.95, -5.0), (0.08, 1.1, 0.6), body_m, rot=(-0.3, 0, 0)),
        box('tailplane', (0, 1.45, -4.6), (1.3, 0.06, 0.35), body_m),
        box('mast', (0, 2.05, 0), (0.2, 0.3, 0.2), metal),
        box('engine', (0, 1.85, -0.5), (0.8, 0.35, 1.4), body_m),
        box('beacon', (0, 2.05, -1.1), (0.12, 0.08, 0.12), lamp),
    ]
    for s in (-1, 1):
        body += [box('skid', (s * 0.85, 0.05, 0.1), (0.08, 0.08, 3.2), metal)]
        body += [box('strut', (s * 0.7, 0.35, z), (0.06, 0.7, 0.06), metal, rot=(0, 0, s * 0.35)) for z in (-0.6, 0.9)]
    heli = join('heli', body, smooth=None)
    rotor = join('rotor', [box('blade', (0, 0, 0), (9.0, 0.05, 0.3), blade), box('blade', (0, 0, 0), (0.3, 0.05, 9.0), blade), box('hub', (0, 0, 0), (0.4, 0.15, 0.4), metal)], smooth=False)
    tail = join('tailrotor', [box('blade', (0, 0, 0), (0.05, 1.4, 0.16), blade), box('blade', (0, 0, 0), (0.05, 0.16, 1.4), blade)], smooth=False)
    export('helicopter', [heli, rotor, tail])


build_car()
build_dumpster()
build_barrier()
build_stall()
build_tables()
build_tuktuk()
build_gate()
build_helicopter()
