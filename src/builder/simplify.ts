/** Mesh to simplify: a closed triangle mesh and a per-vertex importance (≥ 1; higher keeps more detail). */
export type SimplifyInput = { positions: Float32Array; indices: Uint32Array; weight: Float32Array /* per vertex, ≥ 1 */ };
/** A compacted copy of the simplifier's current mesh; `source` = the input vertex each output vertex kept. */
export type Snapshot = { positions: Float32Array; indices: Uint32Array; source: Uint32Array /* input vertex each output vertex kept */ };
export type Simplifier = {
  readonly triangles: number; // live triangles now
  collapseTo(target: number): void; // collapse until triangles ≤ target or no legal collapse is left
  snapshot(): Snapshot; // compacted copy of the current mesh
};

/**
 * Edge-length regulariser: cost += REG · tr(Q_a+Q_b) · |b−a|² (tr = the weighted area around the edge, so the
 * term has the quadric's units). Along a straight, constant-radius part the quadric costs nothing, and without
 * it ties by edge id let one vertex swallow a whole axial run (long sliver fans).
 */
const REG = 1e-3;

const qs = new Float64Array(10);
/** vᵀQv for a symmetric 4×4 quadric stored as its upper triangle (10 floats) and v = (x, y, z, 1). */
function quadErr(q: Float64Array, x: number, y: number, z: number): number {
  return q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y + 2 * q[5] * y * z +
    2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9];
}

/** Per-vertex growable id lists packed in one Int32Array; a list that outgrows its slot moves to the end. */
class Lists {
  readonly start: Int32Array;
  readonly len: Int32Array;
  readonly cap: Int32Array;
  pool: Int32Array;
  top: number;
  constructor(sizes: Int32Array, slack: number) {
    const n = sizes.length;
    this.start = new Int32Array(n); this.len = new Int32Array(n); this.cap = new Int32Array(n);
    let t = 0;
    for (let v = 0; v < n; v++) { this.start[v] = t; this.cap[v] = sizes[v] + slack; t += sizes[v] + slack; }
    this.pool = new Int32Array(t + (t >> 2) + 16);
    this.top = t;
  }
  push(v: number, x: number): void {
    const l = this.len[v];
    if (l === this.cap[v]) this.grow(v);
    this.pool[this.start[v] + l] = x;
    this.len[v] = l + 1;
  }
  /** Drops the ids whose `alive` flag is 0 from v's list, keeping order. */
  compact(v: number, alive: Uint8Array): void {
    const s = this.start[v], l = this.len[v], p = this.pool;
    let j = s;
    for (let i = s; i < s + l; i++) if (alive[p[i]]) p[j++] = p[i];
    this.len[v] = j - s;
  }
  private grow(v: number): void {
    const c = this.cap[v] * 2 + 4;
    if (this.top + c > this.pool.length) {
      const p = new Int32Array(Math.max(this.pool.length * 2, this.top + c));
      p.set(this.pool.subarray(0, this.top));
      this.pool = p;
    }
    this.pool.copyWithin(this.top, this.start[v], this.start[v] + this.len[v]);
    this.start[v] = this.top; this.cap[v] = c; this.top += c;
  }
}

/**
 * Garland–Heckbert edge collapse with importance weights: Q_v = w_v · Σ area_f · K_f, and an edge's cost
 * (plus the REG length term) is also scaled by max(w_a, w_b), so the effective importance is about w².
 * The cheapest edge (ties by edge id) collapses its higher vertex into its lower one (which keeps the max
 * weight), subject to the link condition, at least three triangles left around every vertex and a no-flip
 * test. Edges with other than two faces lock the vertices of those faces. Pure and deterministic; successive
 * `collapseTo` calls continue from the current state.
 */
