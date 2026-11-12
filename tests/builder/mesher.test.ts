import { describe, expect, it } from 'vitest';
import { splitNonManifold, surfaceNets, surfaceNetsSparse } from '../../src/builder/mesher';
import { sampleSparse } from '../../src/builder/sparse';
import { topology } from '../fixtures/mesh';
import { buildSkeleton } from '../../src/builder/skeleton';
import { bodySdf, blendFor, boneSdf, coarseBodySdf, roundCone, smin, thinAxis } from '../../src/builder/sdf';
import { v3 } from '../../src/util/vec';
import { CAST } from '../fixtures/cast';
import { quadruped } from '../fixtures/recipes';

describe('distance functions', () => {
  it('round cone is negative inside, ~0 on the surface, positive outside', () => {
    const a = v3(0, 0, 0), b = v3(0, 0, 1);
    expect(roundCone(v3(0, 0, 0.5), a, b, 0.2, 0.1)).toBeLessThan(0);
    expect(Math.abs(roundCone(v3(0.2, 0, 0), a, b, 0.2, 0.1))).toBeLessThan(1e-4);
    expect(Math.abs(roundCone(v3(0, 0, 1.1), a, b, 0.2, 0.1))).toBeLessThan(1e-4);
    expect(roundCone(v3(1, 0, 0.5), a, b, 0.2, 0.1)).toBeGreaterThan(0);
  });

  it('squash makes a part flat along its facing', () => {
    const ear = {
      ...buildSkeleton(quadruped).bones[0],
      start: v3(0, 0, 0), end: v3(0, 1, 0), r0: 0.1, r1: 0.1, squash: 0.2, flatFacing: 'forward' as const, pointed: false,
    };
    expect(boneSdf(v3(0, 0.5, 0.015), ear)).toBeLessThan(0); // inside, the thin way
    expect(boneSdf(v3(0, 0.5, 0.05), ear)).toBeGreaterThan(0); // 0.1 × 0.2 = 0.02 thick
    expect(boneSdf(v3(0.09, 0.5, 0), ear)).toBeLessThan(0); // still wide sideways
  });

  it('smin is min at k = 0 and never above min', () => {
    expect(smin(0.3, 0.5, 0)).toBe(0.3);
    expect(smin(0.3, 0.32, 0.1)).toBeLessThan(0.3);
  });

  it('the body is solid inside the torso and empty above it', () => {
    const sk = buildSkeleton(quadruped);
    const f = bodySdf(sk);
    const t = sk.bones[0];
    expect(f((t.start.x + t.end.x) / 2, (t.start.y + t.end.y) / 2, (t.start.z + t.end.z) / 2)).toBeLessThan(0);
    expect(f(0, t.start.y + 1, (t.start.z + t.end.z) / 2)).toBeGreaterThan(0);
  });

  it('the body skips only bones that cannot change the blend', () => {
    // reference: every bone in tree order, culled by its box only (the original fold)
    for (const recipe of [quadruped, CAST[7].recipe]) {
      const sk = buildSkeleton(recipe);
      const bones = sk.bones.filter((b) => b.role !== 'eye').map((b) => {
        const par = b.parent >= 0 ? sk.bones[b.parent] : null;
        const k = par ? blendFor(b.role) * Math.min(b.r0, Math.max(par.r0, par.r1)) : 0;
        const r = Math.max(b.r0, b.r1) * 1.5 + k + 0.03;
        const lo = v3(Math.min(b.start.x, b.end.x) - r, Math.min(b.start.y, b.end.y) - r, Math.min(b.start.z, b.end.z) - r);
        const hi = v3(Math.max(b.start.x, b.end.x) + r, Math.max(b.start.y, b.end.y) + r, Math.max(b.start.z, b.end.z) + r);
        return { b, k, lo, hi, thin: thinAxis(b) };
      });
      const ref = (x: number, y: number, z: number) => {
        let d = 1e3;
        for (const it of bones) {
          const out = x < it.lo.x || y < it.lo.y || z < it.lo.z || x > it.hi.x || y > it.hi.y || z > it.hi.z;
          if (out && d < 1e3) continue;
          const e = boneSdf(v3(x, y, z), it.b, it.thin);
          d = d >= 1e3 ? e : smin(d, e, it.k);
        }
        return d;
      };
      const sdf = bodySdf(sk);
      const { min, max } = sk;
      for (let i = 0; i < 20_000; i++) {
        const f = (j: number) => ((i * 7919 + j * 104729) % 1000) / 1000;
        const x = min.x + (max.x - min.x) * f(1), y = min.y + (max.y - min.y) * f(2), z = min.z + (max.z - min.z) * f(3);
        expect(sdf(x, y, z)).toBe(ref(x, y, z));
      }
    }
  });
});

