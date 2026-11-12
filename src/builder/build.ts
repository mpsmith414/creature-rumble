import type { Recipe } from '../recipe/schema';
import { hash } from '../util/hash';
import { mulberry32 } from '../util/rng';
import { scale, sub, type Vec3 } from '../util/vec';
import { anatomy, anatomyBounds, type Anatomy } from './anatomy';
import { noseRadius, type MouthFrame } from './anatomy/face';
import { marksAt, type Feature } from './anatomy/shapes';
import { importance } from './importance';
import { splitNonManifold, surfaceNetsSparse, type MeshData, type Sdf } from './mesher';
import { bodySdf, coarseBodySdf } from './sdf';
import { createSimplifier, type Snapshot } from './simplify';
import { buildSkeleton, type BoneDef, type Skeleton } from './skeleton';
import { sampleSparse } from './sparse';
import { cavityField } from './cavity';
import { skinWeights } from './weights';

/** Fine sampling: cells along the creature's longest dimension (only near the surface). */
export const FINE_CELLS = 330;
/** Bulky bodies sample more coarsely than FINE_CELLS so the raw mesh stays near this many vertices (build time). */
export const MAX_RAW_VERTICES = 110_000;
/**
 * LOD0 budget relative to a 110-cell mesh of the same body (its surface area over the 110-cell size squared, two
 * triangles a cell); LOD1 and LOD2 are ¼ and 1/16 of LOD0. The anatomy adds surface (a frog's webbed feet doubled it), so
 * LOD0 is also capped at LOD0_CAP times what the old builder gave: the bones alone (no anatomy) meshed at the estimate's
 * cells, scaled to 110 cells (within 5% of the old builder's counts, the hawk's 19% under).
 */
export const LOD0_CELLS = 110, LOD0_BUDGET = 1.2, LOD0_CAP = 1.3;
/** Cells along the longest dimension of the quick pass that estimates the surface before fine sampling. */
const ESTIMATE_CELLS = 64;

export type LodMesh = MeshData & { skinIndex: Uint16Array; skinWeight: Float32Array; region: Float32Array; partT: Float32Array; partS: Float32Array; boneOf: Uint16Array; feature: Float32Array /* 4 per vertex: nose, earInner, mouth, hoof (0…1) */;
  /** 4 per vertex: xyz unused (zero; there is no fur), and the cavity (w: 1 open … 0.25 deep). */
  groom: Float32Array };
/**
 * `mouth`: where the mouth opens (null without a head); `jawLift`: how far the jaw rises along the mouth's up at rest
 * to shut the carved slit (metres, 0 without a jaw).
 */
export type BodyData = { key: string; skeleton: Skeleton; regions: string[]; lods: LodMesh[]; mouth: MouthFrame | null; jawLift: number };
/** Where a build's time went, in ms (filled in by `buildBody` when passed; for tools/perf.ts). */
export type BuildTimes = { sample: number; mesh: number; weigh: number; simplify: number; snap: number; skin: number; rawVertices: number; maxSnap: number /* fine cells */ };

/** The key that decides whether two recipes share a body (shape, build, face shape, eye size, diet: the mouth's length, and region layout). */
export const bodyKey = (recipe: Recipe) =>
  hash(recipe.parts) + hash(recipe.skin.regions.map((r) => r.id)) + hash([recipe.build, recipe.face.nose, recipe.face.brow, recipe.skin.eyes.size, recipe.mind.preyMax > 0]);

/**
 * Fine cell for a body: FINE_CELLS along its longest side, coarser when the surface would exceed MAX_RAW_VERTICES.
 * The estimate meshes `sdf`, the body with its anatomy at the finest detail, so the features' area counts too.
 */
function fineCell(sk: Skeleton, sdf: Sdf, anat: Anatomy, longest: number): number {
  const c = longest / ESTIMATE_CELLS, { min, max } = anatomyBounds(sk, anat);
  const n = surfaceNetsSparse(sampleSparse(sdf, min, max, c, 4, coarseBodySdf(sk, anat, c))).positions.length / 3;
  return Math.max(longest / FINE_CELLS, c * Math.sqrt(n / MAX_RAW_VERTICES)); // vertices scale as 1 / cell²
}

/** Triangles a 110-cell mesh of the bones alone (no anatomy) would have: meshed at ESTIMATE_CELLS, scaled by cells². */
export function bareTriangles(sk: Skeleton): number {
  const longest = Math.max(sk.max.x - sk.min.x, sk.max.y - sk.min.y, sk.max.z - sk.min.z), c = longest / ESTIMATE_CELLS;
  const n = surfaceNetsSparse(sampleSparse(bodySdf(sk), sk.min, sk.max, c, 4, coarseBodySdf(sk, undefined, c))).positions.length / 3;
  return 2 * n * (LOD0_CELLS / ESTIMATE_CELLS) ** 2;
}