export function createSimplifier(input: SimplifyInput): Simplifier {
  const n = input.positions.length / 3, F = input.indices.length / 3;
  const P = Float64Array.from(input.positions);
  const fv = Int32Array.from(input.indices);
  const fAlive = new Uint8Array(F).fill(1);
  const w = Float64Array.from(input.weight);
  const Q = new Float64Array(n * 10);
  let live = F;

  // faces around each vertex (only live ones: every list a dead face sits in is compacted at once)
  const deg = new Int32Array(n);
  for (let i = 0; i < fv.length; i++) deg[fv[i]]++;
  let maxDeg = 0;
  for (let v = 0; v < n; v++) maxDeg = Math.max(maxDeg, deg[v]);
  const vf = new Lists(deg, 2);
  for (let f = 0; f < F; f++) { vf.push(fv[f * 3], f); vf.push(fv[f * 3 + 1], f); vf.push(fv[f * 3 + 2], f); }

  // per-vertex quadrics: area-weighted plane quadrics of the faces around it, times the vertex weight
  for (let f = 0; f < F; f++) {
    const i0 = fv[f * 3], i1 = fv[f * 3 + 1], i2 = fv[f * 3 + 2];
    const x0 = P[i0 * 3], y0 = P[i0 * 3 + 1], z0 = P[i0 * 3 + 2];
    const ux = P[i1 * 3] - x0, uy = P[i1 * 3 + 1] - y0, uz = P[i1 * 3 + 2] - z0;
    const vx = P[i2 * 3] - x0, vy = P[i2 * 3 + 1] - y0, vz = P[i2 * 3 + 2] - z0;
    let a = uy * vz - uz * vy, b = uz * vx - ux * vz, c = ux * vy - uy * vx;
    const l = Math.hypot(a, b, c);
    if (l === 0) continue;
    a /= l; b /= l; c /= l;
    const d = -(a * x0 + b * y0 + c * z0), area = l / 2;
    for (let k = 0; k < 3; k++) {
      const o = fv[f * 3 + k] * 10;
      Q[o] += area * a * a; Q[o + 1] += area * a * b; Q[o + 2] += area * a * c; Q[o + 3] += area * a * d;
      Q[o + 4] += area * b * b; Q[o + 5] += area * b * c; Q[o + 6] += area * b * d;
      Q[o + 7] += area * c * c; Q[o + 8] += area * c * d; Q[o + 9] += area * d * d;
    }
  }
  for (let v = 0; v < n; v++) for (let k = 0; k < 10; k++) Q[v * 10 + k] *= w[v];

  // unique edges (lo < hi), ids in ascending lo then first appearance; non-two-face edges lock their faces
  const mark = new Int32Array(n), markS = new Int32Array(n), cnt = new Int32Array(n);
  let tag = 0;
  const locked = new Uint8Array(n);
  const ve = new Lists(deg, 2);
  const lo = new Int32Array(fv.length), hi = new Int32Array(fv.length), nb = new Int32Array(2 * maxDeg + 2);
  let E = 0;
  for (let v = 0; v < n; v++) {
    tag++;
    let nn = 0;
    const s = vf.start[v], l = vf.len[v], pool = vf.pool;
    for (let i = s; i < s + l; i++)
      for (let k = 0; k < 3; k++) {
        const x = fv[pool[i] * 3 + k];
        if (x <= v) continue;
        if (mark[x] !== tag) { mark[x] = tag; cnt[x] = 0; nb[nn++] = x; }
        cnt[x]++;
      }
    for (let j = 0; j < nn; j++) {
      const x = nb[j], id = E++;
      lo[id] = v; hi[id] = x; ve.push(v, id); ve.push(x, id);
      if (cnt[x] !== 2)
        for (let i = s; i < s + l; i++) {
          const o = pool[i] * 3;
          if (fv[o] === x || fv[o + 1] === x || fv[o + 2] === x) locked[fv[o]] = locked[fv[o + 1]] = locked[fv[o + 2]] = 1;
        }
    }
  }
  const ea = lo.slice(0, E), eb = hi.slice(0, E);
  const eAlive = new Uint8Array(E).fill(1), stamp = new Int32Array(E);
  const eCost = new Float64Array(E), eP = new Float64Array(E * 3);
  const eKey = new Float64Array(E).fill(NaN); // key of the edge's live heap entry; NaN = none

  // lazy 4-ary min-heap of (key, edge id, stamp), ordered by key then id. An entry whose stamp is behind its
  // edge's is stale and skipped. A live key may lag below the edge's cost (a rise is deferred until it is
  // popped, then re-pushed); every key stays ≤ its cost, so a popped key equal to its cost is the true minimum.
  let cap = Math.max(16, E * 2), hn = 0;
  let hc = new Float64Array(cap), hid = new Int32Array(cap), hst = new Int32Array(cap);
  const push = (e: number, c: number) => {
    if (hn === cap) {
      cap *= 2;
      const c = new Float64Array(cap), d = new Int32Array(cap), s = new Int32Array(cap);
      c.set(hc); d.set(hid); s.set(hst); hc = c; hid = d; hst = s;
    }
    eKey[e] = c;
    let i = hn++;
    while (i > 0) {
      const p = (i - 1) >> 2;
      if (hc[p] < c || (hc[p] === c && hid[p] < e)) break;
      hc[i] = hc[p]; hid[i] = hid[p]; hst[i] = hst[p]; i = p;
    }
    hc[i] = c; hid[i] = e; hst[i] = stamp[e];
  };
  const popTop = () => {
    const n1 = --hn;
    if (n1 === 0) return;
    const c = hc[n1], e = hid[n1], st = hst[n1];
    let i = 0;
    for (;;) {
      const f = 4 * i + 1;
      if (f >= n1) break;
      let m = f, mc = hc[f], me = hid[f];
      const l = Math.min(f + 4, n1);
      for (let k = f + 1; k < l; k++) {
        const kc = hc[k];
        if (kc < mc || (kc === mc && hid[k] < me)) { m = k; mc = kc; me = hid[k]; }
      }
      if (c < mc || (c === mc && e < me)) break;
      hc[i] = mc; hid[i] = me; hst[i] = hst[m]; i = m;
    }
    hc[i] = c; hid[i] = e; hst[i] = st;
  };

  /** Cost and target of edge e: Q_a + Q_b at a, b, the midpoint and (if well posed and near) the optimum. */
  const evalEdge = (e: number) => {
    const oa = ea[e] * 10, ob = eb[e] * 10;
    for (let k = 0; k < 10; k++) qs[k] = Q[oa + k] + Q[ob + k];
    const q0 = qs[0], q1 = qs[1], q2 = qs[2], q3 = qs[3], q4 = qs[4], q5 = qs[5], q6 = qs[6], q7 = qs[7], q8 = qs[8];
    const pa = ea[e] * 3, pb = eb[e] * 3;
    const ax = P[pa], ay = P[pa + 1], az = P[pa + 2], bx = P[pb], by = P[pb + 1], bz = P[pb + 2];
    const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
    const L2 = (bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2;
    let best = quadErr(qs, ax, ay, az), px = ax, py = ay, pz = az;
    let c = quadErr(qs, bx, by, bz);
    if (c < best) { best = c; px = bx; py = by; pz = bz; }
    c = quadErr(qs, mx, my, mz);
    if (c < best) { best = c; px = mx; py = my; pz = mz; }
    // optimum: [q0 q1 q2; q1 q4 q5; q2 q5 q7] v = -[q3 q6 q8], by Cramer's rule via cofactors
    const c00 = q4 * q7 - q5 * q5, c01 = q2 * q5 - q1 * q7, c02 = q1 * q5 - q2 * q4;
    const det = q0 * c00 + q1 * c01 + q2 * c02, tr = q0 + q4 + q7;
    if (Math.abs(det) > 1e-12 * tr * tr * tr) {
      const c11 = q0 * q7 - q2 * q2, c12 = q1 * q2 - q0 * q5, c22 = q0 * q4 - q1 * q1;
      const ox = -(c00 * q3 + c01 * q6 + c02 * q8) / det;
      const oy = -(c01 * q3 + c11 * q6 + c12 * q8) / det;
      const oz = -(c02 * q3 + c12 * q6 + c22 * q8) / det;
      // a nearly flat neighbourhood can put the optimum far away along the surface: keep it near the edge
      const dx = ox - mx, dy = oy - my, dz = oz - mz;
      if (dx * dx + dy * dy + dz * dz <= L2) {
        c = quadErr(qs, ox, oy, oz);
        if (c < best) { best = c; px = ox; py = oy; pz = oz; }
      }
    }
    best += REG * tr * L2;
    best *= Math.max(w[ea[e]], w[eb[e]]); // the weight counts twice: in the quadric and on the cost
    eCost[e] = best === best ? best : Infinity;
    eP[e * 3] = px; eP[e * 3 + 1] = py; eP[e * 3 + 2] = pz;
  };
  /** (Re)prices edge e and makes sure the heap holds a key ≤ its cost (locked edges stay out). */
  const enqueue = (e: number) => {
    if (locked[ea[e]] || locked[eb[e]]) return;
    evalEdge(e);
    const k = eKey[e];
    if (k !== k) push(e, eCost[e]);
    else if (eCost[e] < k) { stamp[e]++; push(e, eCost[e]); }
  };
  for (let e = 0; e < E; e++) enqueue(e);

  let tagA = 0; // mark[x] === tagA ⇔ x was a neighbour of a in the last link test
  /** Link condition: the common neighbours of a and b are exactly the third vertices of their two shared faces. */
  const linkOk = (a: number, b: number): boolean => {
    const tA = ++tag, tB = ++tag;
    tagA = tA;
    const pool = vf.pool, sa = vf.start[a], la = vf.len[a], sb = vf.start[b], lb = vf.len[b];
    let na = 0;
    for (let i = sa; i < sa + la; i++)
      for (let k = 0; k < 3; k++) {
        const x = fv[pool[i] * 3 + k];
        if (x !== a && mark[x] !== tA) { mark[x] = tA; na++; }
      }
    let shared = 0;
    for (let i = sb; i < sb + lb; i++) {
      const o = pool[i] * 3, i0 = fv[o], i1 = fv[o + 1], i2 = fv[o + 2];
      if (i0 === a || i1 === a || i2 === a) { shared++; markS[i0 + i1 + i2 - a - b] = tA; }
    }
    if (shared !== 2) return false;
    let nbOnly = 0;
    for (let i = sb; i < sb + lb; i++)
      for (let k = 0; k < 3; k++) {
        const x = fv[pool[i] * 3 + k];
        if (x === a || x === b) continue;
        if (mark[x] === tA) { if (markS[x] !== tA) return false; }
        else if (mark[x] !== tB) { mark[x] = tB; nbOnly++; }
      }
    return na - 1 + nbOnly >= 3; // never fold a tetrahedron flat
  };

  /**
   * Every vertex keeps at least three triangles: a and b merge into len(a) + len(b) − 4, and the third vertex of
   * each shared face loses one. Two triangles around a vertex are a zero-volume flap (two faces back to back).
   */
  const valenceOk = (a: number, b: number): boolean => {
    if (vf.len[a] + vf.len[b] - 4 < 3) return false;
    const pool = vf.pool, s = vf.start[b], l = vf.len[b];
    for (let i = s; i < s + l; i++) {
      const o = pool[i] * 3, i0 = fv[o], i1 = fv[o + 1], i2 = fv[o + 2];
      if ((i0 === a || i1 === a || i2 === a) && vf.len[i0 + i1 + i2 - a - b] - 1 < 3) return false;
    }
    return true;
  };

  /** No flips: every surviving face around v (without o) keeps its facing and some area when v moves to p. */
  const flipOk = (v: number, o: number, px: number, py: number, pz: number): boolean => {
    const pool = vf.pool, s = vf.start[v], l = vf.len[v];
    for (let i = s; i < s + l; i++) {
      const f = pool[i] * 3, i0 = fv[f], i1 = fv[f + 1], i2 = fv[f + 2];
      if (i0 === o || i1 === o || i2 === o) continue;
      const x0 = P[i0 * 3], y0 = P[i0 * 3 + 1], z0 = P[i0 * 3 + 2];
      const x1 = P[i1 * 3], y1 = P[i1 * 3 + 1], z1 = P[i1 * 3 + 2];
      const x2 = P[i2 * 3], y2 = P[i2 * 3 + 1], z2 = P[i2 * 3 + 2];
      let ux = x1 - x0, uy = y1 - y0, uz = z1 - z0, vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
      const ax = uy * vz - uz * vy, ay = uz * vx - ux * vz, az = ux * vy - uy * vx;
      // the same face with v at p
      const X0 = i0 === v ? px : x0, Y0 = i0 === v ? py : y0, Z0 = i0 === v ? pz : z0;
      ux = (i1 === v ? px : x1) - X0; uy = (i1 === v ? py : y1) - Y0; uz = (i1 === v ? pz : z1) - Z0;
      vx = (i2 === v ? px : x2) - X0; vy = (i2 === v ? py : y2) - Y0; vz = (i2 === v ? pz : z2) - Z0;
      const bx = uy * vz - uz * vy, by = uz * vx - ux * vz, bz = ux * vy - uy * vx;
      const o2 = ax * ax + ay * ay + az * az, n2 = bx * bx + by * by + bz * bz;
      if (o2 === 0) { if (!(n2 > 0)) return false; continue; }
      if (!(n2 > 1e-12 * o2) || ax * bx + ay * by + az * bz <= 0.2 * Math.sqrt(o2 * n2)) return false;
    }
    return true;
  };

  const thirds: number[] = [];
  /** Collapses b into a at p (after the link and flip tests passed; `tagA` marks a's old neighbours). */
  const collapse = (a: number, b: number, px: number, py: number, pz: number) => {
    P[a * 3] = px; P[a * 3 + 1] = py; P[a * 3 + 2] = pz;
    for (let k = 0; k < 10; k++) Q[a * 10 + k] += Q[b * 10 + k];
    w[a] = Math.max(w[a], w[b]);

    // faces: kill the shared ones, then move b's others to a
    thirds.length = 0;
    const fs = vf.start[b], fl = vf.len[b];
    for (let i = fs; i < fs + fl; i++) {
      const f = vf.pool[i], o = f * 3;
      if (fv[o] === a || fv[o + 1] === a || fv[o + 2] === a) {
        fAlive[f] = 0; live--;
        thirds.push(fv[o] + fv[o + 1] + fv[o + 2] - a - b);
      }
    }
    vf.compact(a, fAlive);
    for (const c of thirds) vf.compact(c, fAlive);
    for (let i = fs; i < fs + fl; i++) {
      const f = vf.pool[i], o = f * 3; // re-read: pushing to a can move the pool
      if (!fAlive[f]) continue;
      if (fv[o] === b) fv[o] = a; else if (fv[o + 1] === b) fv[o + 1] = a; else fv[o + 2] = a;
      vf.push(a, f);
    }
    vf.len[b] = 0;

    // edges: a-b dies, b-x dies where a-x exists (x is then a third vertex), other b-x become a-x
    const es = ve.start[b], el = ve.len[b];
    for (let i = es; i < es + el; i++) {
      const e = ve.pool[i], x = ea[e] === b ? eb[e] : ea[e];
      if (x === a || mark[x] === tagA) eAlive[e] = 0;
    }
    ve.compact(a, eAlive);
    for (const c of thirds) ve.compact(c, eAlive);
    for (let i = es; i < es + el; i++) {
      const e = ve.pool[i];
      if (!eAlive[e]) continue;
      const x = ea[e] === b ? eb[e] : ea[e];
      ea[e] = Math.min(a, x); eb[e] = Math.max(a, x);
      ve.push(a, e);
    }
    ve.len[b] = 0;
    const s = ve.start[a], l = ve.len[a];
    for (let i = s; i < s + l; i++) enqueue(ve.pool[i]);
  };

  return {
    get triangles() { return live; },
    collapseTo(target: number) {
      while (live > target && hn > 0) {
        const e = hid[0], st = hst[0], key = hc[0];
        popTop();
        if (!eAlive[e] || st !== stamp[e]) continue;
        if (eCost[e] > key) { push(e, eCost[e]); continue; } // a deferred rise: back in at its cost
        eKey[e] = NaN;
        const a = ea[e], b = eb[e];
        const px = eP[e * 3], py = eP[e * 3 + 1], pz = eP[e * 3 + 2];
        // a rejected edge stays out of the heap until one of its endpoints changes
        if (!linkOk(a, b) || !valenceOk(a, b) || !flipOk(a, b, px, py, pz) || !flipOk(b, a, px, py, pz)) continue;
        collapse(a, b, px, py, pz);
      }
    },
    snapshot(): Snapshot {
      const remap = new Int32Array(n).fill(-1);
      for (let f = 0; f < F; f++) if (fAlive[f]) for (let k = 0; k < 3; k++) remap[fv[f * 3 + k]] = 0;
      let m = 0;
      for (let v = 0; v < n; v++) if (remap[v] === 0) remap[v] = m++;
      const positions = new Float32Array(m * 3), source = new Uint32Array(m), indices = new Uint32Array(live * 3);
      for (let v = 0; v < n; v++) {
        const r = remap[v];
        if (r < 0) continue;
        source[r] = v;
        positions[r * 3] = P[v * 3]; positions[r * 3 + 1] = P[v * 3 + 1]; positions[r * 3 + 2] = P[v * 3 + 2];
      }
      for (let f = 0, t = 0; f < F; f++)
        if (fAlive[f]) { indices[t++] = remap[fv[f * 3]]; indices[t++] = remap[fv[f * 3 + 1]]; indices[t++] = remap[fv[f * 3 + 2]]; }
      return { positions, indices, source };
    },
  };
}
