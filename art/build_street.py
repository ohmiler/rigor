# Builds the buildings' street fronts as modular pieces and exports them all
# to public/models/street.glb. Run with `npm run models`.
#
# The buildings themselves stay the boxes level.js makes (walls, roof, what
# you collide with and shoot); props.js lines these pieces up along each
# box's street face, bay by bay and floor by floor, and puts clutter on the
# roof. Every piece is modelled in its own frame, in game coordinates:
#
#   x  across the bay, centred (a bay is 3 m; the game stretches it to fit)
#   y  up from the bottom of the storey (shopfronts 3.6 m, floors 3 m)
#   z  out from the wall (the wall is z = 0)
#
# Nothing sticks out more than ~0.7 m: the camera looks down on the
# pavement, and an awning any deeper would hide what's walking under it.
#
# Materials the game recolours per building: "Wall" (the building's own
# colour), "Sign" (the shop sign) and "Awning".

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kit import reset, material, box, loft, prism, join, export, glyph  # noqa: E402

SHOP_H, FLOOR_H, BAY = 3.6, 3.0, 3.0


def build_street():
    reset()
    wall = material('Wall', '#6b6259', 0.95)
    trim = material('Trim', '#34332f', 0.7)
    concrete = material('Concrete', '#8d8a83', 0.95)
    glass = material('Glass', '#1c2530', 0.15, 0.4)
    lit = material('GlassLit', '#ffcf8a', 0.4, 0.0, 1.4)
    dark = material('Dark', '#0d0f11', 0.95)
    sign = material('Sign', '#7a2b28', 0.6)
    awning_m = material('Awning', '#2f4a6b', 0.9)
    metal = material('Metal', '#4a4c50', 0.6, 0.5)
    wood = material('Wood', '#6b5238', 0.9)
    cloth = material('Cloth', '#a89c8c', 0.95)
    pieces = []

    def frame(w, y0, y1, z=0.05, t=0.1, mat=trim):
        """A window or door frame: two posts and a head."""
        h = y1 - y0
        return [
            box('post', (-w / 2, y0 + h / 2, z), (t, h, t), mat),
            box('post', (w / 2, y0 + h / 2, z), (t, h, t), mat),
            box('head', (0, y1, z), (w + t, t, t), mat),
        ]

    def shopfront(name, inside):
        """The common shell of a shop bay; `inside` fills the opening."""
        parts = [
            box('plinth', (0, 0.175, 0.06), (BAY, 0.35, 0.12), concrete),
            *frame(2.8, 0.35, 2.75),
            box('sill', (0, 0.38, 0.09), (2.9, 0.06, 0.16), trim),
            box('sign', (0, 3.12, 0.09), (BAY, 0.6, 0.14), sign),
            box('signtrim', (0, 2.8, 0.1), (BAY, 0.06, 0.18), trim),
            box('wall', (0, 3.52, 0.01), (BAY, 0.16, 0.02), wall),
            *inside,
        ]
        pieces.append(join(name, parts, smooth=False))

    # ---- shopfronts (ground floor)
    shopfront('shop', [box('glass', (0, 1.55, 0.02), (2.7, 2.35, 0.03), glass), box('mullion', (0, 1.55, 0.04), (0.06, 2.35, 0.05), trim)])
    shopfront('shop_broken', [
        box('dark', (0, 1.55, 0.005), (2.7, 2.35, 0.02), dark),
        box('shard', (-0.75, 2.2, 0.02), (1.2, 1.0, 0.03), glass),
        box('shard', (0.9, 0.75, 0.02), (0.9, 0.7, 0.03), glass),
        box('shard', (0.35, 2.4, 0.02), (0.8, 0.45, 0.03), glass, rot=(0, 0, 0.5)),
        box('shard', (-1.0, 0.6, 0.02), (0.6, 0.4, 0.03), glass, rot=(0, 0, -0.4)),
    ])
    ribs = [box('rib', (0, 0.45 + i * 0.12, 0.07), (2.76, 0.025, 0.02), metal) for i in range(19)]
    shopfront('shutter', [
        box('shutter', (0, 1.55, 0.04), (2.7, 2.35, 0.04), metal),
        *ribs,
        box('housing', (0, 2.62, 0.12), (2.85, 0.26, 0.22), metal),
    ])
    planks = [box('plank', (0, 0.7 + i * 0.45, 0.07), (2.75, 0.22, 0.03), wood, rot=(0, 0, a)) for i, a in enumerate((0.04, -0.06, 0.02, 0.08, -0.03))]
    shopfront('boarded', [box('dark', (0, 1.55, 0.005), (2.7, 2.35, 0.02), dark), *planks, box('brace', (0, 1.55, 0.09), (0.18, 2.3, 0.03), wood, rot=(0, 0, 0.9))])
    # A shop door: wall either side, a glass door, a step.
    pieces.append(join('door', [
        box('plinth', (0, 0.175, 0.06), (BAY, 0.35, 0.12), concrete),
        box('wall', (-1.0, 1.55, 0.01), (1.0, 2.4, 0.02), wall),
        box('wall', (1.0, 1.55, 0.01), (1.0, 2.4, 0.02), wall),
        *frame(1.1, 0.0, 2.4),
        box('door', (0, 1.2, 0.03), (1.0, 2.35, 0.03), glass),
        box('kick', (0, 0.2, 0.05), (1.0, 0.35, 0.03), trim),
        box('handle', (0.38, 1.1, 0.07), (0.04, 0.35, 0.04), metal),
        box('step', (0, 0.06, 0.25), (1.4, 0.12, 0.4), concrete),
        box('sign', (0, 3.12, 0.09), (BAY, 0.6, 0.14), sign),
        box('signtrim', (0, 2.8, 0.1), (BAY, 0.06, 0.18), trim),
        box('wall', (0, 2.6, 0.01), (BAY, 0.4, 0.02), wall),
        box('wall', (0, 3.52, 0.01), (BAY, 0.16, 0.02), wall),
    ], smooth=False))

    # ---- upper floors
    def window(name, pane, extra=()):
        parts = [
            *frame(1.45, 0.8, 2.45, z=0.04, t=0.09),
            box('base', (0, 0.8, 0.04), (1.54, 0.09, 0.09), trim),
            box('sill', (0, 0.73, 0.1), (1.75, 0.08, 0.2), concrete),
            box('lintel', (0, 2.58, 0.05), (1.7, 0.16, 0.1), concrete),
            *pane,
            *extra,
        ]
        pieces.append(join(name, parts, smooth=False))

    window('upper', [box('glass', (0, 1.62, 0.02), (1.4, 1.6, 0.03), glass), box('bar', (0, 1.62, 0.04), (1.4, 0.05, 0.04), trim)])
    window('upper_lit', [box('glass', (0, 1.62, 0.02), (1.4, 1.6, 0.03), lit), box('bar', (0, 1.62, 0.04), (1.4, 0.05, 0.04), trim)])
    window('upper_broken', [
        box('dark', (0, 1.62, 0.005), (1.4, 1.6, 0.02), dark),
        box('shard', (-0.35, 2.1, 0.02), (0.65, 0.6, 0.03), glass),
        box('curtain', (0.3, 1.5, 0.012), (0.6, 1.5, 0.02), cloth, rot=(0, 0, 0.05)),
    ])
    window('upper_ac', [box('glass', (0, 1.62, 0.02), (1.4, 1.6, 0.03), glass), box('bar', (0, 1.62, 0.04), (1.4, 0.05, 0.04), trim)], [
        box('ac', (0.2, 0.42, 0.24), (0.72, 0.44, 0.46), metal),
        box('grille', (0.2, 0.42, 0.475), (0.6, 0.34, 0.01), dark),
        box('bracket', (0.2, 0.18, 0.2), (0.6, 0.04, 0.4), trim),
    ])
    window('upper_boarded', [box('dark', (0, 1.62, 0.005), (1.4, 1.6, 0.02), dark), *[box('plank', (0, 1.0 + i * 0.4, 0.05), (1.5, 0.2, 0.03), wood, rot=(0, 0, a)) for i, a in enumerate((0.05, -0.08, 0.03, 0.1))]])

    # ---- trim spanning the whole front (the game stretches them along it)
    pieces.append(join('ledge', [box('ledge', (0, 0.0, 0.08), (BAY, 0.16, 0.16), concrete)], smooth=False))
    pieces.append(join('cornice', [
        box('cornice', (0, 0.25, 0.14), (BAY, 0.5, 0.28), concrete),
        box('cap', (0, 0.53, 0.2), (BAY, 0.08, 0.4), trim),
        box('dentil', (0, 0.03, 0.2), (BAY, 0.08, 0.32), trim),
    ], smooth=False))
    pieces.append(join('pilaster', [box('pilaster', (0, 0.5, 0.07), (0.32, 1.0, 0.14), concrete)], smooth=False))

    # ---- fire escape, one floor of it (platform at the floor, rails, a
    # ladder up to the next; the top floor's has no ladder)
    def escape(name, ladder):
        esc = [
            box('platform', (0, 0.15, 0.36), (2.6, 0.05, 0.7), metal),
            box('rail', (0, 1.1, 0.7), (2.6, 0.04, 0.04), metal),
            box('rail', (0, 0.62, 0.7), (2.6, 0.03, 0.03), metal),
            *[box('post', (x, 0.62, 0.7), (0.04, 0.95, 0.04), metal) for x in (-1.28, -0.4, 0.4, 1.28)],
            *[box('side', (x, 1.1, 0.36), (0.04, 0.04, 0.7), metal) for x in (-1.28, 1.28)],
            *[box('bracket', (x, -0.1, 0.25), (0.05, 0.5, 0.05), metal, rot=(0.8, 0, 0)) for x in (-1.1, 1.1)],
        ]
        if ladder:
            # Leaning up to the next platform.
            run = math.atan2(0.5, FLOOR_H)
            for x in (0.55, 1.05):
                esc.append(box('stile', (x, 0.15 + FLOOR_H / 2, 0.42), (0.04, FLOOR_H / math.cos(run), 0.04), metal, rot=(run, 0, 0)))
            for i in range(1, 9):
                y = 0.15 + i * FLOOR_H / 9
                esc.append(box('rung', (0.8, y, 0.17 + 0.5 * (y - 0.15) / FLOOR_H), (0.5, 0.025, 0.025), metal))
        pieces.append(join(name, esc, smooth=False))

    escape('escape', True)
    escape('escape_top', False)

    # ---- awning over a shopfront (shallow, high)
    pieces.append(join('awning', [
        box('awning', (0, 2.98, 0.33), (2.9, 0.05, 0.72), awning_m, rot=(0.32, 0, 0)),
        box('valance', (0, 2.79, 0.68), (2.9, 0.2, 0.03), awning_m),
        *[box('arm', (x, 2.9, 0.33), (0.03, 0.03, 0.7), metal, rot=(0.32, 0, 0)) for x in (-1.3, 1.3)],
    ], smooth=False))

    # ---- roof clutter (on the roof at y = 0)
    pieces.append(join('roof_ac', [
        box('unit', (0, 0.4, 0), (1.3, 0.7, 0.95), metal),
        box('curb', (0, 0.03, 0), (1.45, 0.06, 1.1), trim),
        loft('fan', [(0.75, 0.02, 0.02), (0.76, 0.36, 0.36), (0.8, 0.36, 0.36), (0.81, 0.02, 0.02)], dark, segments=14),
        *[box('fin', (0, 0.4, z), (1.32, 0.5, 0.02), trim) for z in (-0.3, -0.1, 0.1, 0.3)],
    ], smooth=False))
    tank = [loft('tank', [(0.8, 0.02, 0.02), (0.8, 0.62, 0.62), (2.0, 0.62, 0.62), (2.0, 0.62, 0.62), (2.35, 0.05, 0.05)], wood, segments=16)]
    for x, z in ((-0.42, -0.42), (0.42, -0.42), (-0.42, 0.42), (0.42, 0.42)):
        tank.append(box('leg', (x, 0.4, z), (0.08, 0.8, 0.08), metal))
    tank += [box('hoop', (0, y, 0), (1.27, 0.04, 1.27), metal) for y in (1.1, 1.7)]
    pieces.append(join('water_tank', tank, smooth=False))
    pieces.append(join('vent', [
        loft('pipe', [(0.0, 0.12, 0.12), (0.7, 0.12, 0.12), (0.7, 0.2, 0.2), (0.78, 0.2, 0.2), (0.85, 0.02, 0.02)], metal, segments=10),
        box('base', (0, 0.03, 0), (0.4, 0.06, 0.4), trim),
    ], smooth=False))
    pieces.append(join('hatch', [box('hatch', (0, 0.25, 0), (0.9, 0.5, 0.9), trim), box('lid', (0, 0.52, 0), (1.0, 0.06, 1.0), metal)], smooth=False))

    build_yaowarat(pieces, wall, trim, concrete, glass, lit, dark, metal)
    export('street', pieces)


