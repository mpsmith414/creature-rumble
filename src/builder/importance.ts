import type { Role } from '../recipe/schema';
import { boneSdf, thinAxis } from './sdf';
import type { Skeleton } from './skeleton';

/** How much detail each kind of part deserves when the mesh is simplified (≥ 1). */
export const ROLE_IMPORTANCE: Record<Role, number> = {
  head: 6, mouth: 8, eye: 8, ear: 5, foot: 3, hand: 3, horn: 2, antenna: 2, neck: 1.5, leg: 1.5, arm: 1.5,
  torso: 1, wing: 1, tail: 1, fin: 1, other: 1,
};

/** Extra weight on a leg within one radius (along the bone) of either end: knees, hocks, hips and wrists. */
const JOINT_BONUS = 1.5;

/** Extra weight per unit of a vertex's strongest colour mark (nose, inner ear, mouth, hoof keep their detail). */
const MARK_BONUS = 6;

/**
 * How much detail each vertex deserves (≥ 1): faces most, then feet and joints, from the nearest bone (eyes included);
 * plus MARK_BONUS × its strongest mark when `marks` (4 per vertex) is given.
 */
export function importance(sk: Skeleton, positions: Float32Array, marks?: Float32Array): Float32Array {
  const bones = sk.bones.map((b) => {
    const ax = b.end.x - b.start.x, ay = b.end.y - b.start.y, az = b.end.z - b.start.z;
    const len = Math.hypot(ax, ay, az) || 1;
    return { b, thin: thinAxis(b), ax: ax / len, ay: ay / len, az: az / len, len };
  });
  const n = positions.length / 3;
  const out = new Float32Array(n);
  const p = { x: 0, y: 0, z: 0 };
  for (let v = 0; v < n; v++) {
    p.x = positions[v * 3]; p.y = positions[v * 3 + 1]; p.z = positions[v * 3 + 2];
    let best = 0, bd = Infinity;
    for (let i = 0; i < bones.length; i++) {
      const d = boneSdf(p, bones[i].b, bones[i].thin);
      if (d < bd) { bd = d; best = i; }
    }
    const { b, ax, ay, az, len } = bones[best];
    let w = ROLE_IMPORTANCE[b.role];
    if (b.role === 'leg') {
      const t = (p.x - b.start.x) * ax + (p.y - b.start.y) * ay + (p.z - b.start.z) * az;
      if (t <= b.r0 || t >= len - b.r1) w += JOINT_BONUS;
    }
    if (marks) w += MARK_BONUS * Math.max(marks[v * 4], marks[v * 4 + 1], marks[v * 4 + 2], marks[v * 4 + 3]);
    out[v] = w;
  }
  return out;
}
