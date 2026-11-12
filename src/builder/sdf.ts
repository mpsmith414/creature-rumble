import type { Build, FlatFacing, Role } from '../recipe/schema';
import { cross, dot, norm, scale, sub, v3, type Vec3 } from '../util/vec';
import type { Anatomy } from './anatomy';
import type { Feature } from './anatomy/shapes';
import type { BoneDef, Skeleton } from './skeleton';
import { nearReach } from './sparse';

/**
 * Signed distance to a round cone (a capsule with different end radii).
 * Inigo Quilez, "round cone - exact". Negative inside.
 */
export function roundCone(p: Vec3, a: Vec3, b: Vec3, r1: number, r2: number): number {
  return roundConeAt(p.x - a.x, p.y - a.y, p.z - a.z, b.x - a.x, b.y - a.y, b.z - a.z, r1, r2);
}

/** `roundCone` for p − a = (ax, ay, az) and b − a = (bx, by, bz), without allocating (it runs millions of times per body). */
export function roundConeAt(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r1: number, r2: number): number {
  const l2 = bx * bx + by * by + bz * bz;
  if (l2 < 1e-12) return Math.hypot(ax, ay, az) - Math.max(r1, r2);
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const y = ax * bx + ay * by + az * bz;
  const z = y - l2;
  const xx = ax * l2 - bx * y, xy = ay * l2 - by * y, xz = az * l2 - bz * y;
  const x2 = xx * xx + xy * xy + xz * xz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

/** Polynomial smooth minimum; k = 0 is a plain min. */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** How softly each kind of part melts into what it grows from (× the joint radius). */
export function blendFor(role: Role, feet?: Build['feet']): number {
  switch (role) {
    case 'torso': case 'neck': case 'head': return 0.6;
    case 'tail': return 0.4;
    case 'leg': case 'arm': return 0.25;
    case 'foot': return feet === 'hooves' ? 0.05 : 0.15;
    case 'hand': return 0.15;
    case 'ear': case 'fin': case 'wing': return 0.2;
    case 'horn': case 'antenna': return 0.05;
    case 'eye': return 0;
    default: return 0.3;
  }
}

const WORLD: Record<FlatFacing, Vec3> = { up: v3(0, 1, 0), side: v3(1, 0, 0), forward: v3(0, 0, 1) };

/** The axis a squashed part is thin along: the facing direction made perpendicular to the bone. */
export function thinAxis(b: BoneDef): Vec3 {
  const a = norm(sub(b.end, b.start));
  for (const f of [WORLD[b.flatFacing], WORLD.up, WORLD.forward, WORLD.side]) {
    const t = sub(f, scale(a, dot(f, a)));
    if (Math.hypot(t.x, t.y, t.z) > 0.2) return norm(t);
  }
  return norm(cross(a, WORLD.side));
}

export const tipRadius = (b: BoneDef) => (b.pointed ? Math.max(0.002, b.r1 * 0.15) : b.r1);

/** Distance to one bone's own shape (squash and point applied). */
export function boneSdf(p: Vec3, b: BoneDef, thin: Vec3 = thinAxis(b)): number {
  return boneSdfAt(p.x, p.y, p.z, b, thin);
}

/** `boneSdf` at (x, y, z), without allocating. */
export function boneSdfAt(x: number, y: number, z: number, b: BoneDef, thin: Vec3): number {
  const r1 = tipRadius(b);
  const { start: a, end: e } = b;
  const ax = x - a.x, ay = y - a.y, az = z - a.z;
  if (b.squash >= 0.999) return roundConeAt(ax, ay, az, e.x - a.x, e.y - a.y, e.z - a.z, b.r0, r1);
  // stretch space along the thin axis, measure, then scale back (a slight underestimate, fine for meshing)
  const s = (ax * thin.x + ay * thin.y + az * thin.z) * (1 / b.squash - 1);
  return roundConeAt(ax + thin.x * s, ay + thin.y * s, az + thin.z * s, e.x - a.x, e.y - a.y, e.z - a.z, b.r0, r1) * b.squash;
}

/**
 * Per-bone floats bodySdf reads, packed flat: box min/max, start, end − start, r0, tip radius, squash, thin axis,
 * blend, R = the larger end radius, sq = the squash the distance is scaled by (1 on the round-cone path), 1/|end − start|².
 */
const STRIDE = 22;

/**
 * The whole body as one distance function: bones blended in tree order (radii scaled by `anat.slim`), then
 * the anatomy's `add` features (smooth union), then its `carve`s (smooth subtraction); marks change no shape.
 * Eyes are separate meshes. Bones and features are skipped outside their reach boxes grown by `margin`.
 * `shallow` (the coarse lattice's SDF) scales depths inside ellipsoids by rmin/rmax: the ellipsoid bound can
 * overstate depth inside a long ellipsoid, and a coarse SDF must never overstate distance (see `sampleSparse`).
 */
export function bodySdf(sk: Skeleton, anat?: Anatomy, margin = 0.03, shallow = false): (x: number, y: number, z: number) => number {
  const bones = anat ? sk.bones.map((b, i) => (anat.slim[i] === 1 ? b : { ...b, r0: b.r0 * anat.slim[i], r1: b.r1 * anat.slim[i] })) : sk.bones;
  const list = bones.filter((b) => b.role !== 'eye');
  const n = list.length, F = new Float64Array(n * STRIDE);
  list.forEach((b, i) => {
    const par = b.parent >= 0 ? bones[b.parent] : null;
    const joint = par ? Math.min(b.r0, Math.max(par.r0, par.r1)) : 0;
    const k = par ? blendFor(b.role, anat?.feet) * joint : 0;
    // reach = radius + blend + a margin, so points just off the surface still see this bone exactly
    const r = Math.max(b.r0, b.r1) * 1.5 + k + margin;
    const t = thinAxis(b);
    const dx = b.end.x - b.start.x, dy = b.end.y - b.start.y, dz = b.end.z - b.start.z, l2 = dx * dx + dy * dy + dz * dz;
    F.set([
      Math.min(b.start.x, b.end.x) - r, Math.min(b.start.y, b.end.y) - r, Math.min(b.start.z, b.end.z) - r,
      Math.max(b.start.x, b.end.x) + r, Math.max(b.start.y, b.end.y) + r, Math.max(b.start.z, b.end.z) + r,
      b.start.x, b.start.y, b.start.z, dx, dy, dz,
      b.r0, tipRadius(b), b.squash, t.x, t.y, t.z, k, Math.max(b.r0, tipRadius(b)), b.squash >= 0.999 ? 1 : b.squash, l2 > 0 ? 1 / l2 : 0,
    ], i * STRIDE);
  });
  const feats = anat ? [...anat.features.filter((f) => f.op === 'add'), ...anat.features.filter((f) => f.op === 'carve')] : [];
  const adds = feats.filter((f) => f.op === 'add').length, G = packFeatures(feats, margin, shallow);
  // a coarse grid of the boxes that touch each cell; the root bone is always in (it starts the fold)
  const grid = boxGrid([F, G], [STRIDE, FSTRIDE], [n, feats.length]);
  const { x0, y0, z0, inv, nx, ny, nz, outside } = grid, [bs, bi] = grid.lists[0], [fs, fi] = grid.lists[1];
  const far = 1e3;
  return (x, y, z) => {
    let d = far;
    const gx = Math.floor((x - x0) * inv), gy = Math.floor((y - y0) * inv), gz = Math.floor((z - z0) * inv);
    const c = gx < 0 || gy < 0 || gz < 0 || gx >= nx || gy >= ny || gz >= nz ? outside : gx + nx * (gy + ny * gz);
    for (let e = bs[c], end = bs[c + 1]; e < end; e++) {
      const o = bi[e] * STRIDE;
      if (d < far) {
        // outside this bone's reach: it can't lower d below the box distance, skip unless d is still "far"
        if (x < F[o] || y < F[o + 1] || z < F[o + 2] || x > F[o + 3] || y > F[o + 4] || z > F[o + 5]) continue;
        // the bone's distance is at least sq·(D − R), D = distance to its segment; when that is ≥ d + k
        // the blend returns d exactly, so skipping it changes nothing
        const lim = (d + F[o + 18]) / F[o + 20] + F[o + 19];
        if (lim <= 0) continue;
        const dx = F[o + 9], dy = F[o + 10], dz = F[o + 11];
        const px = x - F[o + 6], py = y - F[o + 7], pz = z - F[o + 8];
        const u = Math.min(1, Math.max(0, (px * dx + py * dy + pz * dz) * F[o + 21]));
        const qx = px - dx * u, qy = py - dy * u, qz = pz - dz * u;
        if (qx * qx + qy * qy + qz * qz >= lim * lim) continue;
      }
      // boneSdf, unrolled
      const ax = x - F[o + 6], ay = y - F[o + 7], az = z - F[o + 8];
      const bx = F[o + 9], by = F[o + 10], bz = F[o + 11];
      const squash = F[o + 14];
      let v: number;
      if (squash >= 0.999) v = roundConeAt(ax, ay, az, bx, by, bz, F[o + 12], F[o + 13]);
      else {
        const tx = F[o + 15], ty = F[o + 16], tz = F[o + 17];
        const s = (ax * tx + ay * ty + az * tz) * (1 / squash - 1);
        v = roundConeAt(ax + tx * s, ay + ty * s, az + tz * s, bx, by, bz, F[o + 12], F[o + 13]) * squash;
      }
      d = d >= far ? v : smin(d, v, F[o + 18]);
    }
    for (let e = fs[c], end = fs[c + 1]; e < end; e++) {
      const i = fi[e], o = i * FSTRIDE;
      // outside its box an add is at least margin + k away (cannot lower d near the surface), a carve likewise cannot raise it
      if (x < G[o] || y < G[o + 1] || z < G[o + 2] || x > G[o + 3] || y > G[o + 4] || z > G[o + 5]) continue;
      // exact skip: the blend returns d unchanged when the feature's distance is ≥ t (add: d + k, carve: k − d), and that
      // distance is at least (D − R)/q outside its bounding sphere and D − R inside (D = |p − centre|, R its radius, q = R/rmin)
      const k = G[o + 7], t = i < adds ? d + k : k - d;
      const lim = G[o + 33] + (t > 0 ? t * G[o + 34] : t);
      if (lim <= 0) continue;
      const sx = x - G[o + 30], sy = y - G[o + 31], sz = z - G[o + 32];
      if (sx * sx + sy * sy + sz * sz >= lim * lim) continue;
      const v = featureAt(G, o, x, y, z);
      d = i < adds ? smin(d, v, k) : -smin(-d, v, k);
    }
    return d;
  };
}

/**
 * A uniform grid (about GRID_CELLS along the longest side) over the boxes of packed bones and features (each box
 * at the start of its stride): per cell, in order, the indices of the boxes that overlap it, as offsets (`lists[g][0]`)
 * into indices (`lists[g][1]`). Cell `outside` (the last) lists only bone 0 (the root), for points off the grid.
 * Box tests stay in bodySdf, so the grid only removes boxes that would be skipped anyway.
 */
const GRID_CELLS = 24;

function boxGrid(packs: Float64Array[], strides: number[], counts: number[]) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  packs.forEach((P, g) => {
    for (let o = 0; o < counts[g] * strides[g]; o += strides[g]) {
      x0 = Math.min(x0, P[o]); y0 = Math.min(y0, P[o + 1]); z0 = Math.min(z0, P[o + 2]);
      x1 = Math.max(x1, P[o + 3]); y1 = Math.max(y1, P[o + 4]); z1 = Math.max(z1, P[o + 5]);
    }
  });
  const size = Math.max(x1 - x0, y1 - y0, z1 - z0, 1e-6) / GRID_CELLS, inv = 1 / size;
  // floor + 1: a point on the far face of the union box still lands in a cell
  const nx = Math.floor((x1 - x0) * inv) + 1, ny = Math.floor((y1 - y0) * inv) + 1, nz = Math.floor((z1 - z0) * inv) + 1;
  const outside = nx * ny * nz;
  const lists = packs.map((P, g) => {
    const cells: number[][] = Array.from({ length: outside + 1 }, () => []);
    for (let i = 0; i < counts[g]; i++) {
      const o = i * strides[g];
      const cl = (v: number, m: number) => Math.min(m - 1, Math.max(0, Math.floor(v)));
      const ia = cl((P[o] - x0) * inv, nx), ib = cl((P[o + 3] - x0) * inv, nx);
      const ja = cl((P[o + 1] - y0) * inv, ny), jb = cl((P[o + 4] - y0) * inv, ny);
      const ka = cl((P[o + 2] - z0) * inv, nz), kb = cl((P[o + 5] - z0) * inv, nz);
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let ii = 0; ii < nx; ii++) {
        // bone 0 everywhere: while d is still "far" the first bone is evaluated whatever its box
        if ((g === 0 && i === 0) || (ii >= ia && ii <= ib && j >= ja && j <= jb && k >= ka && k <= kb)) cells[ii + nx * (j + ny * k)].push(i);
      }
    }
    if (g === 0 && counts[0] > 0) cells[outside].push(0);
    const start = new Int32Array(outside + 2);
    cells.forEach((c, n) => (start[n + 1] = start[n] + c.length));
    return [start, Int32Array.from(cells.flat())] as const;
  });
  return { x0, y0, z0, inv, nx, ny, nz, outside, lists };
}

