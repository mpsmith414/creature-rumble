/** Ring heights (m) are squeezed into this range, so a mouse and a dinosaur can share a ring. */
const RING_MIN = 0.7, RING_MAX = 2.4;

/**
 * The factor a creature of `naturalHeight` metres is scaled by in the ring: its ring height is
 * clamp(1.4 × naturalHeight^0.35, 0.7, 2.4) m, so small creatures grow and big ones shrink, but order is kept.
 */
export function ringScale(naturalHeight: number): number {
  const ring = Math.min(RING_MAX, Math.max(RING_MIN, 1.4 * naturalHeight ** 0.35));
  return ring / naturalHeight;
}
