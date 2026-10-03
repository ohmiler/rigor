# Builds the player's body in Blender, one part per slot of a Humanoid
# (humanoid.js), and exports them together to public/models/player.glb.
# Run with `npm run models`.
#
# The game keeps animating the body itself (gait, IK, ragdoll); a part only
# replaces the primitive in its slot, so each is modelled in that slot's own
# frame, in game coordinates (x, y up, z forward):
#
#   pelvis, chest, head  centred on the joint; +z is the way the body faces
#                        (the character's right is -x)
#   abdomen              1 m tall, centred; stretched to fit each frame
#   neck, upperArm,      along +y from the joint nearer the body (-length/2)
#   forearm, thigh, shin to the far one (+length/2); +z is the limb's front
#                        (where the knee points; the inside of the elbow)
#   shoulder             a ball on the shoulder joint
#   hand                 at the wrist, fingers along +z (a left hand; the
#                        right is this one mirrored)
#   foot, toe            the heel block (ankle at 0, 0.035, -0.03) and the
#                        toes, hinged at the ball
#
# Lengths match DIMS in humanoid.js. Materials named Skin, Shirt, Pants,
# Shoes and Cap take the character's own colours in the game; the rest keep
# theirs from here.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kit import reset, material, box, loft, bevel, join, export  # noqa: E402

THIGH, SHIN, UPPER_ARM, FOREARM = 0.46, 0.45, 0.29, 0.27


