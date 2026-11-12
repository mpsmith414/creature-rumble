import type { Build } from '../../recipe/schema';
import { add, dot, lerp, scale, sub, v3, type Vec3 } from '../../util/vec';
import type { BoneDef, Skeleton } from '../skeleton';
import { boneFrame, feature, shapeSdf, shapeSize, type Feature, type Frame, type Shape } from './shapes';
import type { Detail } from '.';

const R = (b: BoneDef) => Math.max(b.r0, b.r1);
const UP = v3(0, 1, 0), BACK = v3(0, 0, -1);
/** The belly tuck's least half-height along the torso (× the torso's radius). */
const BELLY_MIN_ALONG = 0.5;
/** +x for bones on the left, −x on the right, none on the centre line. */
const outward = (b: BoneDef): Vec3 => v3(b.start.x > 1e-6 ? 1 : b.start.x < -1e-6 ? -1 : 0, 0, 0);
const isLowerLeg = (sk: Skeleton, b: BoneDef) => b.role === 'leg' && b.parent >= 0 && sk.bones[b.parent].role === 'leg';
const isUpperLeg = (sk: Skeleton, b: BoneDef) => b.role === 'leg' && b.parent >= 0 && sk.bones[b.parent].role === 'torso';

/** Lower leg bones' radius scale (see slimLowerLegs). */
const slim = (sk: Skeleton, b: BoneDef, m: number) => (isLowerLeg(sk, b) ? 1 - 0.12 * m : 1);

/** An ellipsoid in a frame: radii along the bone, its side and its up. */
const ellipsoid = (c: Vec3, f: Frame, along: number, side: number, up: number): Shape =>
  ({ type: 'ellipsoid', c, ax: [f.a, f.side, f.up], r: v3(along, side, up) });

/**
 * A leg muscle ellipsoid: along the bone, its front/back radius on whichever across axis points more along z (a leg
 * that sprawls sideways has its frame up, not its side, pointing forward), its side radius on the other.
 */
const legEllipsoid = (c: Vec3, f: Frame, along: number, side: number, frontBack: number): Shape =>
  Math.abs(f.up.z) >= Math.abs(f.side.z) ? ellipsoid(c, f, along, side, frontBack) : ellipsoid(c, f, along, frontBack, side);

