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

const climbHands = (w) => [hand(0.05, -0.21, 0.02, w), hand(0.05, 0.21, 0.02, w)];
const vaultHand = (w) => [hand(0.08, -0.17, 0.02, w), null];

export const DEFAULT_KEYS = {
  climb: [
    // Settle in against the side, hands up on the edge, gun swung aside.
    { t: 0.16, pelvis: pelvis(-0.42, 'edge', -0.16, 'start'), pitch: 0.3, roll: 0, hipYaw: 0, stow: 1, hands: climbHands(1), feet: ['start', 'start'] },
    // Jump and pull: chest goes over the edge, lead foot finds the top.
    { t: 0.4, pelvis: pelvis(-0.3, 'edge', -0.12, 'top'), pitch: 0.95, roll: 0, hipYaw: 0, stow: 1, hands: climbHands(1), feet: ['hang', foot(0.04, 'edge', 0.1, 0, 'top')] },
    // Push down through the hands; hips over the edge, trailing leg scrapes up the side.
    { t: 0.62, pelvis: pelvis(0.06, 'edge', 0.36, 'top'), pitch: 0.75, roll: 0, hipYaw: 0, stow: 1, hands: climbHands(1), feet: [foot(-0.1, 'edge', -0.12, -0.3, 'top'), foot(0.14, 'edge', 0.1, 0, 'top')] },
    // Crouched on top, hands letting go.
    { t: 0.8, pelvis: pelvis(0.26, 'edge', 0.6, 'top'), pitch: 0.35, roll: 0, hipYaw: 0, stow: 0.6, hands: climbHands(0.5), feet: [foot(0.24, 'edge', -0.12, 0, 'top'), foot(0.34, 'edge', 0.12, 0, 'top')] },
    // Stand up and bring the gun back.
    { t: 1, pelvis: pelvis(0, 'end', 0, 'land'), pitch: 0, roll: 0, hipYaw: 0, stow: 0, hands: climbHands(0), feet: ['rest', 'rest'] },
  ],
  vault: [
    // Last step in: left hand plants on top, gun drops a little for clearance.
    { t: 0.22, pelvis: pelvis(-0.35, 'edge', -0.12, 'start'), pitch: 0.25, roll: 0.1, hipYaw: 0, stow: 0.5, hands: vaultHand(1), feet: ['start', 'start'] },
    // Over the top: hips turn, both legs swing past on the right of the hand.
    { t: 0.5, pelvis: pelvis(0, 'mid', 0.3, 'top', 0.1), pitch: 0.2, roll: 0.5, hipYaw: -0.85, stow: 0.5, hands: vaultHand(1), feet: [foot(0, 'mid', 0.32, 0.12, 'top'), foot(0.12, 'mid', 0.44, 0.18, 'top')] },
    // Coming down: lead foot reaches for the ground first.
    { t: 0.76, pelvis: pelvis(0.25, 'far', -0.18, 'land', 0.05), pitch: 0.15, roll: 0.15, hipYaw: -0.3, stow: 0.5, hands: vaultHand(0.2), feet: [foot(0.12, 'far', 0.18, 0.22, 'land'), foot(0.42, 'far', 0.12, 0, 'land')] },
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
