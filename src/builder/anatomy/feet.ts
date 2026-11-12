import type { Build } from '../../recipe/schema';
import { add, lerp, scale, sub, type Vec3 } from '../../util/vec';
import type { BoneDef, Skeleton } from '../skeleton';
import { boneFrame, feature, shapeSize, type Feature, type Frame } from './shapes';
import type { Detail } from '.';

const DEG = Math.PI / 180;
const R = (b: BoneDef) => Math.max(b.r0, b.r1);

/** A unit direction in a foot's frame: `a` turned about `up` by `yaw` (towards +side when positive), then tilted down by `tilt`. */
function toeDir(f: Frame, yaw: number, tilt: number, back = false): Vec3 {
  const along = scale(f.a, Math.cos(yaw) * (back ? -1 : 1)), flat = add(along, scale(f.side, Math.sin(yaw)));
  return add(scale(flat, Math.cos(tilt)), scale(f.up, -Math.sin(tilt)));
}

/** The extra shapes that give each foot bone its toes, hoof split or web, by the recipe's `build.feet`. */
export function footFeatures(sk: Skeleton, build: Build, detail: Detail): Feature[] {
  const out: Feature[] = [];
  if (build.feet === 'plain') return out;
  // pads and webs need about two cells of radius like any feature; a toe is a thin tube, meshable from one cell of radius
  const push = (f: Feature, cells = 2) => { if (shapeSize(f.shape) >= cells * detail.cell) out.push(f); };
  sk.bones.forEach((b, i) => {
    if (b.role !== 'foot') return;
    const f = boneFrame(b), rf = R(b), L = Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y, b.end.z - b.start.z);
    const { a, up, side } = f, end = b.end;
    const at = (along: number, s: number, u: number) => add(add(add(end, scale(a, along * rf)), scale(side, s * rf)), scale(up, u * rf));
    const cone = (p: Vec3, q: Vec3, r0: number, r1: number) => ({ type: 'cone' as const, a: p, b: q, r0, r1 });
    if (build.feet === 'paws') {
      for (const s of [-0.6, -0.2, 0.2, 0.6])
        push(feature('add', { type: 'ellipsoid', c: at(-0.25, s, -0.3), ax: [a, side, up], r: { x: 0.45 * rf, y: 0.3 * rf, z: 0.32 * rf } }, 0.12 * rf, { name: 'pad', bone: i }));
      if (0.06 * rf >= detail.cell) {
        const r = Math.max(0.06 * rf, detail.cell);
        for (const s of [-0.4, 0, 0.4]) out.push(feature('carve', cone(at(-0.6, s, -0.1), at(0.2, s, -0.1), r, r), 0.05 * rf, { name: 'groove', bone: i }));
      }
    } else if (build.feet === 'hooves') {
      if (0.08 * rf >= detail.cell) {
        const r = Math.max(0.08 * rf, detail.cell), down = scale(up, 0.2 * rf);
        out.push(feature('carve', cone(sub(lerp(b.start, end, 0.55), down), sub(add(end, scale(a, 0.1 * rf)), down), r, r), 0.04 * rf, { name: 'split', bone: i }));
      }
      out.push(feature('mark', cone(b.start, end, b.r0 + 0.1 * rf, b.r1 + 0.1 * rf), 0, { mark: 'hoof', markBand: 0.3 * rf, name: 'hoof', bone: i }));
    } else {
      const T = Math.max(L, 2.5 * rf), talons = build.feet === 'talons';
      // a toe's tip never goes under 0.75 of a cell: thinner, the mesh breaks it into loose shards
      const [r0, r1] = (talons ? [0.38 * rf, 0.07 * rf] : [0.3 * rf, 0.2 * rf]).map((r) => Math.max(r, 0.75 * detail.cell));
      const toe = (d: Vec3, len: number) => push(feature('add', cone(end, add(end, scale(d, len)), r0, r1), talons ? 0.15 * rf : 0.1 * rf, { name: 'toe', bone: i }), 1);
      for (const deg of [-28, 0, 28]) toe(toeDir(f, deg * DEG, 10 * DEG), T);
      if (talons) toe(toeDir(f, 0, 15 * DEG, true), 0.6 * T);
      else push(feature('add', { type: 'ellipsoid', c: at(0.5 * T / rf, 0, -0.1), ax: [a, side, up], r: { x: 0.5 * T, y: 0.75 * T, z: Math.max(0.06 * rf, 1.5 * detail.cell) } }, 0.1 * rf, { name: 'web', bone: i }));
    }
  });
  return out;
}
