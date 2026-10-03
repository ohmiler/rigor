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
from kit import reset, material, box, loft, join, export  # noqa: E402

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

    export('street', pieces)


build_street()
