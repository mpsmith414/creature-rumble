import { Vector3 } from 'three/webgpu';

/** Where the entrance bridge meets the ring (radians round +y from +x, as `Math.atan2(z, x)`). */
export const ENTRY_ANGLE = -0.55;

/** The bridge: this long (m), raised with its top at the floor (y = 0), lowered out of sight below. */
export const BRIDGE_LEN = 9;
export const BRIDGE_UP_Y = -0.2;
export const BRIDGE_DOWN_Y = -6;
/** Seconds the bridge takes to rise all the way (or drop all the way). */
export const BRIDGE_RISE_S = 0.9;

/** The posts: this many evenly round the ring, turned by `POST_OFFSET`, minus any within `POST_GAP` of the entry. */
export const POST_COUNT = 8;
export const POST_OFFSET = 0.2;
export const POST_GAP = 0.3;

/** The flat direction (unit, y = 0) from the ring's centre out to the entry. */
export function entryDir(angle: number, out = new Vector3()): Vector3 {
  return out.set(Math.cos(angle), 0, Math.sin(angle));
}

/** Smallest signed difference a − b, in (−π, π]. */
export const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/** The posts' angles round the ring, leaving the entry clear (the spike's 8 less the one in the gap = 7). */
export function postAngles(entry = ENTRY_ANGLE, count = POST_COUNT, offset = POST_OFFSET, gap = POST_GAP): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + offset;
    if (Math.abs(angleDiff(a, entry)) >= gap) out.push(a);
  }
  return out;
}

/** The bridge's progress (0 down … 1 up) after `dt` s heading up (`on`) or down, at a steady rate, clamped. */
export function bridgeStep(p: number, on: boolean, dt: number): number {
  const step = dt / BRIDGE_RISE_S;
  return on ? Math.min(1, p + step) : Math.max(0, p - step);
}

/** The bridge's height for progress `p`: eased in and out (smoothstep), so it starts and lands softly both ways. */
export function bridgeY(p: number): number {
  const k = Math.min(1, Math.max(0, p));
  return BRIDGE_DOWN_Y + (BRIDGE_UP_Y - BRIDGE_DOWN_Y) * k * k * (3 - 2 * k);
}

/** The bumper torus: tube radius at scale 1 (m); its vertical scale so it spans 0 … `height`, like the colliders. */
export const BUMPER_TUBE = 0.28;
export const bumperScale = (height: number) => Math.max(0.3, height / (2 * BUMPER_TUBE));