describe('splitNonManifold', () => {
  it('separates two closed surfaces that share an edge', () => {
    // two tetrahedra sharing the edge 0-1: four triangles on that edge
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0.5, 1, 0, 0.5, 0.5, 1, 0.5, -1, 0, 0.5, -0.5, -1]);
    const tet = (a: number, b: number, c: number, d: number) => [a, c, b, a, b, d, b, c, d, a, d, c]; // wound outward
    const m = splitNonManifold({ positions, indices: new Uint32Array([...tet(0, 1, 2, 3), ...tet(0, 1, 4, 5)]) });
    expect(m.positions.length / 3).toBe(7); // splitting vertex 0 already gives each edge two triangles
    expect([...topology({ ...m, normals: new Float32Array() }).edges.values()].every((c) => c === 2)).toBe(true);
  });

  it('leaves no crowded edge on a thin-finned body', () => {
    const sk = buildSkeleton(CAST.find((c) => c.recipe.id === 'trout')!.recipe); // fins one cell thick: dozens of crowded edges
    const cell = Math.max(sk.max.x - sk.min.x, sk.max.y - sk.min.y, sk.max.z - sk.min.z) / 330;
    const raw = surfaceNetsSparse(sampleSparse(bodySdf(sk), sk.min, sk.max, cell, 4, coarseBodySdf(sk, undefined, cell)));
    const crowded = (m: typeof raw) => [...topology({ ...m, normals: new Float32Array() }).edges.values()].filter((c) => c !== 2).length;
    expect(crowded(raw)).toBeGreaterThan(0);
    expect(crowded(splitNonManifold(raw))).toBe(0);
  });

  it('leaves a manifold mesh untouched', () => {
    const m = surfaceNets((x, y, z) => Math.hypot(x, y, z) - 0.8, v3(-1, -1, -1), v3(1, 1, 1), 0.1);
    const out = splitNonManifold(m);
    expect(out.positions).toBe(m.positions);
    expect(out.indices).toBe(m.indices);
  });
});

describe('surfaceNets', () => {
  const sphere = surfaceNets((x, y, z) => Math.hypot(x, y, z) - 1, v3(-1, -1, -1), v3(1, 1, 1), 0.1);

  it('makes a closed sphere of genus 0', () => {
    for (const p of sphere.positions) expect(Number.isFinite(p)).toBe(true);
    for (let i = 0; i < sphere.positions.length; i += 3)
      expect(Math.abs(Math.hypot(sphere.positions[i], sphere.positions[i + 1], sphere.positions[i + 2]) - 1)).toBeLessThan(0.05);
    const { edges, euler } = topology(sphere);
    for (const n of edges.values()) expect(n).toBe(2);
    expect(euler).toBe(2);
  });

  it('points normals and windings outward', () => {
    const p = sphere.positions, n = sphere.normals, ix = sphere.indices;
    for (let i = 0; i < p.length; i += 3) expect(p[i] * n[i] + p[i + 1] * n[i + 1] + p[i + 2] * n[i + 2]).toBeGreaterThan(0);
    let outward = 0;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
      const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
      const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
      const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      if (fn[0] * p[a] + fn[1] * p[a + 1] + fn[2] * p[a + 2] > 0) outward++;
    }
    expect(outward).toBe(ix.length / 3);
  });
});
