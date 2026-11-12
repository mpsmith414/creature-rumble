import { describe, expect, it } from 'vitest';
import { createSimplifier } from '../../src/builder/simplify';
import { sampleSparse } from '../../src/builder/sparse';
import { surfaceNetsSparse } from '../../src/builder/mesher';
import { v3 } from '../../src/util/vec';
import { minValence } from '../fixtures/mesh';

const sphere = (x: number, y: number, z: number) => Math.hypot(x, y, z) - 0.8;
const mesh = () => surfaceNetsSparse(sampleSparse(sphere, v3(-1, -1, -1), v3(1, 1, 1), 0.02));
const closed = (idx: Uint32Array) => {
  const c = new Map<string, number>();
  for (let t = 0; t < idx.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = idx[t + e], b = idx[t + ((e + 1) % 3)];
    const k = a < b ? `${a},${b}` : `${b},${a}`;
    c.set(k, (c.get(k) ?? 0) + 1);
  }
  return [...c.values()].every((n) => n === 2);
};

describe('simplify', () => {
  it('reaches its budget, stays closed and stays on the sphere', () => {
    const m = mesh();
    const s = createSimplifier({ ...m, weight: new Float32Array(m.positions.length / 3).fill(1) });
    s.collapseTo(2000);
    const out = s.snapshot();
    expect(out.indices.length / 3).toBeLessThanOrEqual(2000);
    expect(out.indices.length / 3).toBeGreaterThan(1800);
    expect(closed(out.indices)).toBe(true);
    expect(minValence(out)).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < out.positions.length; i += 3)
      expect(Math.abs(Math.hypot(out.positions[i], out.positions[i + 1], out.positions[i + 2]) - 0.8)).toBeLessThan(0.02);
  });
  it('keeps more vertices where the weight is high', () => {
    const m = mesh();
    const n = m.positions.length / 3;
    const weight = new Float32Array(n).map((_, v) => (m.positions[v * 3 + 2] > 0.4 ? 8 : 1)); // the "face" cap at +z
    const s = createSimplifier({ ...m, weight });
    s.collapseTo(1500);
    const out = s.snapshot();
    let cap = 0;
    for (let i = 2; i < out.positions.length; i += 3) if (out.positions[i] > 0.4) cap++;
    const capArea = 2 * Math.PI * 0.8 * (0.8 - 0.4) / (4 * Math.PI * 0.8 * 0.8); // the cap's share of the sphere
    expect(cap / (out.positions.length / 3)).toBeGreaterThan(2 * capArea);
  });
  it('is deterministic and supports successive snapshots', () => {
    const run = () => {
      const m = mesh();
      const s = createSimplifier({ ...m, weight: new Float32Array(m.positions.length / 3).fill(1) });
      s.collapseTo(4000); const a = s.snapshot();
      s.collapseTo(1000); const b = s.snapshot();
      return [a, b];
    };
    const [a1, b1] = run(), [a2, b2] = run();
    expect(a1.positions).toEqual(a2.positions);
    expect(b1.indices).toEqual(b2.indices);
    expect(b1.indices.length).toBeLessThan(a1.indices.length);
  });
  it('keeps a straight, constant-radius part free of long sliver fans', () => {
    // a leg-like capsule, radius 4 cm and 68 cm long: its quadric costs nothing along the axis
    const capsule = (x: number, y: number, z: number) => Math.hypot(x, y, z - Math.max(-0.3, Math.min(0.3, z))) - 0.04;
    const m = surfaceNetsSparse(sampleSparse(capsule, v3(-0.07, -0.07, -0.37), v3(0.07, 0.07, 0.37), 0.004));
    const s = createSimplifier({ ...m, weight: new Float32Array(m.positions.length / 3).fill(1) });
    const edges = (o: { positions: Float32Array; indices: Uint32Array }) => {
      const P = o.positions, I = o.indices, valence = new Int32Array(P.length / 3);
      let max = 0, sum = 0;
      for (let i = 0; i < I.length; i++) {
        const a = I[i], b = I[i - (i % 3) + ((i + 1) % 3)];
        const l = Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
        max = Math.max(max, l); sum += l; valence[a]++;
      }
      return { max, mean: sum / I.length, valence: Math.max(...valence) };
    };
    s.collapseTo(8000);
    const lod0 = edges(s.snapshot());
    expect(lod0.valence).toBeLessThanOrEqual(12);
    expect(lod0.max).toBeLessThan(4 * lod0.mean);
    s.collapseTo(2000);
    const lod2 = edges(s.snapshot());
    expect(lod2.max).toBeLessThan(0.1); // before the regulariser, edges spanned the whole 0.6 m axis
  });
  it('collapses a torus as far as it goes and keeps it a closed torus', () => {
    const torus = (x: number, y: number, z: number) => Math.hypot(Math.hypot(x, z) - 0.5, y) - 0.15;
    const m = surfaceNetsSparse(sampleSparse(torus, v3(-1, -1, -1), v3(1, 1, 1), 0.03));
    const s = createSimplifier({ ...m, weight: new Float32Array(m.positions.length / 3).fill(1) });
    s.collapseTo(0);
    const out = s.snapshot();
    expect(closed(out.indices)).toBe(true);
    const faces = new Set<string>(), edgeSet = new Set<string>();
    for (let t = 0; t < out.indices.length; t += 3) {
      const f = [out.indices[t], out.indices[t + 1], out.indices[t + 2]];
      faces.add([...f].sort((a, b) => a - b).join());
      for (let e = 0; e < 3; e++) edgeSet.add([f[e], f[(e + 1) % 3]].sort((a, b) => a - b).join());
    }
    const F = out.indices.length / 3;
    expect(faces.size).toBe(F); // no duplicate faces
    expect(out.positions.length / 3 - edgeSet.size + F).toBe(0); // Euler characteristic of a torus
  });
  it('leaves a non-manifold edge alone and keeps every other edge closed', () => {
    // two spheres glued along one edge: that edge has four faces
    const m = mesh();
    const n = m.positions.length / 3, t = m.indices.length;
    const u = m.indices[0], v = m.indices[1];
    const positions = new Float32Array(n * 6), indices = new Uint32Array(t * 2);
    positions.set(m.positions);
    for (let i = 0; i < n * 3; i++) positions[n * 3 + i] = m.positions[i] + (i % 3 === 0 ? 2 : 0);
    indices.set(m.indices);
    for (let i = 0; i < t; i++) {
      const x = m.indices[i];
      indices[t + i] = x === u ? u : x === v ? v : x + n;
    }
    const s = createSimplifier({ positions, indices, weight: new Float32Array(n * 2).fill(1) });
    s.collapseTo(1000);
    const out = s.snapshot();
    expect(out.indices.length / 3).toBeLessThan(6000);
    const c = new Map<string, number>();
    for (let i = 0; i < out.indices.length; i += 3) for (let e = 0; e < 3; e++) {
      const a = out.source[out.indices[i + e]], b = out.source[out.indices[i + ((e + 1) % 3)]];
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      c.set(k, (c.get(k) ?? 0) + 1);
    }
    expect(c.get(u < v ? `${u},${v}` : `${v},${u}`)).toBe(4);
    expect([...c.values()].filter((k) => k !== 2)).toEqual([4]);
  });
});