/**
 * Per-feature floats bodySdf reads: box min/max (grown by the margin), type (0 ellipsoid, 1 cone, 2 slab), blend k, then
 * ellipsoid: centre, the axes divided by their radii, the axes divided by their radii squared, the smallest radius;
 * cone: start, end − start, r0, r1; slab: centre, the in-plane axes divided by their radii, the thin axis, the in-plane
 * axes divided by their radii squared, the half thickness h (26), the ellipse's smaller radius (29);
 * then a bounding sphere's centre and radius R, and q (from 30; distance ≥ (D − R)/q outside, ≥ D − R inside:
 * ellipsoid q = R/rmin as its bound is ≥ rmin·(k0 − 1); slab R = rmax + h, q = 2·rmax/rmin, as its in-plane and
 * across overshoots sum to at least D − R); then the scale for negative ellipse(oid) values (35: rmin/rmax when
 * shallow, else 1; |bound|·rmin/rmax ≤ rmin·(1 − k0) ≤ the true depth; a slab's max with |q2| − h keeps that).
 */
const FSTRIDE = 36;

function packFeatures(feats: Feature[], margin: number, shallow: boolean): Float64Array {
  const G = new Float64Array(feats.length * FSTRIDE);
  feats.forEach((f, i) => {
    const o = i * FSTRIDE, s = f.shape;
    G.set([f.min.x - margin, f.min.y - margin, f.min.z - margin, f.max.x + margin, f.max.y + margin, f.max.z + margin, s.type === 'cone' ? 1 : s.type === 'slab' ? 2 : 0, f.k], o);
    if (s.type === 'slab') {
      const [u, v, w] = s.ax, { x: a, y: b, z: h } = s.r, rmin = Math.min(a, b), rmax = Math.max(a, b);
      G.set([s.c.x, s.c.y, s.c.z, u.x / a, u.y / a, u.z / a, v.x / b, v.y / b, v.z / b, w.x, w.y, w.z,
        u.x / a ** 2, u.y / a ** 2, u.z / a ** 2, v.x / b ** 2, v.y / b ** 2, v.z / b ** 2, h], o + 8);
      G[o + 29] = rmin;
      G.set([s.c.x, s.c.y, s.c.z, rmax + h, (2 * rmax) / rmin, shallow ? rmin / rmax : 1], o + 30);
    } else if (s.type === 'cone') {
      G.set([s.a.x, s.a.y, s.a.z, s.b.x - s.a.x, s.b.y - s.a.y, s.b.z - s.a.z, s.r0, s.r1], o + 8);
      const half = 0.5 * Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y, s.b.z - s.a.z);
      G.set([(s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, (s.a.z + s.b.z) / 2, half + Math.max(s.r0, s.r1), 1], o + 30);
    } else {
      const r = [s.r.x, s.r.y, s.r.z];
      G.set([s.c.x, s.c.y, s.c.z], o + 8);
      s.ax.forEach((a, j) => {
        G.set([a.x / r[j], a.y / r[j], a.z / r[j]], o + 11 + 3 * j);
        G.set([a.x / r[j] ** 2, a.y / r[j] ** 2, a.z / r[j] ** 2], o + 20 + 3 * j);
      });
      G[o + 29] = Math.min(...r);
      G.set([s.c.x, s.c.y, s.c.z, Math.max(...r), Math.max(...r) / Math.min(...r), shallow ? Math.min(...r) / Math.max(...r) : 1], o + 30);
    }
  });
  return G;
}

