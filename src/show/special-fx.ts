import { SPECIAL_TITLE, type SpecialName } from '../fight/special';
import { SHAKE_MAX } from './camera';

/**
 * The show's side of special attacks and air time (big-fights design §3): how strongly a fighter glows, the big word a
 * special's impact pops, what the announcer calls it, and when a fighter counts as flying. Pure.
 */

/** The glow while a special winds up and plays: it pulses between these (never off, never a hard flash). */
export const GLOW_LOW = 0.7, GLOW_HIGH = 1;
/** How fast the strong glow pulses (Hz): slow and soft, well under the 3 Hz a flashing screen must stay below. */
export const GLOW_HZ = 2;
/** The faint glow of a filling meter: none below GLOW_FROM full, up to GLOW_FAINT when full, pulsing slowly. */
export const GLOW_FROM = 0.4, GLOW_FAINT = 0.22, FAINT_HZ = 0.8;

const smooth = (a: number, b: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/**
 * How strongly a fighter glows (0 … 1) at show time `t` s: a soft pulse between GLOW_LOW and GLOW_HIGH while its special
 * is under way (`on`); otherwise a faint glow that grows as its meter (0 … 1) fills.
 */
export function glowLevel(meter: number, on: boolean, t: number): number {
  if (on) return GLOW_LOW + (GLOW_HIGH - GLOW_LOW) * (0.5 + 0.5 * Math.sin(t * GLOW_HZ * Math.PI * 2));
  const m = Number.isFinite(meter) ? meter : 0;
  const faint = GLOW_FAINT * smooth(GLOW_FROM, 1, m);
  return faint * (0.8 + 0.2 * Math.sin(t * FAINT_HZ * Math.PI * 2));
}

/** The big comic word a special's impact pops. */
export const SPECIAL_POP: Record<SpecialName, string> = {
  megaPunch: 'KA-BLAMMO!',
  jabFlurry: 'BIFF-BAFF-BOFF!',
  helicopterKick: 'WHIRLY-BONK!',
  bellyBomb: 'SUPER SPLAT!',
  rocketHeadbutt: 'MEGA BONK!',
  tornadoTail: 'WHOOSH-A-BOOM!',
  meteorDive: 'KER-SPLOOSH!',
};
/** How big (× a normal pop) the impact word is. */
export const SPECIAL_POP_SIZE = 1.9;
/** A special's impact with no reach of its own (a body blow) still makes a shockwave this big (m). */
export const IMPACT_RING = 1.6;
/** The camera shake (m) of an impact reaching `radius` m: a little more for a bigger one, never past SHAKE_MAX. */
export const shakeFor = (radius: number) => Math.min(SHAKE_MAX, 0.05 + 0.012 * Math.max(0, Number.isFinite(radius) ? radius : 0));

/** The special's name as the announcer says it (the `{special}` slot): its title without the shout mark. */
export const specialSaid = (s: SpecialName) => SPECIAL_TITLE[s].replace(/!+$/, '').trim();

/** Popped over a fighter launched high. */
export const WHEEE = 'WHEEE!';
/** A hit launching its target at least this fast (m/s) is a big launch (WHEEE!, the crowd's ooh): about the top quarter of normal hits (p75 8.4 m/s) plus every special. */
export const WHEE_LAUNCH = 8.4;
/** A flier this high (m) over where its torso stands is a big launch too, measured as it flies. */
export const WHEE_HEIGHT = 2;
/** One fighter's WHEEE! comes at most this often (s); the crowd's ooh at most this often for everyone. */
export const WHEE_GAP = 1.5, OOH_GAP = 2.5;

/** Flying: the torso this far (m) over where it stands, or going up / outward this fast (m/s). */
export const AIR_ABOVE = 0.8, AIR_UP = 5, AIR_OUT = 7;

/**
 * Is a fighter in the air (for its motion trail)? `y` its torso's height, `rest` the height its torso stands at, `vy`
 * its upward speed and `vOut` its speed away from the ring's middle (m/s).
 */
export function airborne(y: number, rest: number, vy: number, vOut: number): boolean {
  if (!(y > -0.5)) return false; // dropping into the ball pit: no trail
  return y - rest > AIR_ABOVE || vy > AIR_UP || vOut > AIR_OUT;
}

/** The speed (m/s) of a body at (`x`, `z`) moving (`vx`, `vz`) away from the ring's middle (negative: toward it). */
export function outward(x: number, z: number, vx: number, vz: number): number {
  const r = Math.hypot(x, z);
  return r > 1e-6 ? (x * vx + z * vz) / r : Math.hypot(vx, vz);
}
