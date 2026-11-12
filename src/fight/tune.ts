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
  gravity: 20,
  /** Knockback grows by this × wobble (wobble = hit power taken, healing slowly). */
  build: 0.045,
  /** Wobble healed per second. */
  heal: 0.05,
  /** Height (m) of the padded bumper round the ring's edge. */
  bumper: 0.65,
  /** m. */
  ringRadius: 6.5,
  /** Seconds to scramble back to full strength after a stun. */
  recoverS: 0.5,
  /** Fighters steer back once this far (m) from the edge. */
  edgeMargin: 2.5,
  /** × the random tumble a hit gives (1 = the spike's torque). */
  spin: 1,
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
  punch: 2.8, jab: 1.35, kick: 2.55, bump: 1.85, headbutt: 3.2, spin: 3.2, divebomb: 2.95,
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Walking speed (m/s) for a fighter `ringHeight` metres tall: small ones scurry, big ones lumber. */
export const speedFor = (ringHeight: number) => 4.5 * clamp(Math.sqrt(1.4 / ringHeight), 0.75, 1.6);

/** Knockback multiplier: fresh fighters (wobble 0) barely budge, wobbly ones fly. */
export const knockMultiplier = (wobble: number, build: number) => 0.3 + wobble * build;
