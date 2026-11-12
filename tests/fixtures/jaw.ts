import type { LodMesh } from '../../src/builder/build';
import type { MouthFrame } from '../../src/builder/anatomy/face';

/** The weight vertex `v` gives the jaw bone (0 when it has none). */
export function jawWeight(lod: Pick<LodMesh, 'skinIndex' | 'skinWeight'>, jaw: number, v: number): number {
  let w = 0;
  for (let k = 0; k < 4; k++) if (lod.skinIndex[v * 4 + k] === jaw && jaw >= 0) w += lod.skinWeight[v * 4 + k];
  return w;
}

/**
 * Every vertex skinned with only the jaw posed (the rest of the body at its bind pose), as the old skinned creature object posed it:
 * the jaw bone raised by `lift` along the mouth's up, then turned `theta` about up × forward (a positive angle drops the
 * chin). Creature space; no three.js needed.
 */
export function jawPose(lod: Pick<LodMesh, 'positions' | 'skinIndex' | 'skinWeight'>, jaw: number, m: MouthFrame, lift: number, theta: number): Float32Array {
  const P = lod.positions, out = P.slice();
  // axis k = up × forward (unit: the frame is orthonormal); Rodrigues' rotation
  const k = { x: m.up.y * m.forward.z - m.up.z * m.forward.y, y: m.up.z * m.forward.x - m.up.x * m.forward.z, z: m.up.x * m.forward.y - m.up.y * m.forward.x };
  const c = Math.cos(theta), s = Math.sin(theta);
  for (let v = 0; v < P.length / 3; v++) {
    const w = jawWeight(lod, jaw, v);
    if (w === 0) continue;
    const x = P[v * 3] - m.hinge.x, y = P[v * 3 + 1] - m.hinge.y, z = P[v * 3 + 2] - m.hinge.z;
    const kd = k.x * x + k.y * y + k.z * z;
    const rx = x * c + (k.y * z - k.z * y) * s + k.x * kd * (1 - c);
    const ry = y * c + (k.z * x - k.x * z) * s + k.y * kd * (1 - c);
    const rz = z * c + (k.x * y - k.y * x) * s + k.z * kd * (1 - c);
    out[v * 3] += w * (rx + m.hinge.x + lift * m.up.x - P[v * 3]);
    out[v * 3 + 1] += w * (ry + m.hinge.y + lift * m.up.y - P[v * 3 + 1]);
    out[v * 3 + 2] += w * (rz + m.hinge.z + lift * m.up.z - P[v * 3 + 2]);
  }
  return out;
}

/**
 * Triangles whose facing turns over between two poses of the same mesh. With `sliver`, triangles smaller than that
 * fraction of the median triangle (in pose `a`) are left out: a near-degenerate sliver's facing is noise.
 */
export function flippedTriangles(indices: Uint32Array, a: Float32Array, b: Float32Array, sliver = 0): number {
  const normal = (P: Float32Array, t: number) => {
    const i = indices[t] * 3, j = indices[t + 1] * 3, l = indices[t + 2] * 3;
    const ux = P[j] - P[i], uy = P[j + 1] - P[i + 1], uz = P[j + 2] - P[i + 2], vx = P[l] - P[i], vy = P[l + 1] - P[i + 1], vz = P[l + 2] - P[i + 2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  const areas: number[] = [];
  for (let t = 0; t < indices.length; t += 3) areas.push(Math.hypot(...normal(a, t)));
  const min = sliver * [...areas].sort((x, y) => x - y)[areas.length >> 1];
  let n = 0;
  for (let t = 0; t < indices.length; t += 3) {
    if (areas[t / 3] < min) continue;
    const p = normal(a, t), q = normal(b, t);
    if (p[0] * q[0] + p[1] * q[1] + p[2] * q[2] < 0) n++;
  }
  return n;
}

/** Whether the ray from `o` along `d` hits any triangle of the mesh (Möller–Trumbore, both facings). */
export function rayHits(indices: Uint32Array, P: Float32Array, o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }): boolean {
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-18) continue;
    const tx = o.x - P[a], ty = o.y - P[a + 1], tz = o.z - P[a + 2];
    const u = (tx * px + ty * py + tz * pz) / det;
    if (u < -1e-9 || u > 1 + 1e-9) continue; // (a hair of slack: a ray through a shared edge hits one of its triangles)
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d.x * qx + d.y * qy + d.z * qz) / det;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    if ((e2x * qx + e2y * qy + e2z * qz) / det > 0) return true;
  }
  return false;
}
