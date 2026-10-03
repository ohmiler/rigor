/**
 * Keyframes for vaults and climbs, as plain data so the lab can edit them.
 *
 * Positions are in a "ledge frame" built from the obstacle in front of you:
 *   a  distance along the travel direction, measured from `aFrom`:
 *        'edge' near edge of the obstacle, 'mid' its middle, 'far' its far
 *        side, 'end' where the move finishes
 *   u  height, measured from `uFrom`:
 *        'top' the obstacle's top surface; 'start' / 'land' your standing
 *        height before / after the move (for hips that includes hip height,
 *        for feet it's the floor)
 *   s  sideways, + is to your right
 *
 * Each key (key 0 is always "wherever the body is when the move starts"):
 *   t        0..1 through the move
 *   pelvis   { a, aFrom, u, uFrom, s }
 *   pitch    torso lean forward (radians), roll lean right, hipYaw hips turn
 *   stow     0 = gun aimed, 1 = gun swung down to the side
 *   hands    [left, right]: { a, s, u, w } on the ledge (a from edge, u from
 *            top, w = how much the hand is on it), or null
 *   feet     [left, right]: { a, aFrom, s, u, uFrom }, or 'start' (where it
 *            was), 'hang' (dangling under the hip), 'rest' (standing at the end)
 */

const hand = (a, s, u, w) => ({ a, s, u, w });
const foot = (a, aFrom, s, u, uFrom) => ({ a, aFrom, s, u, uFrom });
const pelvis = (a, aFrom, u, uFrom, s = 0) => ({ a, aFrom, u, uFrom, s });

// Hands go well onto the top, not on the lip: with the torso pitched over
// them, that's what keeps the shoulders within an arm's length.
const climbHands = (w) => [hand(0.16, -0.21, 0.02, w), hand(0.16, 0.21, 0.02, w)];
const vaultHand = (w) => [hand(0.15, -0.17, 0.02, w), null];