/** The extra shapes that give a body its muscles, joints, ribcage, belly and neck (see the rules in the plan). */
export function bodyFeatures(sk: Skeleton, build: Build, detail: Detail): Feature[] {
  const m = build.muscle, muscle = m >= 0.05;
  const out: Feature[] = [];
  const push = (f: Feature) => { if (shapeSize(f.shape) >= 2 * detail.cell) out.push(f); };
  const { bones } = sk;
  const torso = bones.flatMap((b, i) => (b.role === 'torso' ? [i] : []));
  const hasLegs = bones.some((b) => b.role === 'leg');
  const chains = bones.filter((b) => b.role === 'leg' && !(b.parent >= 0 && (bones[b.parent].role === 'leg' || bones[b.parent].role === 'foot'))).length;
  const midZ = torso.length ? torso.reduce((s, i) => s + (bones[i].start.z + bones[i].end.z) / 2, 0) / torso.length : 0;

  bones.forEach((b, i) => {
    const f = boneFrame(b), r = R(b), len = Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y, b.end.z - b.start.z);
    const o = outward(b);
    // 1. upper-leg muscle: haunch behind the torso's middle, shoulder in front
    if (muscle && isUpperLeg(sk, b)) {
      if (b.start.z < midZ) {
        const c = add(add(add(lerp(b.start, b.end, 0.25), scale(o, 0.2 * r)), scale(UP, 0.15 * r)), scale(BACK, 0.15 * r));
        push(feature('add', legEllipsoid(c, f, 0.42 * len, r * (0.85 + 0.35 * m), r * (1.0 + 0.4 * m)), 0.5 * r, { name: 'haunch', bone: i }));
      } else {
        const c = add(lerp(b.start, b.end, 0.18), scale(o, 0.15 * r));
        push(feature('add', legEllipsoid(c, f, 0.38 * len, r * (0.75 + 0.25 * m), r * (0.95 + 0.3 * m)), 0.45 * r, { name: 'shoulder', bone: i }));
      }
    }
    // 2. joint knob where a leg grows from a leg, sized from the slimmed radii (else it swells into a ball)
    if (isLowerLeg(sk, b)) {
      const rad = Math.max(bones[b.parent].r1 * slim(sk, bones[b.parent], m), b.r0 * slim(sk, b, m)) * (1.0 + 0.15 * m);
      push(feature('add', ellipsoid(b.start, f, rad, rad, rad), 0.3 * rad, { name: 'knob', bone: i }));
    }
    // 6. shoulder blades: four-legged bodies only, over each front upper leg
    if (muscle && chains === 4 && isUpperLeg(sk, b) && b.start.z >= midZ) {
      const t = bones[b.parent], tf = boneFrame(t), tr = R(t);
      const c = add(add(b.start, scale(tf.up, 0.9 * tr)), scale(o, 0.35 * tr));
      push(feature('add', ellipsoid(c, tf, 0.35 * tr * m, 0.15 * tr * m, 0.25 * tr * m), 0.3 * tr, { name: 'blade', bone: i }));
    }
    // 7. neck: a crest along the top, a throat underneath
    if (b.role === 'neck') {
      const u0 = scale(f.up, b.r0), u1 = scale(f.up, b.r1);
      if (muscle) push(feature('add', { type: 'cone', a: add(b.start, scale(u0, 0.55)), b: add(b.end, scale(u1, 0.55)), r0: 0.4 * b.r0 * m, r1: 0.4 * b.r1 * m }, 0.5 * r, { name: 'crest', bone: i }));
      push(feature('add', { type: 'cone', a: sub(b.start, scale(u0, 0.5)), b: sub(b.end, scale(u1, 0.5)), r0: 0.35 * b.r0, r1: 0.3 * b.r1 }, 0.5 * r, { name: 'throat', bone: i }));
    }
  });

  if (torso.length && hasLegs) {
    // 4. ribcage in the front torso bone
    const ti = torso.reduce((best, i) => (bones[i].end.z > bones[best].end.z ? i : best));
    const t = bones[ti], f = boneFrame(t), r = R(t), len = Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y, t.end.z - t.start.z);
    const c = add(lerp(t.start, t.end, 0.55), scale(f.up, 0.05 * r));
    push(feature('add', ellipsoid(c, f, 0.45 * len, r * (1.05 + 0.08 * m), r * (1.0 + 0.05 * m)), 0.4 * r, { name: 'ribcage', bone: ti }));
  }
  if (torso.length && chains >= 2) {
    // 5. belly tuck under the rear torso bone, in front of the hind legs
    const ti = torso.reduce((best, i) => (bones[i].start.z < bones[best].start.z ? i : best));
    const t = bones[ti], f = boneFrame(t), r = R(t), len = Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y, t.end.z - t.start.z);
    const c = sub(lerp(t.start, t.end, 0.7), scale(f.up, 1.25 * r));
    // at least half the torso's radius along it: on a squat torso (shorter than it is round, a blob's) 0.3 × its length
    // made a thin slot, which carved a sharp crease across the belly
    const along = Math.max(0.3 * len, BELLY_MIN_ALONG * r);
    const tuck = feature('carve', ellipsoid(c, f, along, 0.9 * r, 0.45 * r * (0.5 + m)), 0.35 * r, { name: 'belly', bone: ti });
    // never cut a limb: a leg rooted under the belly (a duck's) keeps the tuck off; legs at the torso's ends keep it
    const e = tuck.shape.type === 'ellipsoid' ? tuck.shape : null;
    const cuts = !!e && bones.some((b) => isUpperLeg(sk, b) && dot(sub(b.start, e.c), f.a) > -e.r.x && dot(sub(b.start, e.c), f.a) < e.r.x
      && [0, 1 / 6, 1 / 3].some((u) => shapeSdf(lerp(b.start, b.end, u), tuck.shape) < tuck.k + R(b)));
    if (!cuts) push(tuck);
  }
  return out;
}

/** Per-bone radius scale: lower leg bones (a leg grown from a leg) are slimmer on a muscular body. */
export function slimLowerLegs(sk: Skeleton, build: Build): Float32Array {
  return Float32Array.from(sk.bones, (b) => slim(sk, b, build.muscle));
}
