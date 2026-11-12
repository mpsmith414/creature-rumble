import { describe, expect, it } from 'vitest';
import { buildBody } from '../../src/builder/build';
import { cavityField } from '../../src/builder/cavity';
import { buildSkeleton } from '../../src/builder/skeleton';
import { CAST } from '../fixtures/cast';

const deer = CAST.find((c) => c.recipe.id === 'deer')!.recipe;

describe('cavity', () => {
  it('is 1 on an open sphere and darker inside a crease', () => {
    const sk = buildSkeleton(deer);
    const sphere = (x: number, y: number, z: number) => Math.hypot(x, y, z) - 0.1;
    const P = new Float32Array([0, 0.1, 0]), N = new Float32Array([0, 1, 0]);
    expect(cavityField(P, N, new Uint16Array([0]), new Float32Array([0.5]), sk, sphere)[0]).toBeGreaterThan(0.97);
    // a point at the bottom of a groove between two spheres
    const two = (x: number, y: number, z: number) => Math.min(Math.hypot(x - 0.06, y, z) - 0.07, Math.hypot(x + 0.06, y, z) - 0.07);
    const Q = new Float32Array([0, Math.sqrt(0.07 ** 2 - 0.06 ** 2), 0]);
    expect(cavityField(Q, N, new Uint16Array([0]), new Float32Array([0.5]), sk, two)[0]).toBeLessThan(0.85);
  });
  const body = buildBody(deer, [0, 1, 2]);
  it('stays in [0.25, 1] and darkens where legs meet the body', () => {
    const lod = body.lods[0], n = lod.positions.length / 3, bones = body.skeleton.bones;
    let back = 0, backN = 0, pit = 0, pitN = 0;
    for (let v = 0; v < n; v++) {
      const c = lod.groom[v * 4 + 3];
      expect(c).toBeGreaterThanOrEqual(0.25);
      expect(c).toBeLessThanOrEqual(1);
      const b = bones[lod.boneOf[v]], ny = lod.normals[v * 3 + 1];
      if (b.role === 'torso' && ny > 0.8) { back += c; backN++; }
      // armpit/groin: the upper leg's inner side, facing the belly or the other leg (the leg's start is buried in the torso, so
      // partT < 0.2 is mostly torso skin; the crease is further down, where the leg leaves the body)
      if (b.role === 'leg' && bones[b.parent]?.role === 'torso' && lod.partT[v] < 0.6 && lod.normals[v * 3] * Math.sign(b.start.x) < -0.4) { pit += c; pitN++; }
    }
    expect(back / backN).toBeGreaterThan(0.9);
    expect(back / backN - pit / pitN).toBeGreaterThan(0.15);
  });
  it('coarser LODs inherit the finest LOD values', () => {
    const fine = body.lods[0], coarse = body.lods[2];
    const vals = new Set(Array.from({ length: fine.positions.length / 3 }, (_, v) => fine.groom[v * 4 + 3]));
    let found = 0;
    for (let v = 0; v < coarse.positions.length / 3; v++) if (vals.has(coarse.groom[v * 4 + 3])) found++;
    expect(found / (coarse.positions.length / 3)).toBeGreaterThan(0.99);
  });
});