def build_player():
    reset()
    skin = material('Skin', '#e0ac86', 0.7)
    shirt = material('Shirt', '#3f86d4', 0.85)  # the jacket
    pants = material('Pants', '#283447', 0.9)
    shoes = material('Shoes', '#1d2129', 0.75)
    cap = material('Cap', '#24324f', 0.85)
    trim = material('Trim', '#1b1f27', 0.6)
    belt = material('Belt', '#2b2219', 0.6)
    metal = material('Buckle', '#a8a59c', 0.35, 0.8)
    sole = material('Sole', '#0e0f11', 0.95)
    glove = material('Glove', '#22252b', 0.8)
    eye = material('Eye', '#14110f', 0.4)
    hair = material('Hair', '#3a2a1e', 0.9)
    parts = []

    # ---- torso
    # Chest: broad at the shoulders, a little deeper in front, narrowing to
    # the collar. Zip, pockets with flaps.
    chest = loft('chest', [
        (-0.175, 0.15, 0.09), (-0.17, 0.165, 0.1), (-0.06, 0.18, 0.108, 0, 0.004),
        (0.07, 0.192, 0.112, 0, 0.006), (0.135, 0.19, 0.104, 0, 0.002), (0.165, 0.14, 0.085), (0.175, 0.07, 0.06),
    ], shirt, segments=16)
    collar = loft('collar', [(0.13, 0.075, 0.068, 0, -0.004), (0.15, 0.08, 0.072, 0, -0.004), (0.195, 0.068, 0.062, 0, -0.006), (0.2, 0.062, 0.056, 0, -0.006)], shirt)
    zip_ = box('zip', (0, -0.02, 0.113), (0.012, 0.3, 0.008), trim)
    pockets = [box('pocket', (x, 0.02, 0.112), (0.085, 0.07, 0.01), shirt) for x in (-0.09, 0.09)]
    flaps = [box('flap', (x, 0.058, 0.118), (0.09, 0.022, 0.012), trim) for x in (-0.09, 0.09)]
    parts.append(join('chest', [chest, collar, zip_, *pockets, *flaps]))

    # Abdomen: a slab of jacket that stretches between pelvis and chest.
    # Kept a little inside the chest and the hem, where they overlap it.
    belly = loft('belly', [(-0.5, 0.13, 0.082), (-0.48, 0.14, 0.088), (0.48, 0.148, 0.092), (0.5, 0.14, 0.086)], shirt, segments=16)
    zip2 = box('zip', (0, 0, 0.092), (0.012, 1.0, 0.008), trim)
    parts.append(join('abdomen', [belly, zip2]))

    # Pelvis: the hips of the trousers, a belt, a buckle, the jacket hem.
    hips = loft('hips', [(-0.095, 0.11, 0.08), (-0.08, 0.15, 0.1), (0.03, 0.155, 0.102), (0.09, 0.15, 0.098), (0.1, 0.12, 0.08)], pants, segments=16)
    belt_ = loft('belt', [(0.035, 0.158, 0.104), (0.07, 0.158, 0.104)], belt, segments=16)
    buckle = box('buckle', (0, 0.052, 0.106), (0.04, 0.03, 0.008), metal)
    hem = loft('hem', [(0.06, 0.165, 0.108), (0.11, 0.168, 0.11)], shirt, segments=16)
    parts.append(join('pelvis', [hips, belt_, buckle, hem]))

    # ---- head
    # A head shaped by rings from chin to crown (the face pushed forward),
    # nose, ears, eyes, brows, and the cap with its brim.
    head = loft('head', [
        (-0.118, 0.03, 0.03, 0, 0.035), (-0.105, 0.055, 0.05, 0, 0.03), (-0.08, 0.072, 0.075, 0, 0.018),
        (-0.03, 0.084, 0.094, 0, 0.006), (0.02, 0.089, 0.1), (0.065, 0.086, 0.097, 0, -0.004),
        (0.1, 0.066, 0.078, 0, -0.008), (0.122, 0.022, 0.025, 0, -0.01),
    ], skin, segments=16)
    nose = box('nose', (0, -0.012, 0.1), (0.024, 0.042, 0.03), skin)
    ears = [box('ear', (x, 0.0, -0.004), (0.022, 0.042, 0.03), skin) for x in (-0.088, 0.088)]
    eyes = [box('eye', (x, 0.022, 0.093), (0.022, 0.012, 0.008), eye) for x in (-0.033, 0.033)]
    brows = [box('brow', (x, 0.04, 0.095), (0.03, 0.009, 0.01), hair) for x in (-0.033, 0.033)]
    sideburns = [box('hair', (x, 0.01, 0.0), (0.012, 0.05, 0.05), hair) for x in (-0.085, 0.085)]
    dome = loft('cap', [(0.032, 0.097, 0.107, 0, -0.004), (0.075, 0.094, 0.104, 0, -0.006), (0.108, 0.072, 0.082, 0, -0.01), (0.132, 0.022, 0.025, 0, -0.01)], cap, segments=16)
    brim = box('brim', (0, 0.036, 0.13), (0.15, 0.014, 0.075), cap, rot=(0.12, 0, 0))  # tipped down a touch
    parts.append(join('head', [head, nose, *ears, *eyes, *brows, *sideburns, dome, brim]))

    parts.append(loft('neck', [(-0.075, 0.03, 0.03), (-0.06, 0.046, 0.046), (0.06, 0.044, 0.044), (0.075, 0.03, 0.03)], skin, segments=10))
    parts.append(loft('shoulder', [(-0.066, 0.015, 0.015), (-0.045, 0.05, 0.05), (0, 0.068, 0.066), (0.045, 0.05, 0.05), (0.066, 0.015, 0.015)], shirt, segments=12))

    # ---- arms (along +y from shoulder to elbow, elbow to wrist)
    h = UPPER_ARM / 2
    parts.append(loft('upperArm', [
        (-h - 0.03, 0.02, 0.02), (-h - 0.01, 0.054, 0.054), (-h + 0.06, 0.058, 0.056, 0, 0.004),
        (0.02, 0.054, 0.052, 0, 0.004), (h - 0.02, 0.048, 0.046), (h + 0.02, 0.03, 0.03),
    ], shirt))
    h = FOREARM / 2
    sleeve = loft('sleeve', [
        (-h - 0.03, 0.02, 0.02), (-h - 0.01, 0.05, 0.05), (-0.02, 0.048, 0.046), (0.05, 0.05, 0.048), (0.07, 0.052, 0.05), (0.075, 0.04, 0.04),
    ], shirt)
    cuff = loft('cuff', [(0.06, 0.052, 0.05), (0.075, 0.053, 0.051)], trim)
    wrist = loft('wrist', [(0.04, 0.04, 0.036), (h - 0.01, 0.031, 0.027), (h + 0.015, 0.018, 0.016)], skin)
    parts.append(join('forearm', [sleeve, cuff, wrist]))

    # Hand (the left; the right is it mirrored): gloved palm, fingers bent
    # a little, a thumb.
    palm = box('palm', (0, 0, 0.037), (0.08, 0.032, 0.075), glove)
    fingers = box('fingers', (-0.002, -0.01, 0.094), (0.074, 0.025, 0.055), glove, rot=(0.25, 0, 0))
    thumb = box('thumb', (0.043, -0.008, 0.03), (0.024, 0.024, 0.05), glove, rot=(0, 0.5, 0))
    for b in (palm, fingers, thumb):
        bevel(b, 0.008, 2, 30)
    parts.append(join('hand', [palm, fingers, thumb], smooth=False))

    # ---- legs (along +y from hip to knee, knee to ankle; +z = knee's way)
    h = THIGH / 2
    parts.append(loft('thigh', [
        (-h - 0.03, 0.05, 0.05), (-h, 0.088, 0.082), (-0.1, 0.083, 0.078, 0, 0.004),
        (0.08, 0.068, 0.066, 0, 0.003), (h - 0.02, 0.06, 0.062, 0, 0.006), (h + 0.025, 0.036, 0.036, 0, 0.006),
    ], pants))
    h = SHIN / 2
    leg = loft('shin', [
        (-h - 0.025, 0.036, 0.036), (-h + 0.005, 0.06, 0.06, 0, 0.004), (-0.11, 0.059, 0.066, 0, -0.008),
        (0.03, 0.051, 0.052), (0.13, 0.049, 0.05), (0.16, 0.045, 0.046),
    ], pants)
    # Boot shaft up over the ankle, with a rolled top.
    shaft = loft('boot', [(0.1, 0.05, 0.052), (0.115, 0.058, 0.06), (0.135, 0.054, 0.058), (h + 0.02, 0.052, 0.062, 0, -0.004), (h + 0.04, 0.045, 0.055, 0, -0.004)], shoes)
    parts.append(join('shin', [leg, shaft]))

    # Foot: the heel end of the boot over a thick sole (sole at y = -0.035).
    foot = loft('foot', [
        (-0.098, 0.025, 0.02, 0, -0.006), (-0.088, 0.046, 0.04, 0, -0.002), (-0.05, 0.053, 0.044, 0, 0.002),
        (0.03, 0.054, 0.038, 0, -0.001), (0.085, 0.052, 0.032, 0, -0.004),
    ], shoes, axis='z')
    heel = box('sole', (0, -0.026, -0.005), (0.108, 0.018, 0.186), sole)
    parts.append(join('foot', [foot, heel]))
    # Toes, hinged at the ball: a rounded toe cap on the sole.
    toe = loft('toe', [(-0.005, 0.052, 0.03, 0, -0.004), (0.045, 0.051, 0.027, 0, -0.006), (0.08, 0.042, 0.021, 0, -0.01), (0.098, 0.02, 0.012, 0, -0.012)], shoes, axis='z')
    toe_sole = box('sole', (0, -0.017, 0.045), (0.102, 0.016, 0.1), sole)
    parts.append(join('toe', [toe, toe_sole]))

    export('player', parts)


build_player()
