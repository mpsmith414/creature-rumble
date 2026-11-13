import type { Move } from './types';

/**
 * The fight's feel, from the spike the owner played (spec §3.2). Mutable: the dev sliders write it, and every fighter
 * and the arena read it live.
 */
export const TUNE = {
  /** × every hit's power. */
  knock: 0.45,
  /** × how long a hit stuns. */
  flop: 0.75,
  /** Restitution of every body piece. */
  bounce: 0.15,
  /** m/s², down. */
  gravity: 16,
  /** Knockback grows by this × wobble (wobble = hit power taken, healing slowly). */
  build: 0.028,
  /** Wobble healed per second. */
  heal: 0.05,
  /** Height (m) of the padded bumper round the ring's edge. */
  bumper: 0.65,
  /** m. */
  ringRadius: 6.5,
  /** Seconds to scramble back to full strength after a stun. */
  recoverS: 0.2,
  /** Fighters steer back once this far (m) from the edge. */
  edgeMargin: 2.5,
  /** × the random tumble a hit gives (1 = the spike's torque). */
  spin: 1,
  /** The outward part of a fresh fighter's launch (× power, before wobble adds `build` × wobble): small, so early hits pop up in place. */
  drift: 0,
  /** Upward launch speed (m/s) of a normal hit of power 1 on a 1 kg body: hits pop fighters up from the first one. */
  pop: 7,
  /** Restitution of the ring's top: fliers bounce. */
  floorBounce: 0.45,
  /** Restitution of the bumper: a trampoline wall that sends fliers back in. */
  bumperBounce: 0.95,
};
export type Tune = typeof TUNE;

/** Seconds of [wind-up, strike, cool-down] per move (the cool-down is × 0.7–1.3 per attack). */
export const MOVE_TIMING: Record<Move, [windup: number, strike: number, cool: number]> = {
  punch: [0.45, 0.75, 0.4],
  jab: [0.12, 0.45, 0.4],
  kick: [0.3, 0.9, 0.4],
  bump: [0.4, 1.0, 0.4],
  headbutt: [0.55, 1.3, 0.4],
  spin: [0.2, 1.6, 0.4],
  divebomb: [0.45, 1.0, 0.8],
};

/** A landed hit's power (before × `knock`). */
export const MOVE_POWER: Record<Move, number> = {
  punch: 2.4, jab: 1.5, kick: 2.65, bump: 1.7, headbutt: 2.5, spin: 2.65, divebomb: 2.8,
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Walking speed (m/s) for a fighter `ringHeight` metres tall: small ones scurry, big ones lumber. */
export const speedFor = (ringHeight: number) => 4.5 * clamp(Math.sqrt(1.4 / ringHeight), 0.75, 1.6);

/** Knockback multiplier: fresh fighters (wobble 0) barely budge, wobbly ones fly. */
export const knockMultiplier = (wobble: number, build: number) => 0.3 + wobble * build;

/**
 * A hit's launch (m/s) on a body of `mass` kg whose wobble (this hit's power included) is `wobble`: `out` (away from
 * the attacker) grows with wobble, so early hits pop a fighter up where it stands and late ones send it flying; `up` is
 * big from the first hit. `how` scales each part (specials hit harder and higher).
 */
export function launchFor(power: number, wobble: number, mass: number, tune: Pick<Tune, 'build' | 'pop' | 'drift'>,
  how: { out?: number; up?: number } = {}): { out: number; up: number } {
  const dv = (power * 2.6 * (tune.drift + wobble * tune.build)) / mass ** 0.3;
  return { out: 0.85 * dv * (how.out ?? 1), up: (tune.pop * Math.sqrt(power) * (how.up ?? 1)) / mass ** 0.1 };
}
