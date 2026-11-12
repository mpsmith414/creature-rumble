import type { BoneDef, Skeleton } from '../builder/skeleton';
import { bodyHeight } from '../fight/moves';
import { ringScale } from '../fight/scale';
import type { FightPlan } from '../fight/types';
import type { Role } from '../recipe/schema';
import { dist, scale as mul, type Vec3 } from '../util/vec';

export { ringScale };

export type SegmentKind = 'torso' | 'head' | 'arm' | 'hand' | 'leg' | 'foot' | 'wing' | 'tail' | 'other';

/** One rigid piece of the ragdoll (a capsule from `a` to `b`), in ring-scaled creature space. */
export type Segment = {
  id: number;
  kind: SegmentKind;
  bones: number[];
  parent: number; // -1 for the root
  a: Vec3;
  b: Vec3;
  radius: number;
  /** The joint point shared with the parent (the root's own `a`). */
  anchor: Vec3;
  weapon: boolean;
};

export type RagdollLayout = {
  segments: Segment[];
  scale: number;
  ringHeight: number;
  /** The root torso segment's centre height at rest. */
  standHeight: number;
  /** Bone index → segment id. */
  boneSegment: number[];
};

export const MAX_SEGMENTS = 24;
/** A chain of same-kind bones longer than this is grouped into at most this many segments. */
const MAX_CHAIN = 3;
/** Bones shorter than this × the body's height merge into their parent's segment. */
const SHORT = 0.08;
/** Roles whose bones never get a segment of their own. */
const MERGED: readonly Role[] = ['eye', 'ear', 'horn', 'antenna', 'mouth', 'other'];
/** Short bones of these roles (and weapons) still keep a segment: a small head or hand is still a head or hand. */
const KEEP_SHORT: readonly Role[] = ['head', 'hand', 'foot'];
const MIN_SQUASH = 0.35;

const KIND: Record<Role, SegmentKind> = {
  torso: 'torso', head: 'head', neck: 'head', arm: 'arm', hand: 'hand', leg: 'leg', foot: 'foot', wing: 'wing',
  tail: 'tail', fin: 'other', horn: 'other', antenna: 'other', ear: 'other', eye: 'other', mouth: 'other', other: 'other',
};

/** A bone's thickness: its larger end radius, thinned by squash (the builder flattens squashed parts). */
const boneRadius = (b: BoneDef) => Math.max(b.r0, b.r1) * Math.max(b.squash, MIN_SQUASH);

type Proto = { kind: SegmentKind; main: number[]; extra: number[]; parent: number; neck: boolean };

export function ragdollLayout(sk: Skeleton, plan: FightPlan): RagdollLayout {
  const H = bodyHeight(sk);
  const s = ringScale(H);
  const weaponParts = new Set(plan.weapons);
  const bones = sk.bones;

  // 1. one proto-segment per bone, except the bones that merge into the segment they grow from
  const protos: Proto[] = [];
  const boneProto: number[] = [];
  bones.forEach((b, i) => {
    const pp = b.parent >= 0 ? boneProto[b.parent] : -1;
    const short = dist(b.start, b.end) < SHORT * H && !KEEP_SHORT.includes(b.role) && !weaponParts.has(b.partId);
    if (pp >= 0 && (MERGED.includes(b.role) || short)) {
      protos[pp].extra.push(i);
      boneProto.push(pp);
      return;
    }
    // a neck and the head it carries are one segment
    if (pp >= 0 && b.role === 'head' && protos[pp].neck) {
      protos[pp].main.push(i);
      protos[pp].neck = false;
      boneProto.push(pp);
      return;
    }
    protos.push({ kind: KIND[b.role], main: [i], extra: [], parent: pp, neck: b.role === 'neck' });
    boneProto.push(protos.length - 1);
  });

  const alive = protos.map(() => true);
  const rep = protos.map((_, i) => i); // a proto folded into another points at it
  const find = (i: number): number => (rep[i] === i ? i : (rep[i] = find(rep[i])));
  // A straight continuation of the parent's chain extends its capsule; a side branch only rides along (bones, weapon).
  const fold = (child: number, into: number, straight: boolean) => {
    if (straight) protos[into].main.push(...protos[child].main);
    else protos[into].extra.push(...protos[child].main);
    protos[into].extra.push(...protos[child].extra);
    alive[child] = false;
    rep[child] = into;
  };
  const kids = (i: number) => protos.flatMap((p, j) => (alive[j] && find(p.parent) === i && p.parent >= 0 && j !== i ? [j] : []));

  // 2. long single-file chains of one kind (tails, long necks) become at most three segments
  const continues = (p: number, c: number) =>
    protos[p].kind === protos[c].kind && protos[p].kind !== 'torso' && kids(p).length === 1 && kids(p)[0] === c;
  for (let i = 0; i < protos.length; i++) {
    if (!alive[i]) continue;
    const par = protos[i].parent >= 0 ? find(protos[i].parent) : -1;
    if (par >= 0 && continues(par, i)) continue; // not the start of a chain
    const chain = [i];
    for (let c = kids(i)[0]; c !== undefined && continues(chain[chain.length - 1], c); c = kids(c)[0]) chain.push(c);
    if (chain.length <= MAX_CHAIN) continue;
    const per = chain.length / MAX_CHAIN;
    for (let g = 0; g < MAX_CHAIN; g++) {
      const lo = Math.round(g * per), hi = Math.round((g + 1) * per);
      for (let k = lo + 1; k < hi; k++) fold(chain[k], chain[lo], true);
    }
  }

  // 3. still too many: fold the smallest leaves into their parents
  const size = (i: number) => {
    const p = protos[i];
    const len = p.main.reduce((t, bi) => t + dist(bones[bi].start, bones[bi].end), 0);
    return len * Math.max(...p.main.map((bi) => boneRadius(bones[bi])));
  };
  while (alive.filter(Boolean).length > MAX_SEGMENTS) {
    let best = -1;
    for (let i = 1; i < protos.length; i++) {
      if (!alive[i] || kids(i).length) continue;
      if (best < 0 || size(i) < size(best)) best = i;
    }
    const into = find(protos[best].parent);
    fold(best, into, protos[into].kind !== 'torso' && kids(into).length === 1);
  }

  // 4. numbering (parents come before children, so the root stays first)
  const ids = new Map<number, number>();
  protos.forEach((_, i) => { if (alive[i]) ids.set(i, ids.size); });
  const segments: Segment[] = [];
  protos.forEach((p, i) => {
    if (!alive[i]) return;
    const first = bones[Math.min(...p.main)], last = bones[Math.max(...p.main)];
    const all = [...p.main, ...p.extra].sort((x, y) => x - y);
    const a = mul(first.start, s);
    segments.push({
      id: ids.get(i)!,
      kind: p.kind,
      bones: all,
      parent: p.parent >= 0 ? ids.get(find(p.parent))! : -1,
      a,
      b: mul(last.end, s),
      radius: Math.max(...p.main.map((bi) => boneRadius(bones[bi]))) * s,
      anchor: a,
      weapon: all.some((bi) => weaponParts.has(bones[bi].partId)),
    });
  });
  const boneSegment = bones.map((_, bi) => ids.get(find(boneProto[bi]))!);
  const root = segments[0];
  return { segments, scale: s, ringHeight: H * s, standHeight: ((root.a.y + root.b.y) / 2), boneSegment };
}
