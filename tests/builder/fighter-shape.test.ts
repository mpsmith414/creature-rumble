import { describe, expect, test } from 'vitest';
import { anatomy } from '../../src/builder/anatomy';
import { FINE_CELLS } from '../../src/builder/build';
import { bodySdf, boneSdf } from '../../src/builder/sdf';
import { buildSkeleton } from '../../src/builder/skeleton';
import { KINDS, loadFixture } from '../fixtures/fighters';

/** The body's full shape (bones and anatomy, at the builder's fine detail) as a distance function. */
function shapeOf(k: string) {
  const r = loadFixture(k), sk = buildSkeleton(r);
  const longest = Math.max(sk.max.x - sk.min.x, sk.max.y - sk.min.y, sk.max.z - sk.min.z);
  const anat = anatomy(sk, r, { cell: longest / FINE_CELLS });
  return { sk, anat, sdf: bodySdf(sk, anat) };
}

/** How far forward (+z) the body's surface reaches on its centre line at height y. */
function front(sdf: (x: number, y: number, z: number) => number, y: number): number {
  let z = 3;
  while (z > -3 && sdf(0, y, z) > 0) z -= 0.01;
  let lo = z, hi = z + 0.01;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (sdf(0, y, m) > 0) hi = m; else lo = m;
  }
  return lo;
}

describe("a fighter fixture's belly", () => {
  test.each(KINDS)('%s has no crease across the front of its torso', (k) => {
    const { sk, sdf } = shapeOf(k);
    const t = sk.bones[0], R = Math.max(t.r0, t.r1), h = 0.06 * R;
    const heads = sk.bones.filter((b) => b.role === 'head' || b.role === 'neck');
    // the chin is a fold by design: only the front well clear of the head counts
    const nearHead = (y: number) => heads.some((b) => boneSdf({ x: 0, y, z: front(sdf, y) }, b) < 0.5 * Math.max(b.r0, b.r1));
    let sharpest = -Infinity;
    for (let y = Math.min(t.start.y, t.end.y); y <= Math.max(t.start.y, t.end.y); y += 0.01 * R) {
      if (nearHead(y)) continue;
      // the centre line's curvature up the front (positive where it is hollow): a crease is a sharp hollow
      const k2 = (front(sdf, y - h) + front(sdf, y + h) - 2 * front(sdf, y)) / (h * h);
      sharpest = Math.max(sharpest, k2 * R);
    }
    expect(sharpest).toBeLessThan(3); // no hollow tighter than a third of the torso's radius (the old slot: 13 on the blob)
  });

  test.each(KINDS)('%s: the belly tuck is no thin slot (at least half the torso radius along it)', (k) => {
    const { sk, anat } = shapeOf(k);
    const tuck = anat.features.find((f) => f.name === 'belly');
    if (!tuck) return;
    if (tuck.shape.type !== 'ellipsoid') throw new Error('an ellipsoid');
    const t = sk.bones[tuck.bone!];
    expect(tuck.shape.r.x).toBeGreaterThanOrEqual(0.5 * Math.max(t.r0, t.r1) - 1e-9);
  });
});
