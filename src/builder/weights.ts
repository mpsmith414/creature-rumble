import { dot, sub, type Vec3 } from '../util/vec';
import { CHEEK_SPAN, type MouthFrame } from './anatomy/face';
import { boneSdf, roundCone, thinAxis, tipRadius } from './sdf';
import type { BoneDef, Skeleton } from './skeleton';

export type SkinData = {
  skinIndex: Uint16Array; // 4 per vertex
  skinWeight: Float32Array; // 4 per vertex, summing to 1
  region: Float32Array; // index into the region list, per vertex
  partT: Float32Array; // 0..1 along the nearest bone, per vertex
  partS: Float32Array; // metres along the nearest bone, per vertex
  boneOf: Uint16Array; // nearest bone, per vertex
};

const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
/**
 * A bone's distance for weighting. A squashed bone's SDF shrinks distances by its squash (a fifth, for a flat ear) away
 * from it, which let ears and wings pull on skin far across the head; its round cone (which holds it) bounds it from below.
 */
const weighDistance = (p: Vec3, b: BoneDef, thin: Vec3) =>
  b.squash >= 0.999 ? boneSdf(p, b, thin) : Math.max(boneSdf(p, b, thin), roundCone(p, b.start, b.end, b.r0, tipRadius(b)));
/**
 * How much of a vertex's head-and-muzzle share `s` the jaw may take: all of it inside the head, little where another bone
 * leads (a quarter at an even split), so opening the mouth barely tugs the neck's or chest's skin.
 */
const pull = (s: number) => s * s;

/**
 * Attach each vertex to the bones whose surfaces are nearly as close as the nearest one.
 * Weights fall off over a band of half the nearest bone's radius, so joints bend smoothly
 * while the middle of a limb follows only its own bone. The jaw bone (`sk.jaw`, with the `mouth`
 * frame) takes no part in that: it takes over the head's and muzzle's pull below the mouth slit and
 * ahead of the hinge (see placeJaw).
 */
