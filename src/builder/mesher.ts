import type { Vec3 } from '../util/vec';
import type { SparseField } from './sparse';

export type MeshData = { positions: Float32Array; normals: Float32Array; indices: Uint32Array };
export type Sdf = (x: number, y: number, z: number) => number;

// the 12 cube edges as pairs of corner indices; corner c sits at offset (c&1, (c>>1)&1, (c>>2)&1)
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7], // along x
  [0, 2], [1, 3], [4, 6], [5, 7], // along y
  [0, 4], [1, 5], [2, 6], [3, 7], // along z
];

const cr = new Float64Array(3);
/** Average of a cell's edge crossings (in cell units) into `cr`, from its 8 corner values; false if none. */
function crossing(corner: Float32Array): boolean {
  let px = 0, py = 0, pz = 0, n = 0;
  for (const [a, b] of EDGES) {
    const va = corner[a], vb = corner[b];
    if (va < 0 === vb < 0) continue;
    const t = va / (va - vb);
    px += (a & 1) + t * ((b & 1) - (a & 1));
    py += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1));
    pz += ((a >> 2) & 1) + t * (((b >> 2) & 1) - ((a >> 2) & 1));
    n++;
  }
  if (n === 0) return false;
  cr[0] = px / n; cr[1] = py / n; cr[2] = pz / n;
  return true;
}

/** Two triangles for the 4 cells around a sign-changing grid edge; inside → outside along +d faces +d. */
function pushQuad(idx: number[], inA: boolean, v0: number, v1: number, v2: number, v3: number): void {
  if (inA) idx.push(v0, v1, v2, v0, v2, v3);
  else idx.push(v0, v2, v1, v0, v3, v2);
}

/**
 * Surface nets: one vertex per cell the surface passes through (at the average of its edge
 * crossings), one quad per grid edge the surface crosses. Inside is sdf < 0.
 */
export function surfaceNets(sdf: Sdf, min: Vec3, max: Vec3, cell: number): MeshData {
  const pad = 2;
  const ox = min.x - pad * cell, oy = min.y - pad * cell, oz = min.z - pad * cell;
  const nx = Math.ceil((max.x - min.x) / cell) + 2 * pad + 1;
  const ny = Math.ceil((max.y - min.y) / cell) + 2 * pad + 1;
  const nz = Math.ceil((max.z - min.z) / cell) + 2 * pad + 1;
  const sy = nx, sz = nx * ny;
  const val = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) val[i + j * sy + k * sz] = sdf(ox + i * cell, oy + j * cell, oz + k * cell);

  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const pos: number[] = [];
  const corner = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const base = i + j * sy + k * sz;
        for (let c = 0; c < 8; c++) corner[c] = val[base + (c & 1) + ((c >> 1) & 1) * sy + ((c >> 2) & 1) * sz];
        if (!crossing(corner)) continue;
        cellVert[base] = pos.length / 3;
        pos.push(ox + (i + cr[0]) * cell, oy + (j + cr[1]) * cell, oz + (k + cr[2]) * cell);
      }

  // quads: for each grid edge with a sign change, join the 4 cells around it
  const idx: number[] = [];
  const strides = [1, sy, sz];
  const dims = [nx, ny, nz];
  for (let d = 0; d < 3; d++) {
    const su = strides[(d + 1) % 3], sw = strides[(d + 2) % 3];
    for (let k = 1; k < nz - 1; k++)
      for (let j = 1; j < ny - 1; j++)
        for (let i = 1; i < nx - 1; i++) {
          if ((d === 0 ? i : d === 1 ? j : k) >= dims[d] - 1) continue;
          const a = i + j * sy + k * sz;
          const inA = val[a] < 0, inB = val[a + strides[d]] < 0;
          if (inA === inB) continue;
          const v0 = cellVert[a], v1 = cellVert[a - su], v2 = cellVert[a - su - sw], v3 = cellVert[a - sw];
          if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) continue;
          pushQuad(idx, inA, v0, v1, v2, v3);
        }
  }

  const positions = new Float32Array(pos);
  const normals = new Float32Array(pos.length);
  const h = cell * 0.5;
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v], y = positions[v + 1], z = positions[v + 2];
    const gx = sdf(x + h, y, z) - sdf(x - h, y, z);
    const gy = sdf(x, y + h, z) - sdf(x, y - h, z);
    const gz = sdf(x, y, z + h) - sdf(x, y, z - h);
    const l = Math.hypot(gx, gy, gz) || 1;
    normals[v] = gx / l;
    normals[v + 1] = gy / l;
    normals[v + 2] = gz / l;
  }
  return { positions, normals, indices: new Uint32Array(idx) };
}