// A few rules every key set here follows (the lab's "Check all moves" tests them):
//  - a foot never cuts through the obstacle's corner: it reaches the lip
//    from outside first, then steps in;
//  - hip to ankle stays at least ~25 cm (a real deep squat), or the knee
//    whips around with every small foot move;
//  - planted hands stay within an arm's length of the shoulders.
export const DEFAULT_KEYS = {
  climb: [
    // Step in and slap both hands on top; sink into a crouch to load the jump.
    { t: 0.13, pelvis: pelvis(-0.34, 'edge', -0.24, 'start'), pitch: 0.38, roll: 0, hipYaw: 0, stow: 1, hands: climbHands(1), feet: ['start', 'start'] },
    // Jump and pull: hips up to the edge; trailing foot pushes off the ground,
    // lead foot plants on the face well below the lip.
    { t: 0.3, pelvis: pelvis(-0.2, 'edge', -0.12, 'top'), pitch: 0.5, roll: 0, hipYaw: 0, stow: 1, hands: climbHands(1), feet: ['start', foot(-0.15, 'edge', 0.14, -0.55, 'top')] },
    // Arms lock: lead foot walks up the face, trailing leg hangs.
    { t: 0.42, pelvis: pelvis(-0.1, 'edge', 0.1, 'top'), pitch: 0.6, roll: 0, hipYaw: 0, stow: 1, hands: climbHands(1), feet: ['hang', foot(-0.06, 'edge', 0.14, -0.3, 'top')] },
    // The press: torso tips nearly flat over the hands so the hips can rise,
    // and the lead foot reaches the lip from outside.
    { t: 0.54, pelvis: pelvis(-0.04, 'edge', 0.4, 'top'), pitch: 1.0, roll: 0, hipYaw: 0, stow: 1, hands: climbHands(0.7), feet: ['hang', foot(-0.04, 'edge', 0.13, 0.05, 'top')] },
    // Lead foot steps in under the hips; hands start to come off.
    { t: 0.63, pelvis: pelvis(0.02, 'edge', 0.42, 'top'), pitch: 0.8, roll: 0, hipYaw: 0, stow: 1, hands: climbHands(0.4), feet: ['hang', foot(0, 'end', 0.11, 0, 'land')] },
    // Step through: trailing foot comes up the outside to the lip, weight
    // over the lead foot ('land' = the top for a box, the roof for a car).
    { t: 0.73, pelvis: pelvis(0.18, 'edge', -0.42, 'land'), pitch: 0.45, roll: 0, hipYaw: 0, stow: 0.8, hands: climbHands(0.1), feet: [foot(-0.05, 'edge', -0.14, 0.1, 'top'), foot(0, 'end', 0.11, 0, 'land')] },
    // Both feet on top, crouched, rising.
    { t: 0.85, pelvis: pelvis(-0.1, 'end', -0.3, 'land'), pitch: 0.25, roll: 0, hipYaw: 0, stow: 0.5, hands: climbHands(0), feet: [foot(0, 'end', -0.11, 0, 'land'), foot(0, 'end', 0.11, 0, 'land')] },
    // Stand up and bring the gun back.
    { t: 1, pelvis: pelvis(0, 'end', 0, 'land'), pitch: 0, roll: 0, hipYaw: 0, stow: 0, hands: climbHands(0), feet: ['rest', 'rest'] },
  ],
  // A tuck vault: one hand plants and pushes, both knees come up to the chest
  // and the legs pass over together in front. (A speed vault swings the legs
  // out sideways, which tangles the legs; this keeps them in front, where a
  // knee naturally bends up.)
  vault: [
    // Last step in: left hand reaching for the top.
    { t: 0.2, pelvis: pelvis(-0.28, 'edge', -0.1, 'start'), pitch: 0.3, roll: -0.15, hipYaw: 0, stow: 0.5, hands: vaultHand(0.7), feet: ['start', 'start'] },
    // Push off: hips spring up while the legs stay long behind, driving off the ground.
    { t: 0.32, pelvis: pelvis(-0.12, 'edge', 0.3, 'top', 0.04), pitch: 0.35, roll: -0.35, hipYaw: -0.15, stow: 0.5, hands: vaultHand(0.7), feet: [foot(-0.5, 'edge', -0.06, -0.5, 'top'), foot(-0.55, 'edge', 0.12, -0.55, 'top')] },
    // Knees coming up outside the face: the feet stay clear of the near side while the hips rise.
    { t: 0.4, pelvis: pelvis(-0.07, 'edge', 0.48, 'top', 0.045), pitch: 0.32, roll: -0.38, hipYaw: -0.16, stow: 0.5, hands: vaultHand(0.65), feet: [foot(-0.2, 'edge', -0.05, 0.03, 'top'), foot(-0.23, 'edge', 0.12, 0, 'top')] },
    // Tuck: with the hips up, knees snap to the chest; feet at the lip, just above it.
    { t: 0.45, pelvis: pelvis(-0.02, 'edge', 0.52, 'top', 0.05), pitch: 0.3, roll: -0.4, hipYaw: -0.18, stow: 0.5, hands: vaultHand(0.6), feet: [foot(-0.08, 'edge', -0.04, 0.03, 'top'), foot(-0.12, 'edge', 0.13, 0.02, 'top')] },
    // Over: hand pushes away, tucked legs pass over the top in front of the hips.
    { t: 0.55, pelvis: pelvis(0, 'mid', 0.56, 'top', 0.06), pitch: 0.25, roll: -0.45, hipYaw: -0.2, stow: 0.5, hands: vaultHand(0.5), feet: [foot(0.18, 'mid', -0.04, 0.04, 'top'), foot(0.12, 'mid', 0.14, 0.03, 'top')] },
    // Coming down past the far side, right foot reaching for the ground.
    { t: 0.84, pelvis: pelvis(0.2, 'far', -0.22, 'land', 0.02), pitch: 0.2, roll: -0.15, hipYaw: 0, stow: 0.4, hands: vaultHand(0.1), feet: [foot(0.35, 'far', -0.08, 0.15, 'land'), foot(0.45, 'far', 0.1, 0, 'land')] },
    // Land and run on.
    { t: 1, pelvis: pelvis(0, 'end', 0, 'land'), pitch: 0, roll: 0, hipYaw: 0, stow: 0, hands: vaultHand(0), feet: ['rest', 'rest'] },
  ],
};

const STORAGE_KEY = 'rigor.traversalKeys.v1';

export const cloneKeys = (keys) => JSON.parse(JSON.stringify(keys));

function load() {
  const keys = cloneKeys(DEFAULT_KEYS);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved?.climb?.length && saved?.vault?.length) Object.assign(keys, saved);
  } catch {
    // No storage or bad data: keep the defaults from code.
  }
  return keys;
}

// The live keys. The lab edits these in place; the game reads them every move.
export const TRAVERSAL_KEYS = load();

export function saveKeys() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(TRAVERSAL_KEYS));
    return true;
  } catch {
    return false;
  }
}

export function resetKeys() {
  const fresh = cloneKeys(DEFAULT_KEYS);
  for (const type of Object.keys(fresh)) {
    TRAVERSAL_KEYS[type].length = 0;
    TRAVERSAL_KEYS[type].push(...fresh[type]);
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function hasSavedKeys() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}
