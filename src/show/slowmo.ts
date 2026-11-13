import { knockMultiplier } from '../fight/tune';

/** How long (s, real time) the slow-mo takes to ease back to full speed at its end. */
const EASE_OUT = 0.2;

/**
 * A brief slow-motion of the best moment (spec §4): a ring-out, or a hit big enough to launch its target over the
 * bumper (`bigLaunch`). Fires at most once per cooldown so the fight never crawls. Times are real seconds.
 */
export class SlowMo {
  readonly scale: number;
  readonly seconds: number;
  readonly cooldown: number;
  private from = -Infinity;
  private next = -Infinity;

  constructor(o?: { scale?: number; seconds?: number; cooldown?: number }) {
    this.scale = o?.scale ?? 0.25;
    this.seconds = o?.seconds ?? 0.8;
    this.cooldown = o?.cooldown ?? 6;
  }

  /** Starts a slow-mo at `now` unless one started less than a cooldown ago. True when it started. */
  trigger(now: number): boolean {
    if (now < this.next) return false;
    this.from = now;
    this.next = now + this.cooldown;
    return true;
  }

  /** × the game clock at `now`: `scale` while slowed (easing back to 1 over its last 0.2 s), else 1. */
  timeScale(now: number): number {
    const e = now - this.from;
    if (!(e >= 0) || e >= this.seconds) return 1;
    const left = this.seconds - e;
    if (left >= EASE_OUT) return this.scale;
    return this.scale + (1 - this.scale) * (1 - left / EASE_OUT);
  }
}

/**
 * A hit worth a slow-mo: its target (where it is now, already knocked) is within 2 m of the ring's edge and either
 * wobbly enough that its knockback is over 1× or launched at least `bigSpeed` m/s (the big pop-ups and specials that
 * carry it over the bouncy bumper even before it is wobbly).
 */
export function bigLaunch(target: { x: number; z: number }, wobble: number, build: number, ringRadius: number,
  launch = 0, bigSpeed = Infinity): boolean {
  return Math.hypot(target.x, target.z) > ringRadius - 2 && (knockMultiplier(wobble, build) > 1 || launch >= bigSpeed);
}