/**
 * The body's fine field: the cell (FINE_CELLS, or coarser under the vertex cap), the anatomy at that detail,
 * its SDF, and the sparse samples over its bounds (add features can reach past the bones).
 */
export function sampleBody(skeleton: Skeleton, recipe: Recipe) {
  const longest = Math.max(skeleton.max.x - skeleton.min.x, skeleton.max.y - skeleton.min.y, skeleton.max.z - skeleton.min.z);
  // anatomy at the finest detail for the estimate; rebuilt at the chosen cell when the vertex cap coarsens it
  const finest = anatomy(skeleton, recipe, { cell: longest / FINE_CELLS });
  const fine = fineCell(skeleton, bodySdf(skeleton, finest), finest, longest);
  const anat = fine === longest / FINE_CELLS ? finest : anatomy(skeleton, recipe, { cell: fine });
  const sdf = bodySdf(skeleton, anat);
  const { min, max } = anatomyBounds(skeleton, anat);
  return { longest, fine, anat, sdf, field: sampleSparse(sdf, min, max, fine, 4, coarseBodySdf(skeleton, anat, fine)) };
}

/**
 * The skeleton with the lower jaw hung on the head: one bone from the mouth hinge to just under the tip, appended (every
 * other bone keeps its index). It shapes nothing (the body is meshed without it); it only carries the skin below the slit.
 */
export function addJaw(sk: Skeleton, mouth: MouthFrame): Skeleton {
  const H = sk.bones[mouth.head], M = mouth.mouth >= 0 ? sk.bones[mouth.mouth] : null;
  const jaw: BoneDef = {
    name: `${H.name}~jaw`, partId: H.partId, mirrored: false, parent: mouth.head, role: 'mouth', region: (M ?? H).region,
    start: { ...mouth.hinge }, end: sub(mouth.tip, scale(mouth.up, mouth.halfThick)), r0: 0.6 * Math.max(H.r0, H.r1), r1: 0.6 * noseRadius(H, M),
    squash: 1, flatFacing: 'up', pointed: false, depth: H.depth + 1, jaw: true,
  };
  return { ...sk, bones: [...sk.bones, jaw], jaw: sk.bones.length };
}

/**
 * How far the jaw rises at rest to shut the mouth: the slit is an even 2·halfThick across, so lifting the jaw by nearly
 * that much (rather than turning it, which shuts only the tip and leaves a wedge open at the corners) brings the lips
 * together all along it, and the slit reads as a dark line. Not all of it: the jaw's pull ramps in across the slit, so
 * the slit's side walls squeeze to a twentieth of their height (the full width would flatten them, more would fold them).
 */
export const jawLift = (m: MouthFrame) => 0.95 * 2 * m.halfThick;

/** Below this gradient length the SDF is unreliable (inside a part thinner than the difference step). */
const WEAK_GRADIENT = 0.5;

/**
 * Moves each vertex towards the surface with one Newton step (p -= d·∇d/|∇d|², central differences with
 * step h), at most `maxStep` and never where the gradient is weak, then gives it the normalised gradient
 * there as its normal, or the area-weighted normal of its triangles where the gradient is weak or disagrees
 * with them (thin parts). Every normal has unit length. Changes `positions` in place; returns the normals and the longest step taken.
 */