/** One packed feature's distance at (x, y, z), without allocating (the ellipsoid bound of `shapeSdf`). */
function featureAt(G: Float64Array, o: number, x: number, y: number, z: number): number {
  const px = x - G[o + 8], py = y - G[o + 9], pz = z - G[o + 10];
  if (G[o + 6] === 1) return roundConeAt(px, py, pz, G[o + 11], G[o + 12], G[o + 13], G[o + 14], G[o + 15]);
  if (G[o + 6] === 2) {
    const a0 = px * G[o + 11] + py * G[o + 12] + pz * G[o + 13], a1 = px * G[o + 14] + py * G[o + 15] + pz * G[o + 16];
    const b0 = px * G[o + 20] + py * G[o + 21] + pz * G[o + 22], b1 = px * G[o + 23] + py * G[o + 24] + pz * G[o + 25];
    const across = Math.abs(px * G[o + 17] + py * G[o + 18] + pz * G[o + 19]) - G[o + 26];
    const k1 = Math.sqrt(b0 * b0 + b1 * b1), k0 = Math.sqrt(a0 * a0 + a1 * a1);
    const e = k1 < 1e-12 ? -G[o + 29] * G[o + 35] : k0 < 1 ? ((k0 * (k0 - 1)) / k1) * G[o + 35] : (k0 * (k0 - 1)) / k1;
    return Math.max(e, across);
  }
  const a0 = px * G[o + 11] + py * G[o + 12] + pz * G[o + 13];
  const a1 = px * G[o + 14] + py * G[o + 15] + pz * G[o + 16];
  const a2 = px * G[o + 17] + py * G[o + 18] + pz * G[o + 19];
  const b0 = px * G[o + 20] + py * G[o + 21] + pz * G[o + 22];
  const b1 = px * G[o + 23] + py * G[o + 24] + pz * G[o + 25];
  const b2 = px * G[o + 26] + py * G[o + 27] + pz * G[o + 28];
  const k1 = Math.sqrt(b0 * b0 + b1 * b1 + b2 * b2);
  if (k1 < 1e-12) return -G[o + 29] * G[o + 35];
  const k0 = Math.sqrt(a0 * a0 + a1 * a1 + a2 * a2);
  return k0 < 1 ? ((k0 * (k0 - 1)) / k1) * G[o + 35] : (k0 * (k0 - 1)) / k1;
}

/**
 * The body SDF for a sparse sampler's coarse lattice at fine cell `cell`: its bone and feature box culls widened
 * by the near reach, so a coarse corner near a thin part or a feature never misses it (see `sampleSparse`).
 */
export const coarseBodySdf = (sk: Skeleton, anat: Anatomy | undefined, cell: number, block = 4) => bodySdf(sk, anat, nearReach(cell, block) + 0.03, true);