export function skinWeights(positions: Float32Array, sk: Skeleton, regions: string[], mouth?: MouthFrame | null): SkinData {
  const n = positions.length / 3;
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  const region = new Float32Array(n);
  const partT = new Float32Array(n);
  const partS = new Float32Array(n);
  const boneOf = new Uint16Array(n);
  const bones = sk.bones.map((b, i) => ({ b, i, thin: thinAxis(b) })).filter((x) => x.b.role !== 'eye' && !x.b.jaw);
  // the bones whose skin the jaw shares: the head and its muzzle (mouth) bones
  const jaw = mouth && sk.jaw >= 0 ? sk.jaw : -1, H = mouth ? sk.bones[mouth.head] : null, rH = H ? Math.max(H.r0, H.r1) : 0;
  const carried = sk.bones.map((b, i) => {
    if (jaw < 0 || b.jaw) return false;
    if (i === mouth!.head) return true;
    if (b.role !== 'mouth') return false;
    for (let p = b.parent; p >= 0; p = sk.bones[p].parent) if (p === mouth!.head) return true;
    return false;
  });
  const L = mouth ? Math.hypot(mouth.tip.x - mouth.hinge.x, mouth.tip.y - mouth.hinge.y, mouth.tip.z - mouth.hinge.z) : 0;
  /**
   * The jaw takes `j` of the pull of the head and its muzzle bones (so it fades out with them where the head blends into
   * the neck or the chest), fading in across the slit (a linear ramp: with the jaw raised by at most the slit's width at
   * rest, its lips close without folding the slit's side walls; CHEEK_SPAN times as far behind the lips' corner, where the
   * cheeks' skin stretches into the open mouth's dark membrane) and over 0.3 head radii behind the hinge, and fades out
   * below an upright face's chin (`mouth.chin`). It goes in an empty slot, else in the lightest shared slot (whose pull
   * joins another shared one), else (four bones, one shared) it takes that one's pull whole or not at all: the other bones
   * always keep their pull.
   */
  const placeJaw = (o: number, P: Float32Array, v: number) => {
    let share = 0, shared = 0, free = -1, lo = -1, heavy = -1;
    for (let k = o; k < o + 4; k++) {
      const w = skinWeight[k];
      if (w === 0) { if (free < 0) free = k; } else if (carried[skinIndex[k]]) {
        share += w; shared++;
        if (lo < 0 || w < skinWeight[lo]) lo = k;
      }
    }
    if (share === 0) return;
    const q = { x: P[v * 3] - mouth!.hinge.x, y: P[v * 3 + 1] - mouth!.hinge.y, z: P[v * 3 + 2] - mouth!.hinge.z }, h = mouth!.halfThick;
    const f = dot(q, mouth!.forward), span = 2 * h * (1 + (CHEEK_SPAN - 1) * (1 - smoothstep(mouth!.lips - 0.25 * L, mouth!.lips, f)));
    const u = dot(q, mouth!.up), below = Math.min(1, Math.max(0, (h - u) / span)) * (mouth!.chin < Infinity ? 1 - smoothstep(mouth!.chin, 2 * mouth!.chin, -u) : 1);
    let jw = below * smoothstep(-0.3 * rH, 0.1 * rH, f) * pull(share);
    if (jw <= 0) return;
    let slot = free;
    if (slot < 0 && shared >= 2) {
      slot = lo;
      for (let k = o; k < o + 4; k++) if (k !== lo && carried[skinIndex[k]] && (heavy < 0 || skinWeight[k] > skinWeight[heavy])) heavy = k;
    } else if (slot < 0) {
      // four bones and only one shared: the jaw cannot share it, so it takes it all, or none (whichever is nearer)
      if (jw < share / 2) return;
      slot = lo;
      jw = share;
    }
    const keep = 1 - jw / share;
    for (let k = o; k < o + 4; k++) if (carried[skinIndex[k]] && skinWeight[k] > 0) skinWeight[k] *= keep;
    if (heavy >= 0) skinWeight[heavy] += skinWeight[lo];
    skinIndex[slot] = jaw;
    skinWeight[slot] = jw;
    let sum = 0;
    for (let k = o; k < o + 4; k++) sum += skinWeight[k];
    for (let k = o; k < o + 4; k++) skinWeight[k] /= sum;
  };
  const regionIndex = new Map(regions.map((r, i) => [r, i]));
  const s = new Float64Array(sk.bones.length);
  const order: number[] = [];

  for (let v = 0; v < n; v++) {
    const p = { x: positions[v * 3], y: positions[v * 3 + 1], z: positions[v * 3 + 2] };
    let best = -1;
    for (const { b, i, thin } of bones) {
      s[i] = weighDistance(p, b, thin);
      if (best < 0 || s[i] < s[best]) best = i;
    }
    const nb = sk.bones[best];
    const band = 0.5 * Math.max(nb.r0, nb.r1);
    order.length = 0;
    for (const { i } of bones) if (s[i] < s[best] + band) order.push(i);
    order.sort((a, b) => s[a] - s[b]);
    let total = 0;
    const w = [0, 0, 0, 0];
    for (let k = 0; k < Math.min(4, order.length); k++) {
      const f = 1 - (s[order[k]] - s[best]) / band;
      w[k] = f * f;
      total += w[k];
    }
    for (let k = 0; k < 4; k++) {
      skinIndex[v * 4 + k] = k < order.length ? order[k] : 0;
      skinWeight[v * 4 + k] = w[k] / total;
    }
    if (jaw >= 0) placeJaw(v * 4, positions, v);
    boneOf[v] = best;
    region[v] = regionIndex.get(nb.region) ?? 0;
    const ab = sub(nb.end, nb.start);
    const l2 = dot(ab, ab);
    partT[v] = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, nb.start), ab) / l2)) : 0;
    partS[v] = partT[v] * Math.sqrt(l2);
  }
  return { skinIndex, skinWeight, region, partT, partS, boneOf };
}