export function snapToSurface(sdf: Sdf, positions: Float32Array, indices: Uint32Array, h: number, maxStep: number) {
  const normals = new Float32Array(positions.length);
  const i2h = 1 / (2 * h);
  const grad = (x: number, y: number, z: number, g: Vec3) => {
    g.x = (sdf(x + h, y, z) - sdf(x - h, y, z)) * i2h;
    g.y = (sdf(x, y + h, z) - sdf(x, y - h, z)) * i2h;
    g.z = (sdf(x, y, z + h) - sdf(x, y, z - h)) * i2h;
  };
  const g = { x: 0, y: 0, z: 0 };
  let longest = 0;
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v], y = positions[v + 1], z = positions[v + 2];
    const d = sdf(x, y, z);
    grad(x, y, z, g);
    const gl = Math.hypot(g.x, g.y, g.z);
    if (gl < WEAK_GRADIENT) continue;
    const step = Math.min(Math.abs(d) / gl, maxStep); // |d|/|∇d| is the Newton step's length
    const k = (Math.sign(d) * step) / gl;
    positions[v] = x - g.x * k; positions[v + 1] = y - g.y * k; positions[v + 2] = z - g.z * k;
    longest = Math.max(longest, step);
  }
  // area-weighted triangle normals (the cross product's length is twice the area), and the total area
  const area = new Float64Array(positions.length), total = new Float64Array(positions.length / 3);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    area[a] += fx; area[a + 1] += fy; area[a + 2] += fz;
    area[b] += fx; area[b + 1] += fy; area[b + 2] += fz;
    area[c] += fx; area[c + 1] += fy; area[c + 2] += fz;
    const fl = Math.hypot(fx, fy, fz);
    total[a / 3] += fl; total[b / 3] += fl; total[c / 3] += fl;
  }
  for (let v = 0; v < positions.length; v += 3) {
    grad(positions[v], positions[v + 1], positions[v + 2], g);
    const ax = area[v], ay = area[v + 1], az = area[v + 2], gl = Math.hypot(g.x, g.y, g.z);
    // triangles that cancel out (a fold) say nothing: then the gradient, however weak, else straight up
    const flat = Math.hypot(ax, ay, az) <= 1e-6 * total[v / 3];
    const useGrad = flat ? gl > 1e-9 : gl >= WEAK_GRADIENT && g.x * ax + g.y * ay + g.z * az >= 0;
    const nx = useGrad ? g.x : flat ? 0 : ax, ny = useGrad ? g.y : flat ? 1 : ay, nz = useGrad ? g.z : flat ? 0 : az;
    const l = Math.hypot(nx, ny, nz);
    normals[v] = nx / l; normals[v + 1] = ny / l; normals[v + 2] = nz / l;
  }
  return { normals, longest };
}

/**
 * The colour marks per vertex (4 lanes, MARKS order) from the features that carry one. Uses `normals` when given, else
 * the SDF's normalised gradient (central differences, step h), taken only where a mark can reach.
 */
export function featureMarks(features: Feature[], positions: Float32Array, normals: Float32Array | null, sdf: Sdf, h: number): Float32Array {
  const marked = features.filter((f) => f.mark), n = positions.length / 3;
  const out = new Float32Array(n * 4), p = { x: 0, y: 0, z: 0 }, g = { x: 0, y: 1, z: 0 };
  for (let v = 0; v < n; v++) {
    const x = (p.x = positions[v * 3]), y = (p.y = positions[v * 3 + 1]), z = (p.z = positions[v * 3 + 2]);
    if (!marked.some((f) => x >= f.min.x && y >= f.min.y && z >= f.min.z && x <= f.max.x && y <= f.max.y && z <= f.max.z)) continue;
    if (normals) { g.x = normals[v * 3]; g.y = normals[v * 3 + 1]; g.z = normals[v * 3 + 2]; } else {
      const gx = sdf(x + h, y, z) - sdf(x - h, y, z), gy = sdf(x, y + h, z) - sdf(x, y - h, z), gz = sdf(x, y, z + h) - sdf(x, y, z - h);
      const l = Math.hypot(gx, gy, gz);
      if (l > 0) { g.x = gx / l; g.y = gy / l; g.z = gz / l; } else { g.x = 0; g.y = 1; g.z = 0; }
    }
    marksAt(marked, p, g, out, v * 4);
  }
  return out;
}

/**
 * Recipe → a skinned body at each level of detail. Pure and deterministic. The body is sampled finely near
 * its surface, meshed, then simplified (more detail kept on faces, feet and joints) down to each LOD's budget;
 * every LOD comes from the same collapse chain, so asking for one LOD gives what the full set would. Each vertex
 * carries its colour marks (nose, inner ear, mouth, hoof) for the skin material.
 */
