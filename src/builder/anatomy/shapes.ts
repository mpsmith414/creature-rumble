import { cross, dot, norm, scale, sub, v3, type Vec3 } from '../../util/vec';
import { roundCone, smin } from '../sdf';
import type { BoneDef } from '../skeleton';

/** Colour marks a feature can leave on the skin (Task 9 paints them). */
export type Mark = 'nose' | 'earInner' | 'mouth' | 'hoof';

export type Shape =
  | { type: 'ellipsoid'; c: Vec3; ax: [Vec3, Vec3, Vec3] /* orthonormal */; r: Vec3 /* radius along each axis */ }
  | { type: 'cone'; a: Vec3; b: Vec3; r0: number; r1: number } // round cone, as the bones
  // an ellipse in the plane of ax[0], ax[1] (radii r.x, r.y) extruded ±r.z along ax[2]: a slit of even thickness
  | { type: 'slab'; c: Vec3; ax: [Vec3, Vec3, Vec3] /* orthonormal */; r: Vec3 };

/** An extra shape blended into the body (add), cut out of it (carve), or only colouring it (mark). */
export type Feature = {
  op: 'add' | 'carve' | 'mark';
  shape: Shape;
  k: number; // blend radius (smooth union / smooth subtraction)
  mark?: Mark; markBand?: number; // vertices within markBand of the shape's surface get the mark
  facing?: Vec3; // earInner only: the ear's front axis (marks only front-facing vertices)
  cuts?: { p: Vec3; n: Vec3 }[]; // mark only: the shape ∩ these half-spaces (each the side of the plane through p that n points to)
  min: Vec3; max: Vec3; // reach box: shape bounds + max(k, markBand); bodySdf widens it by its margin
  name?: string; bone?: number; // which rule made it and from which bone (tests, debugging)
};

/** Signed distance to a shape: ellipsoid (and a slab's ellipse) by Inigo Quilez's bound k0·(k0 − 1)/k1, cone exactly. */
export function shapeSdf(p: Vec3, s: Shape): number {
  if (s.type === 'cone') return roundCone(p, s.a, s.b, s.r0, s.r1);
  const d = sub(p, s.c);
  const q0 = dot(d, s.ax[0]), q1 = dot(d, s.ax[1]), q2 = dot(d, s.ax[2]);
  if (s.type === 'slab') return Math.max(ellipseAt(q0, q1, s.r.x, s.r.y), Math.abs(q2) - s.r.z);
  return ellipsoidAt(q0, q1, q2, s.r.x, s.r.y, s.r.z);
}

/** The ellipse bound for in-plane coordinates (q0, q1) and radii (a, b). */
export function ellipseAt(q0: number, q1: number, a: number, b: number): number {
  const k0 = Math.hypot(q0 / a, q1 / b), k1 = Math.hypot(q0 / (a * a), q1 / (b * b));
  return k1 > 1e-12 ? (k0 * (k0 - 1)) / k1 : -Math.min(a, b);
}

/** The ellipsoid bound for local coordinates (q0, q1, q2) and radii (a, b, c). */
export function ellipsoidAt(q0: number, q1: number, q2: number, a: number, b: number, c: number): number {
  const k0 = Math.hypot(q0 / a, q1 / b, q2 / c);
  const k1 = Math.hypot(q0 / (a * a), q1 / (b * b), q2 / (c * c));
  return k1 > 1e-12 ? (k0 * (k0 - 1)) / k1 : -Math.min(a, b, c);
}

/** The shape's axis-aligned bounds. */
function bounds(s: Shape): { min: Vec3; max: Vec3 } {
  if (s.type === 'cone') {
    const r = Math.max(s.r0, s.r1);
    return {
      min: v3(Math.min(s.a.x, s.b.x) - r, Math.min(s.a.y, s.b.y) - r, Math.min(s.a.z, s.b.z) - r),
      max: v3(Math.max(s.a.x, s.b.x) + r, Math.max(s.a.y, s.b.y) + r, Math.max(s.a.z, s.b.z) + r),
    };
  }
  const [u, v, w] = s.ax, { x: a, y: b, z: c } = s.r;
  // half-extent along a world axis: |(a·u_i, b·v_i, c·w_i)| (a slab: the ellipse's, plus its thickness)
  const e = s.type === 'slab'
    ? v3(Math.hypot(a * u.x, b * v.x) + c * Math.abs(w.x), Math.hypot(a * u.y, b * v.y) + c * Math.abs(w.y), Math.hypot(a * u.z, b * v.z) + c * Math.abs(w.z))
    : v3(Math.hypot(a * u.x, b * v.x, c * w.x), Math.hypot(a * u.y, b * v.y, c * w.y), Math.hypot(a * u.z, b * v.z, c * w.z));
  return { min: sub(s.c, e), max: v3(s.c.x + e.x, s.c.y + e.y, s.c.z + e.z) };
}

