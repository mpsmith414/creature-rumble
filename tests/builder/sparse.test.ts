import { describe, expect, it } from 'vitest';
import { sampleSparse } from '../../src/builder/sparse';
import { surfaceNets, surfaceNetsSparse } from '../../src/builder/mesher';
import { bodySdf, coarseBodySdf } from '../../src/builder/sdf';
import { buildSkeleton } from '../../src/builder/skeleton';
import { CAST } from '../fixtures/cast';
import { v3 } from '../../src/util/vec';
import { hexapod, snake } from '../fixtures/recipes';

const sphere = (x: number, y: number, z: number) => Math.hypot(x, y, z) - 0.8;
// radii chosen off the lattice: at 0.2 / 0.3 the surface passes exactly through grid points, where
// the sign of a ~0 sample depends on float noise from the two grids' slightly different origins
const capsules = (x: number, y: number, z: number) =>
  Math.min(Math.hypot(x, y - Math.max(-0.5, Math.min(0.5, y)), z) - 0.2013, Math.hypot(x - 0.4, y, z) - 0.3011);

describe('sparse sampling', () => {
  it('meshes the same surface as a dense grid', () => {
    for (const f of [sphere, capsules]) {
      const dense = surfaceNets(f, v3(-1, -1, -1), v3(1, 1, 1), 0.02);
      const sparse = surfaceNetsSparse(sampleSparse(f, v3(-1, -1, -1), v3(1, 1, 1), 0.02));
      expect(sparse.positions.length).toBe(dense.positions.length);
      expect(sparse.indices.length).toBe(dense.indices.length);
    }
  });
  it('evaluates far fewer samples than a dense grid', () => {
    const s = sampleSparse(sphere, v3(-1, -1, -1), v3(1, 1, 1), 0.01);
    expect(s.evaluations).toBeLessThan(0.25 * 200 ** 3);
  });
  it('is closed: every edge has two triangles', () => {
    const m = surfaceNetsSparse(sampleSparse(capsules, v3(-1, -1, -1), v3(1, 1, 1), 0.02));
    const count = new Map<string, number>();
    for (let t = 0; t < m.indices.length; t += 3)
      for (let e = 0; e < 3; e++) {
        const a = m.indices[t + e], b = m.indices[t + ((e + 1) % 3)];
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        count.set(k, (count.get(k) ?? 0) + 1);
      }
    expect([...count.values()].every((c) => c === 2)).toBe(true);
  });

  it('keeps thin parts of a real body that the bone-box cull would hide from a coarse lattice', () => {
    const recipes = [CAST[0].recipe, hexapod, snake];
    for (const recipe of recipes) {
      const sk = buildSkeleton(recipe);
      const { min, max } = sk;
      const cell = Math.max(max.x - min.x, max.y - min.y, max.z - min.z) / 28;
      const sdf = bodySdf(sk);
      const coarse = coarseBodySdf(sk, undefined, cell);
      const sparse = surfaceNetsSparse(sampleSparse(sdf, min, max, cell, 4, coarse));
      // dense grid on the sparse field's lattice: its origin is min - 2 coarse cells
      const lo = v3(min.x - 6 * cell, min.y - 6 * cell, min.z - 6 * cell);
      const dense = surfaceNets(sdf, lo, v3(max.x + 6 * cell, max.y + 6 * cell, max.z + 6 * cell), cell);
      expect(sparse.positions.length).toBe(dense.positions.length);
      expect(sparse.indices.length).toBe(dense.indices.length);
      const key = (p: Float32Array) => {
        const out: string[] = [];
        for (let i = 0; i < p.length; i += 3) out.push(`${p[i].toFixed(4)},${p[i + 1].toFixed(4)},${p[i + 2].toFixed(4)}`);
        return out.sort();
      };
      expect(key(sparse.positions)).toEqual(key(dense.positions));
    }
  });
});
