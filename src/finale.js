// The end of the street: the holdout, as Left 4 Dead ends a campaign.
//
//   waiting   reach the extraction point under the gate and radio (E),
//   holdout   hold out until the helicopter comes, the Director throwing
//             everything it has from both ends of the street,
//   arriving  it comes in over the gate,
//   landed    it hangs over the extraction point: get under it,
//   rescued   and you're out.
//
// All of it is simulation (the radio is a recorded command, the clock is
// game time), so a replay ends the same way.

export const FINALE = {
  holdout: 120, // seconds from the radio call to the helicopter
  arrive: 7, // seconds it takes to come in and settle
  // Where it hangs: low over the point, side on, so the camera behind you
  // sees it and its rotor clears the gate's beams and plaque.
  hover: { y: 4.5, ahead: -2.5 },
  from: { y: 32, ahead: 60 }, // where it comes from: high up, beyond the gate
};

export class Finale {
  /** @param {{ pos: { x: number, y: number, z: number }, radius: number }} goal */
  constructor(goal) {
    this.goal = goal;
    this.reset();
    /** @type {(() => void) | null} */
    this.onCall = null;
    /** @type {(() => void) | null} */
    this.onArrive = null;
  }

  reset() {
    this.phase = 'waiting';
    this.t = 0;
  }

  _inZone(player) {
    return Math.hypot(player.pos.x - this.goal.pos.x, player.pos.z - this.goal.pos.z) < this.goal.radius;
  }

  /** Standing in the extraction point with the radio still to make. */
  canCall(player) {
    return this.phase === 'waiting' && player.state === 'normal' && this._inZone(player);
  }

  /** The radio (E). Does nothing unless it can. */
  call(player) {
    if (!this.canCall(player)) return false;
    this.phase = 'holdout';
    this.t = 0;
    this.onCall?.();
    return true;
  }

  /** Seconds left before the helicopter (the holdout only). */
  get timeLeft() {
    return this.phase === 'holdout' ? Math.max(FINALE.holdout - this.t, 0) : 0;
  }

  /** One simulation step. Returns true on the step the player is rescued. */
  update(dt, player) {
    if (this.phase === 'waiting' || this.phase === 'rescued') return false;
    this.t += dt;
    if (this.phase === 'holdout' && this.t >= FINALE.holdout) {
      this.phase = 'arriving';
      this.t = 0;
      this.onArrive?.();
    } else if (this.phase === 'arriving' && this.t >= FINALE.arrive) {
      this.phase = 'landed';
      this.t = 0;
    }
    if (this.phase === 'landed' && player.state === 'normal' && this._inZone(player)) {
      this.phase = 'rescued';
      return true;
    }
    return false;
  }

  /**
   * Where the helicopter is (for the looks): `out` set and true while it's
   * in the sky, false before it comes. Eases in from beyond the gate.
   */
  heliPose(out) {
    if (this.phase !== 'arriving' && this.phase !== 'landed' && this.phase !== 'rescued') return false;
    const { x, z } = this.goal.pos;
    const k = this.phase === 'arriving' ? Math.min(this.t / FINALE.arrive, 1) : 1;
    // In high over the gate first, then straight down: it never cuts
    // through the roof on the way.
    const across = 1 - (1 - Math.min(k / 0.6, 1)) ** 3;
    const v = Math.min(Math.max((k - 0.45) / 0.55, 0), 1);
    const down = v * v * (3 - 2 * v);
    out.set(
      x,
      FINALE.from.y + (FINALE.hover.y - FINALE.from.y) * down,
      z + FINALE.from.ahead + (FINALE.hover.ahead - FINALE.from.ahead) * across,
    );
    return true;
  }
}