/** A feature with its reach box (shape bounds grown by its blend radius or mark band). */
export function feature(op: Feature['op'], shape: Shape, k: number, extra: Partial<Pick<Feature, 'mark' | 'markBand' | 'facing' | 'cuts' | 'name' | 'bone'>> = {}): Feature {
  const { min, max } = bounds(shape);
  const g = Math.max(k, extra.markBand ?? 0);
  return { op, shape, k, ...extra, min: v3(min.x - g, min.y - g, min.z - g), max: v3(max.x + g, max.y + g, max.z + g) };
}

/** The four mark channels, in the order the `feature` vertex attribute holds them. */
export const MARKS: readonly Mark[] = ['nose', 'earInner', 'mouth', 'hoof'];

const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

/**
 * How strongly each mark colours the skin at `p` (normal `n`): writes the per-channel max into out[o … o+3] (MARKS
 * order). A mark-only shape marks its whole inside and fades over markBand outside; an add or carve shape marks its
 * surface, fading over markBand either side. Cuts trim a mark-only shape's mark to the side of each plane (other ops
 * ignore them); earInner marks only skin facing the ear's front.
 */
export function marksAt(features: Feature[], p: Vec3, n: Vec3, out: Float32Array, o: number): void {
  out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
  for (const f of features) {
    if (!f.mark || p.x < f.min.x || p.y < f.min.y || p.z < f.min.z || p.x > f.max.x || p.y > f.max.y || p.z > f.max.z) continue;
    let d = shapeSdf(p, f.shape);
    const band = f.markBand ?? 0;
    if (f.op === 'mark') for (const c of f.cuts ?? []) d = Math.max(d, (c.p.x - p.x) * c.n.x + (c.p.y - p.y) * c.n.y + (c.p.z - p.z) * c.n.z);
    let w = 1 - smoothstep(0, band, f.op === 'mark' ? Math.max(d, 0) : Math.abs(d));
    if (f.facing && f.mark === 'earInner') w *= smoothstep(0, 0.3, dot(n, f.facing));
    const c = o + MARKS.indexOf(f.mark);
    if (w > out[c]) out[c] = w;
  }
}

/** The largest radius of a shape (for skipping features too small to mesh). */
export const shapeSize = (s: Shape) => (s.type === 'cone' ? Math.max(s.r0, s.r1) : Math.max(s.r.x, s.r.y, s.r.z));

/** An orthonormal frame: `a` along, `up`, side = up × a. */
export type Frame = { a: Vec3; up: Vec3; side: Vec3 };

const WORLD_UP = v3(0, 1, 0), BACKWARD = v3(0, 0, -1);

/**
 * A bone's frame: `a` along it, `up` = world up made perpendicular, side = up × a. Up is the dorsal side: the top of a
 * level bone, backwards for one that leans forward from upright. A torso, neck or head leaning backward from upright
 * (closer to vertical than level: a.y > |a.z|) would get world up on its belly side, so its up is turned to the back.
 * An exactly vertical bone takes −z (dorsal for an upright body).
 */
export function boneFrame(b: BoneDef): Frame {
  const a = norm(sub(b.end, b.start));
  const t = sub(WORLD_UP, scale(a, dot(WORLD_UP, a)));
  let up = Math.hypot(t.x, t.y, t.z) > 1e-6 ? norm(t) : BACKWARD;
  if ((b.role === 'torso' || b.role === 'neck' || b.role === 'head') && a.z < 0 && a.y > -a.z) up = scale(up, -1);
  return { a, up, side: norm(cross(up, a)) };
}

/** Polynomial smooth maximum: −smin(−a, −b, k). */
export const smax = (a: number, b: number, k: number): number => -smin(-a, -b, k);
