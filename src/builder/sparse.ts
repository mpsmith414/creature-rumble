import type { Vec3 } from '../util/vec';
import type { Sdf } from './mesher';

/** Samples of an SDF on a fine grid, stored only in blocks near the surface. */
export type SparseField = {
  origin: Vec3; cell: number; dims: [number, number, number]; // fine samples per axis
  block: number; // fine cells per block edge
  blocks: Int32Array; // active block ids (bx + by*bnx + bz*bnx*bny), ascending
  /** Fine sample; outside active blocks, the coarse value at that block's origin. */
  value(i: number, j: number, k: number): number;
  evaluations: number; // SDF calls made
  blockSlot: Int32Array; // block id -> index into `blocks` (-1 = inactive)
};

/** How close to the surface a coarse corner must read for its block to count as near. */
export const nearReach = (cell: number, block = 4): number => 1.25 * 0.5 * cell * block * Math.sqrt(3);

/**
 * Evaluates `coarse` on a coarse lattice (cell*block), then `sdf` on the fine lattice (cell) only inside
 * blocks near the surface plus the neighbours their cells read. The padded origin is min - 2 coarse cells.
 * Precondition on `coarse` (defaults to `sdf`): any point within `nearReach(cell, block)` of the surface
 * must read |coarse| <= that reach, i.e. it must not overestimate distance there. A culling SDF such as
 * `bodySdf` does, so pass `coarse = bodySdf(sk, anat, nearReach(cell, block) + 0.03)` (`coarseBodySdf`).
 */
export function sampleSparse(sdf: Sdf, min: Vec3, max: Vec3, cell: number, block = 4, coarse: Sdf = sdf): SparseField {
  const C = cell * block, B = block, B3 = B * B * B;
  const ox = min.x - 2 * C, oy = min.y - 2 * C, oz = min.z - 2 * C;
  const cx = Math.ceil((max.x - min.x + 4 * C) / C) + 1;
  const cy = Math.ceil((max.y - min.y + 4 * C) / C) + 1;
  const cz = Math.ceil((max.z - min.z + 4 * C) / C) + 1;
  const nbx = cx - 1, nby = cy - 1, nbz = cz - 1;
  let evaluations = 0;

  const cv = new Float32Array(cx * cy * cz);
  for (let k = 0, n = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) cv[n++] = coarse(ox + i * C, oy + j * C, oz + k * C);
  evaluations += cv.length;

  // near: any corner within reach of the surface. A block holding surface has a corner within half
  // a diagonal of it, so for a 1-Lipschitz `coarse` (see the precondition above) no surface block is missed.
  const reach = nearReach(cell, block);
  const active = new Uint8Array(nbx * nby * nbz);
  const csy = cx, csz = cx * cy;
  for (let bz = 0; bz < nbz; bz++)
    for (let by = 0; by < nby; by++)
      for (let bx = 0; bx < nbx; bx++) {
        const base = bx + by * csy + bz * csz;
        let near = false;
        for (let c = 0; c < 8 && !near; c++)
          near = Math.abs(cv[base + (c & 1) + ((c >> 1) & 1) * csy + ((c >> 2) & 1) * csz]) < reach;
        if (!near) continue;
        // a block's cells read samples from its +x/+y/+z neighbours, so those join it
        for (let dz = 0; dz <= 1; dz++)
          for (let dy = 0; dy <= 1; dy++)
            for (let dx = 0; dx <= 1; dx++) {
              const x = bx + dx, y = by + dy, z = bz + dz;
              if (x < nbx && y < nby && z < nbz) active[x + y * nbx + z * nbx * nby] = 1;
            }
      }

  let count = 0;
  for (let n = 0; n < active.length; n++) count += active[n];
  const blocks = new Int32Array(count);
  const blockSlot = new Int32Array(active.length).fill(-1);
  for (let n = 0, s = 0; n < active.length; n++) if (active[n]) { blocks[s] = n; blockSlot[n] = s++; }

  const pool = new Float32Array(count * B3);
  for (let s = 0; s < count; s++) {
    const id = blocks[s];
    const bx = id % nbx, by = ((id / nbx) | 0) % nby, bz = (id / (nbx * nby)) | 0;
    const px = ox + bx * C, py = oy + by * C, pz = oz + bz * C;
    let n = s * B3;
    for (let lz = 0; lz < B; lz++)
      for (let ly = 0; ly < B; ly++)
        for (let lx = 0; lx < B; lx++) pool[n++] = sdf(px + lx * cell, py + ly * cell, pz + lz * cell);
  }
  evaluations += count * B3;

  const value = (i: number, j: number, k: number): number => {
    const bx = (i / B) | 0, by = (j / B) | 0, bz = (k / B) | 0;
    if (bx < nbx && by < nby && bz < nbz) {
      const s = blockSlot[bx + by * nbx + bz * nbx * nby];
      if (s >= 0) return pool[s * B3 + (i - bx * B) + (j - by * B) * B + (k - bz * B) * B * B];
    }
    return cv[bx + by * csy + bz * csz];
  };
  return {
    origin: { x: ox, y: oy, z: oz }, cell, dims: [nbx * B + 1, nby * B + 1, nbz * B + 1],
    block, blocks, value, evaluations, blockSlot,
  };
}
