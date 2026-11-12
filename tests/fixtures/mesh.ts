import { sampleBody } from '../../src/builder/build';
import { splitNonManifold, surfaceNetsSparse, type MeshData } from '../../src/builder/mesher';
import { buildSkeleton } from '../../src/builder/skeleton';
import type { Recipe } from '../../src/recipe/schema';

/** Edges not used by exactly two triangles (0 for a closed, manifold mesh). */
export function badEdges(m: { positions: Float32Array; indices: Uint32Array }): number {
  const edges = new Map<number, number>(), n = m.positions.length / 3;
  for (let t = 0; t < m.indices.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const p = m.indices[t + e], q = m.indices[t + ((e + 1) % 3)], key = Math.min(p, q) * n + Math.max(p, q);
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  return [...edges.values()].filter((c) => c !== 2).length;
}

/** A body's raw mesh at the production cell, as buildBody meshes it before simplifying (non-manifold vertices split). */
export const productionMesh = (recipe: Recipe) => splitNonManifold(surfaceNetsSparse(sampleBody(buildSkeleton(recipe), recipe).field));

/** Edge use counts and the Euler characteristic of a triangle mesh. */
export function topology(m: MeshData) {
  const edges = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = m.indices[t + e], b = m.indices[t + ((e + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  return { edges, euler: m.positions.length / 3 - edges.size + m.indices.length / 3 };
}

/** Fewest triangles around any vertex (a closed surface needs at least three; two is a back-to-back flap). */
export function minValence(m: { positions: Float32Array; indices: Uint32Array }): number {
  const v = new Int32Array(m.positions.length / 3);
  for (const i of m.indices) v[i]++;
  return v.reduce((a, b) => Math.min(a, b), Infinity);
}

/** True if every normal has unit length (a zero normal lights as NaN). */
export const unitNormals = (normals: Float32Array) => {
  for (let i = 0; i < normals.length; i += 3)
    if (!(Math.abs(Math.hypot(normals[i], normals[i + 1], normals[i + 2]) - 1) < 1e-3)) return false;
  return true;
};