# ---------------------------------------------------------------- Yaowarat
# Chinatown, Bangkok: Sino-Portuguese shophouses (arched windows, louvred
# shutters, a balustraded parapet), gold shops, and neon everywhere. The
# Chinese on the signs is made up: strokes that read as characters from
# the camera, not words.
#
# More recoloured materials: "Shutter" (per building), "Neon" and "Glyph"
# (per sign; they glow, and the game lights them only at night).

def build_yaowarat(pieces, wall, trim, concrete, glass, lit, dark, metal):
    import random

    stucco = material('Stucco', '#d9d0bc', 0.9)  # mouldings, always pale
    shutter = material('Shutter', '#3f6b55', 0.8)
    neon = material('Neon', '#ff3b30', 0.4, 0.0, 3.0)
    glyph_m = material('Glyph', '#ffe08a', 0.4, 0.0, 3.0)
    board = material('Board', '#2a0d0b', 0.8)
    red = material('ShopRed', '#8a1612', 0.6)
    gold = material('Gold', '#d4a531', 0.3, 0.8, 0.4)

    def arc(r, cx, cy, n=12, a0=0.0, a1=math.pi):
        return [(cx + r * math.cos(a0 + (a1 - a0) * i / n), cy + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]

    # ---- an arched window with louvred shutters (one bay of an upper floor)
    def louvre(x, y0, y1, w, z, closed=False):
        h = y1 - y0
        slats = [box('slat', (x, y0 + 0.08 + i * 0.11, z + 0.02), (w - 0.08, 0.03, 0.03), shutter, rot=(-0.5, 0, 0)) for i in range(int((h - 0.12) / 0.11))]
        return [box('stile', (x - w / 2 + 0.03, y0 + h / 2, z), (0.05, h, 0.04), shutter), box('stile', (x + w / 2 - 0.03, y0 + h / 2, z), (0.05, h, 0.04), shutter),
                box('rail', (x, y0 + 0.03, z), (w, 0.05, 0.04), shutter), box('rail', (x, y1 - 0.03, z), (w, 0.05, 0.04), shutter), *slats]

    def arch_window(name, pane, open_shutters=True, closed=False, extra=()):
        y0, spring, R, r = 0.75, 2.05, 0.74, 0.62
        band = arc(R, 0, spring) + list(reversed(arc(r, 0, spring)))
        parts = [
            prism('arch', band, 'z', 0.0, 0.1, stucco),
            box('keystone', (0, spring + R - 0.02, 0.07), (0.16, 0.22, 0.12), stucco),
            box('jamb', (-(R + r) / 2, (y0 + spring) / 2, 0.05), (R - r, spring - y0, 0.1), stucco),
            box('jamb', ((R + r) / 2, (y0 + spring) / 2, 0.05), (R - r, spring - y0, 0.1), stucco),
            box('sill', (0, y0 - 0.04, 0.1), (1.75, 0.08, 0.2), stucco),
            box('apron', (0, y0 - 0.25, 0.04), (1.2, 0.3, 0.06), stucco),
        ]
        if closed:
            parts += louvre(-r / 2, y0, spring, r, 0.03) + louvre(r / 2, y0, spring, r, 0.03)
            parts.append(prism('fan', arc(r, 0, spring), 'z', 0.0, 0.03, dark))
        else:
            parts += pane
            parts.append(prism('fan', arc(r, 0, spring), 'z', 0.0, 0.03, pane[0].data.materials[0]))
            parts += [box('glazing', (0, spring + r * 0.5, 0.04), (0.04, r, 0.03), trim), box('transom', (0, spring, 0.04), (2 * r, 0.04, 0.03), trim)]
        if open_shutters and not closed:
            parts += louvre(-(R + 0.36), y0, spring + 0.1, 0.62, 0.04) + louvre(R + 0.36, y0, spring + 0.1, 0.62, 0.04)
        parts += list(extra)
        pieces.append(join(name, parts, smooth=False))

    pane = lambda m: [box('glass', (0, (0.75 + 2.05) / 2, 0.02), (1.24, 1.3, 0.03), m), box('mullion', (0, 1.4, 0.04), (0.04, 1.3, 0.03), trim)]
    arch_window('arch', pane(glass))
    arch_window('arch_lit', pane(lit))
    arch_window('arch_shut', [], open_shutters=False, closed=True)
    arch_window('arch_ac', pane(glass), open_shutters=False, extra=[
        box('ac', (0.25, 0.32, 0.26), (0.72, 0.44, 0.46), metal),
        box('grille', (0.25, 0.32, 0.495), (0.6, 0.34, 0.01), dark),
        box('bracket', (0.25, 0.08, 0.22), (0.6, 0.04, 0.4), trim),
    ])

    # ---- a parapet along the roof edge, one bay of it: base, balusters, cap
    balusters = [loft('baluster', [(0.12, 0.06, 0.06), (0.2, 0.09, 0.09), (0.42, 0.05, 0.05), (0.6, 0.08, 0.08), (0.66, 0.06, 0.06)], stucco, segments=8, smooth=False) for _ in range(9)]
    for i, b in enumerate(balusters):
        b.location.x += -1.2 + i * 0.3
        b.location.y -= 0.1  # Blender y is back: 0.1 m out from the wall
    pieces.append(join('parapet', [
        box('base', (0, 0.06, 0.12), (BAY, 0.12, 0.26), stucco),
        *balusters,
        box('cap', (0, 0.72, 0.12), (BAY, 0.1, 0.3), stucco),
        box('band', (0, -0.18, 0.06), (BAY, 0.3, 0.12), stucco),
    ], smooth=False))

    # ---- a gold shop: red front, gold frame, the shutter half down, a sign
    # with gold characters
    def goldshop(variant):
        rnd = random.Random(7 + variant * 23)
        parts = [
            box('plinth', (0, 0.175, 0.06), (BAY, 0.35, 0.12), red),
            box('panel', (-1.3, 1.55, 0.03), (0.4, 2.4, 0.06), red),
            box('panel', (1.3, 1.55, 0.03), (0.4, 2.4, 0.06), red),
            box('frame', (0, 2.72, 0.07), (2.3, 0.06, 0.06), gold),
            box('frame', (-1.12, 1.55, 0.07), (0.06, 2.4, 0.06), gold),
            box('frame', (1.12, 1.55, 0.07), (0.06, 2.4, 0.06), gold),
            box('display', (0, 0.62, 0.2), (2.1, 0.5, 0.36), red),
            box('displaytop', (0, 0.88, 0.2), (2.1, 0.03, 0.36), glass),
            box('glass', (0, 1.3, 0.02), (2.2, 1.0, 0.03), lit),
            box('shutter', (0, 2.15, 0.06), (2.2, 1.1, 0.04), metal),
            *[box('rib', (0, 1.66 + i * 0.12, 0.085), (2.18, 0.025, 0.02), metal) for i in range(9)],
            box('housing', (0, 2.62, 0.13), (2.3, 0.22, 0.22), metal),
            box('sign', (0, 3.12, 0.09), (BAY, 0.6, 0.14), red),
            box('signframe', (0, 3.43, 0.16), (BAY, 0.04, 0.04), gold),
            box('signframe', (0, 2.81, 0.16), (BAY, 0.04, 0.04), gold),
            box('wall', (0, 3.52, 0.01), (BAY, 0.16, 0.02), wall),
        ]
        n = rnd.choice((3, 4))
        for i in range(n):
            parts += glyph(rnd, (i - (n - 1) / 2) * 2.4 / n, 3.12, 0.44, 0.17, gold, along='x')
        pieces.append(join(f'goldshop_{variant}', parts, smooth=False))

    goldshop(0)
    goldshop(1)

    # ---- neon tubes round a shop sign, with characters on it (a few, so
    # neighbours don't say the same thing)
    for variant in range(4):
        rnd = random.Random(11 + variant * 17)
        w, y0, y1, z = BAY - 0.1, 2.83, 3.41, 0.18
        tube = [box('tube', (0, y0, z), (w, 0.035, 0.035), neon), box('tube', (0, y1, z), (w, 0.035, 0.035), neon),
                box('tube', (-w / 2, (y0 + y1) / 2, z), (0.035, y1 - y0, 0.035), neon), box('tube', (w / 2, (y0 + y1) / 2, z), (0.035, y1 - y0, 0.035), neon)]
        n = rnd.choice((3, 4, 4, 5))
        for i in range(n):
            tube += glyph(rnd, (i - (n - 1) / 2) * 2.5 / n, 3.12, 0.42, 0.175, glyph_m, along='x')
        pieces.append(join(f'sign_neon_{variant}', tube, smooth=False))

    # ---- blade signs standing out from the wall above the shops: a dark
    # board, a neon border both sides, characters stacked down it. Thin
    # across the street's view and no deeper than 0.66 m, so they hide
    # little from the camera above.
    def blade(name, n, seed):
        cell, z0, z1, t = 0.48, 0.1, 0.66, 0.1
        h = n * cell + 0.2
        zc = (z0 + z1) / 2
        parts = [
            box('board', (0, h / 2, zc), (t, h, z1 - z0), board),
            box('arm', (0, h - 0.15, 0.05), (0.04, 0.04, 0.12), metal),
            box('arm', (0, 0.15, 0.05), (0.04, 0.04, 0.12), metal),
            box('cap', (0, h + 0.03, zc), (t + 0.04, 0.06, z1 - z0 + 0.04), metal),
        ]
        chars = [seed * 31 + k for k in range(n)]  # the same characters both sides
        for side in (-1, 1):
            fx = side * (t / 2 + 0.012)
            parts += [box('tube', (fx, 0.05, zc), (0.025, 0.03, z1 - z0 - 0.02), neon), box('tube', (fx, h - 0.05, zc), (0.025, 0.03, z1 - z0 - 0.02), neon),
                      box('tube', (fx, h / 2, z0 + 0.02), (0.025, h - 0.1, 0.03), neon), box('tube', (fx, h / 2, z1 - 0.02), (0.025, h - 0.1, 0.03), neon)]
            for k in range(n):
                parts += glyph(random.Random(chars[k]), zc, 0.1 + cell * (k + 0.5), 0.36, fx, glyph_m)
        pieces.append(join(name, parts, smooth=False))

    blade('neon_blade', 4, 3)
    blade('neon_blade_b', 5, 5)
    blade('neon_blade_tall', 8, 9)

    # ---- across the street, high up: a string of red lanterns, and loose
    # power cables. Modelled from one building line to the other (x -6.5 to
    # 6.5), y up from the road. The lanterns glow at night ("Lantern").
    lantern_m = material('Lantern', '#b0140c', 0.6, 0.0, 1.0)
    cable = material('Cable', '#101112', 0.8)

    def sag(x, y0, drop, half=6.5):
        return y0 - drop * (1 - (x / half) ** 2)

    def wire(y0, drop, z, mat, t=0.025, n=16):
        parts = []
        for i in range(n):
            xa, xb = -6.5 + 13 * i / n, -6.5 + 13 * (i + 1) / n
            ya, yb = sag(xa, y0, drop), sag(xb, y0, drop)
            length = math.hypot(xb - xa, yb - ya)
            parts.append(box('wire', ((xa + xb) / 2, (ya + yb) / 2, z), (length + 0.01, t, t), mat, rot=(0, 0, math.atan2(yb - ya, xb - xa))))
        return parts

    string = wire(6.3, 0.7, 0, cable, 0.02)
    for i in range(9):
        x = -5.2 + i * 1.3
        y = sag(x, 6.3, 0.7) - 0.38
        string += [
            box('cord', (x, y + 0.28, 0), (0.01, 0.2, 0.01), cable),
            loft('lantern', [(y - 0.12, 0.04, 0.04, x, 0), (y - 0.09, 0.095, 0.095, x, 0), (y, 0.12, 0.12, x, 0), (y + 0.09, 0.095, 0.095, x, 0), (y + 0.12, 0.04, 0.04, x, 0)], lantern_m, segments=10, smooth=True),
            box('cap', (x, y + 0.13, 0), (0.09, 0.03, 0.09), gold),
            box('cap', (x, y - 0.13, 0), (0.09, 0.03, 0.09), gold),
            box('tassel', (x, y - 0.22, 0), (0.025, 0.14, 0.025), lantern_m),
        ]
    pieces.append(join('lanterns', string, smooth=None))
    pieces.append(join('cables', [*wire(7.1, 1.1, 0.0, cable), *wire(6.9, 0.8, 0.25, cable), *wire(7.4, 1.4, -0.2, cable, 0.035)], smooth=False))


build_street()