/**
 * Surface nets over a sparse field: only fine cells inside active blocks (ascending block, then
 * k, j, i); same vertices and winding as `surfaceNets`. No normals: positions and indices only.
 */
export function surfaceNetsSparse(f: SparseField): { positions: Float32Array; indices: Uint32Array } {
  const B = f.block, B3 = B * B * B, L = B + 1;
  const nbx = (f.dims[0] - 1) / B, nby = (f.dims[1] - 1) / B;
  const { x: ox, y: oy, z: oz } = f.origin, cell = f.cell, blocks = f.blocks;
  const slot = f.blockSlot;

  // pass 1: a vertex per surface cell; `edges` bits 0-2 = the cell's +x/+y/+z edge changes sign, bit 3 = corner 0 inside
  const cellVert = new Int32Array(blocks.length * B3).fill(-1);
  const edges = new Uint8Array(blocks.length * B3);
  const pos: number[] = [];
  const local = new Float32Array(L * L * L);
  const corner = new Float32Array(8);
  for (let s = 0; s < blocks.length; s++) {
    const id = blocks[s];
    const bx = (id % nbx) * B, by = (((id / nbx) | 0) % nby) * B, bz = ((id / (nbx * nby)) | 0) * B;
    for (let n = 0, lz = 0; lz < L; lz++)
      for (let ly = 0; ly < L; ly++)
        for (let lx = 0; lx < L; lx++) local[n++] = f.value(bx + lx, by + ly, bz + lz);
    for (let lz = 0; lz < B; lz++)
      for (let ly = 0; ly < B; ly++)
        for (let lx = 0; lx < B; lx++) {
          const base = lx + ly * L + lz * L * L;
          for (let c = 0; c < 8; c++) corner[c] = local[base + (c & 1) + ((c >> 1) & 1) * L + ((c >> 2) & 1) * L * L];
          if (!crossing(corner)) continue;
          const n = s * B3 + lx + ly * B + lz * B * B;
          const in0 = corner[0] < 0;
          edges[n] = (corner[1] < 0 !== in0 ? 1 : 0) | (corner[2] < 0 !== in0 ? 2 : 0) | (corner[4] < 0 !== in0 ? 4 : 0) | (in0 ? 8 : 0);
          cellVert[n] = pos.length / 3;
          pos.push(ox + (bx + lx + cr[0]) * cell, oy + (by + ly + cr[1]) * cell, oz + (bz + lz + cr[2]) * cell);
        }
  }

  /** Vertex id of the fine cell (x, y, z), or -1 when it has none or lies in an inactive block. */
  const vertAt = (x: number, y: number, z: number): number => {
    if (x < 0 || y < 0 || z < 0) return -1;
    const bx = (x / B) | 0, by = (y / B) | 0, bz = (z / B) | 0;
    const s = slot[bx + by * nbx + bz * nbx * nby];
    return s < 0 ? -1 : cellVert[s * B3 + (x - bx * B) + (y - by * B) * B + (z - bz * B) * B * B];
  };

  // pass 2: a quad per sign-changing edge, joining the 4 cells around it
  const idx: number[] = [];
  const g = [0, 0, 0], u = [0, 0, 0];
  for (let s = 0; s < blocks.length; s++) {
    const id = blocks[s];
    const bx = (id % nbx) * B, by = (((id / nbx) | 0) % nby) * B, bz = ((id / (nbx * nby)) | 0) * B;
    for (let lz = 0; lz < B; lz++)
      for (let ly = 0; ly < B; ly++)
        for (let lx = 0; lx < B; lx++) {
          const n = s * B3 + lx + ly * B + lz * B * B;
          const e = edges[n];
          if ((e & 7) === 0) continue;
          g[0] = bx + lx; g[1] = by + ly; g[2] = bz + lz;
          for (let d = 0; d < 3; d++) {
            if (!(e & (1 << d))) continue;
            const a = (d + 1) % 3, b = (d + 2) % 3;
            u[0] = g[0]; u[1] = g[1]; u[2] = g[2];
            u[a]--;
            const v1 = vertAt(u[0], u[1], u[2]);
            u[b]--;
            const v2 = vertAt(u[0], u[1], u[2]);
            u[a]++;
            const v3 = vertAt(u[0], u[1], u[2]);
            if (v1 < 0 || v2 < 0 || v3 < 0) continue;
            pushQuad(idx, (e & 8) !== 0, cellVert[n], v1, v2, v3);
          }
        }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/**
 * Where surface nets meet an ambiguous face, two sheets touch along an edge that four triangles share.
 * Around such an edge the triangles are paired across the solid wedges between them (their windings say
 * which side is inside), each vertex on it gets one copy per sheet its triangles then form (grouped across
 * edges of two triangles and those pairs), and so every edge ends up in exactly two triangles.
 * Returns the input itself when no edge has more than two triangles.
 */
export function splitNonManifold(m: { positions: Float32Array; indices: Uint32Array }): { positions: Float32Array; indices: Uint32Array } {
  const n = m.positions.length / 3, idx = m.indices, P = m.positions;
  // triangles around each vertex, ascending
  const start = new Int32Array(n + 1);
  for (let i = 0; i < idx.length; i++) start[idx[i] + 1]++;
  for (let v = 0; v < n; v++) start[v + 1] += start[v];
  const fan = new Int32Array(idx.length), fill = start.slice(0, n);
  for (let i = 0; i < idx.length; i++) fan[fill[idx[i]]++] = (i / 3) | 0;

  // vertices plus room for copies: a split vertex gets at most (its triangles − 1) copies, so never more than 3 per triangle
  const room = n + idx.length;
  const mark = new Int32Array(room).fill(-1), cnt = new Int32Array(room), seen = new Int32Array(room).fill(-1);
  const extra: number[] = []; // source vertex of each copy
  const src = (x: number) => (x < n ? x : extra[x - n]);
  let out: Uint32Array | null = null;
  let parent = new Int32Array(32); // union-find over one vertex's triangles; grows for a busier vertex
  const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const join = (i: number, j: number) => { parent[find(j)] = find(i); };
  const around: { i: number; angle: number; inward: boolean }[] = [];

  let tag = 0;
  /** Groups v's triangles into sheets (union-find over `parent`); true if v then splits (more than one sheet). */
  const groupFan = (v: number, s: number, deg: number, cur: Uint32Array, solid: boolean): boolean => {
    tag++;
    for (let i = 0; i < deg; i++) parent[i] = i;
    for (let i = 0; i < deg; i++)
      for (let k = 0; k < 3; k++) {
        const x = cur[fan[s + i] * 3 + k];
        if (x === v) continue;
        if (cnt[x] === 2) {
          for (let j = i + 1; j < deg; j++) {
            const f = fan[s + j] * 3;
            if (cur[f] === x || cur[f + 1] === x || cur[f + 2] === x) { join(i, j); break; }
          }
          continue;
        }
        if (seen[x] === tag) continue;
        seen[x] = tag;
        // more than two: order the triangles by angle around the edge v→x and join neighbours across a wedge
        const o = src(x) * 3;
        const ux = P[o] - P[v * 3], uy = P[o + 1] - P[v * 3 + 1], uz = P[o + 2] - P[v * 3 + 2];
        const ul = Math.hypot(ux, uy, uz) || 1;
        const ax = ux / ul, ay = uy / ul, az = uz / ul;
        // e1 ⟂ u, e2 = u × e1
        let e1x = Math.abs(ax) < 0.9 ? 1 : 0, e1y = Math.abs(ax) < 0.9 ? 0 : 1, e1z = 0;
        const dp = e1x * ax + e1y * ay;
        e1x -= dp * ax; e1y -= dp * ay; e1z -= dp * az;
        const el = Math.hypot(e1x, e1y, e1z);
        e1x /= el; e1y /= el; e1z /= el;
        const e2x = ay * e1z - az * e1y, e2y = az * e1x - ax * e1z, e2z = ax * e1y - ay * e1x;
        around.length = 0;
        for (let j = 0; j < deg; j++) {
          const f = fan[s + j] * 3;
          let kx = -1;
          for (let q = 0; q < 3; q++) if (cur[f + q] === x) kx = q;
          if (kx < 0) continue;
          const w = cur[f + 3 - kx - (cur[f] === v ? 0 : cur[f + 1] === v ? 1 : 2)];
          const ow = src(w) * 3;
          const dx = P[ow] - P[v * 3], dy = P[ow + 1] - P[v * 3 + 1], dz = P[ow + 2] - P[v * 3 + 2];
          const angle = Math.atan2(dx * e2x + dy * e2y + dz * e2z, dx * e1x + dy * e1y + dz * e1z);
          // winding v→x puts the normal (outside) towards larger angles, so the solid lies just below
          const vx = cur[f + ((kx + 2) % 3)] === v;
          around.push({ i: j, angle, inward: !vx });
        }
        around.sort((p, q) => p.angle - q.angle || p.i - q.i);
        const c = around.length;
        let alternates = c % 2 === 0;
        for (let q = 0; q < c && alternates; q++) alternates = around[q].inward !== around[(q + 1) % c].inward;
        if (!alternates) continue;
        // the wedge after a triangle whose solid lies above it (winding x→v) is solid: join across it (or the others)
        for (let q = 0; q < c; q++) if (around[q].inward === solid) join(around[q].i, around[(q + 1) % c].i);
      }
    const first = find(0);
    for (let i = 1; i < deg; i++) if (find(i) !== first) return true;
    return false;
  };

  for (let v = 0; v < n; v++) {
    const cur: Uint32Array = out ?? idx;
    const s = start[v], deg = start[v + 1] - s;
    // triangles on each edge v-x
    let bad = false;
    for (let i = s; i < s + deg; i++)
      for (let k = 0; k < 3; k++) {
        const x = cur[fan[i] * 3 + k];
        if (x === v) continue;
        if (mark[x] !== v) { mark[x] = v; cnt[x] = 0; }
        if (++cnt[x] > 2) bad = true;
      }
    if (!bad) continue;
    if (deg > parent.length) parent = new Int32Array(deg);
    // pair across the solid wedges first; if that leaves every sheet joined, across the open ones
    for (let mode = 0; mode < 2 && !groupFan(v, s, deg, cur, mode === 0); mode++);
    out ??= idx.slice();
    // the sheet holding v's first triangle keeps v; each other sheet gets a copy
    const copy = new Map<number, number>();
    const first = find(0);
    for (let i = 0; i < deg; i++) {
      const r = find(i);
      if (r === first) continue;
      let c = copy.get(r);
      if (c === undefined) { c = n + extra.length; extra.push(v); copy.set(r, c); }
      const f = fan[s + i] * 3;
      for (let k = 0; k < 3; k++) if (out[f + k] === v) out[f + k] = c;
    }
  }
  if (!out) return m;
  const positions = new Float32Array((n + extra.length) * 3);
  positions.set(P);
  extra.forEach((v, i) => positions.set(P.subarray(v * 3, v * 3 + 3), (n + i) * 3));
  return { positions, indices: out };
}