export function buildBody(recipe: Recipe, lods: readonly number[] = [0, 1, 2], times?: BuildTimes): BodyData {
  let t = performance.now();
  const lap = (k: keyof BuildTimes) => { const now = performance.now(); if (times) times[k] += now - t; t = now; };
  const skeleton = buildSkeleton(recipe);
  const regions = recipe.skin.regions.map((r) => r.id);
  const { longest, fine, anat, sdf, field } = sampleBody(skeleton, recipe);
  lap('sample');
  const raw = splitNonManifold(surfaceNetsSparse(field));
  const rawVertices = raw.positions.length / 3;
  if (times) times.rawVertices = rawVertices;
  lap('mesh');

  const weight = importance(skeleton, raw.positions, featureMarks(anat.features, raw.positions, null, sdf, fine / 2));
  lap('weigh');
  const area = rawVertices * fine * fine;
  const lod0 = Math.round(Math.min((LOD0_BUDGET * 2 * area) / (longest / LOD0_CELLS) ** 2, LOD0_CAP * bareTriangles(skeleton)));
  const budget = [lod0, Math.round(lod0 / 4), Math.round(lod0 / 16)];
  const simplifier = createSimplifier({ ...raw, weight });
  const snaps = new Map<number, Snapshot>();
  for (const l of [...new Set(lods)].sort((a, b) => a - b)) {
    simplifier.collapseTo(budget[l]);
    snaps.set(l, simplifier.snapshot());
  }
  lap('simplify');

  // the jaw joins after meshing (bones shape the body; the jaw only carries skin)
  const rig = anat.mouth ? addJaw(skeleton, anat.mouth) : skeleton;
  // The cavity is measured once, on the finest requested LOD, with the exact body SDF (the frog's full build stays
  // under the 3 s limit with it; `coarseBodySdf` and `steps = 3` were not needed), then inherited: a coarser vertex
  // takes the value of the input (raw) vertex it kept. So LODs are built finest first, whatever order they are asked in.
  const made = new Map<number, LodMesh>(), cavityOf = new Map<number, number>();
  for (const l of [...new Set(lods)].sort((a, b) => a - b)) {
    const { positions, indices, source } = snaps.get(l)!;
    const { normals, longest: step } = snapToSurface(sdf, positions, indices, fine / 2, fine);
    if (times) times.maxSnap = Math.max(times.maxSnap, step / fine);
    lap('snap');
    const skin = skinWeights(positions, rig, regions, anat.mouth);
    lap('skin');
    // the cavity (w)
    const n = positions.length / 3, groom = new Float32Array(n * 4);
    const own = cavityOf.size ? null : cavityField(positions, normals, skin.boneOf, skin.partT, rig, sdf);
    for (let v = 0; v < n; v++) {
      let c = own ? own[v] : cavityOf.get(source[v]);
      if (c === undefined) { // not alive in the finest LOD (should not happen): measure it here
        const one = (a: Float32Array, k: number) => a.subarray(v * k, v * k + k);
        c = cavityField(one(positions, 3), one(normals, 3), skin.boneOf.subarray(v, v + 1), skin.partT.subarray(v, v + 1), rig, sdf)[0];
      }
      groom[v * 4 + 3] = c;
      if (own) cavityOf.set(source[v], c);
    }
    lap('skin'); // the cavity counts with the skin
    made.set(l, { positions, normals, indices, ...skin, feature: featureMarks(anat.features, positions, normals, sdf, fine / 2), groom });
  }
  const given = new Set<number>();
  const meshes = lods.map((l): LodMesh => {
    const mesh = made.get(l)!;
    if (!given.has(l)) { given.add(l); return mesh; }
    // a repeated LOD gets its own arrays (the worker transfers each buffer once)
    return Object.fromEntries(Object.entries(mesh).map(([k, a]) => [k, a.slice()])) as LodMesh;
  });
  return { key: bodyKey(recipe), skeleton: rig, regions, lods: meshes, mouth: anat.mouth, jawLift: anat.mouth ? jawLift(anat.mouth) : 0 };
}

export type Variation = { boneScale: number[]; tint: { h: number; s: number; l: number } };

/**
 * How one individual differs from its species, with no rebuild: a size (from the
 * life.sizeM inheritance spread), a small per-part length jitter shared by mirrored
 * pairs, and a slight colour shift. Seed 0 is the species' own look.
 */
export function individualVariation(recipe: Recipe, seed: number, boneCount: number, partOfBone: string[]): Variation {
  if (seed === 0) return { boneScale: new Array(boneCount).fill(1), tint: { h: 0, s: 0, l: 0 } };
  const rng = mulberry32(seed);
  const spread = recipe.inheritance.find((t) => t.path === 'life.sizeM')?.spread ?? 0;
  const size = 1 + (rng() * 2 - 1) * spread;
  const jitter = new Map<string, number>();
  for (const p of recipe.parts) jitter.set(p.id, 1 + (rng() * 2 - 1) * spread * 0.5);
  const tint = { h: (rng() * 2 - 1) * 0.02, s: (rng() * 2 - 1) * 0.05, l: (rng() * 2 - 1) * 0.05 };
  return { boneScale: partOfBone.map((id) => size * (jitter.get(id) ?? 1)), tint };
}
