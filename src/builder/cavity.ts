import type { Sdf } from './mesher';
import type { Skeleton } from './skeleton';

export type { Sdf };

/** Step length for a vertex: 0.35 × its part radius (bone r0→r1 at partT), clamped to [1 mm, 3 cm]. */
export function cavityStep(sk: Skeleton, bone: number, partT: number): number {
  const b = sk.bones[bone], r = b.r0 + (b.r1 - b.r0) * partT;
  return Math.min(0.03, Math.max(0.001, 0.35 * r));
}

/**
 * How open the surface is at each vertex (1 open … 0.25 deep), from the SDF along the normal:
 * occ = Σ_{k=1..steps} 0.5^k · max(0, d_k − sdf(p + n·d_k)) / d_k, with d_k = k·h, normalised by Σ 0.5^k;
 * cavity = clamp(1 − 1.2·occ, 0.25, 1). 1 per vertex.
 * On an open surface the SDF at p + n·d is d, so nothing is occluded; in a crease the neighbouring part is closer than d.
 */
export function cavityField(positions: Float32Array, normals: Float32Array, boneOf: Uint16Array, partT: Float32Array,
  sk: Skeleton, sdf: Sdf, steps = 5): Float32Array {
  const n = positions.length / 3, out = new Float32Array(n);
  let norm = 0;
  for (let k = 1; k <= steps; k++) norm += 0.5 ** k;
  for (let v = 0; v < n; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    const nx = normals[v * 3], ny = normals[v * 3 + 1], nz = normals[v * 3 + 2];
    const h = cavityStep(sk, boneOf[v], partT[v]);
    let occ = 0;
    for (let k = 1; k <= steps; k++) {
      const d = k * h;
      occ += 0.5 ** k * Math.max(0, d - sdf(x + nx * d, y + ny * d, z + nz * d)) / d;
    }
    out[v] = Math.min(1, Math.max(0.25, 1 - 1.2 * (occ / norm)));
  }
  return out;
}
