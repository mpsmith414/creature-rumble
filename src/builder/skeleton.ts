import type { FlatFacing, Recipe, Role } from '../recipe/schema';
import { add, lerp, scale, v3, type Vec3 } from '../util/vec';
import { thinAxis, tipRadius } from './sdf';

/** One bone in the rest pose, in creature space (metres). */
export type BoneDef = {
  name: string;
  partId: string;
  mirrored: boolean;
  parent: number; // -1 for the root
  role: Role;
  region: string;
  start: Vec3;
  end: Vec3;
  r0: number;
  r1: number;
  squash: number;
  flatFacing: FlatFacing;
  pointed: boolean;
  depth: number;
  /** The lower jaw (added by the builder after meshing; it shapes nothing, it only carries skin). */
  jaw?: true;
};

/** `jaw`: the jaw bone's index, −1 when there is none. */
export type Skeleton = { bones: BoneDef[]; contacts: number[]; min: Vec3; max: Vec3; jaw: number };

const flipX = (v: Vec3): Vec3 => ({ x: -v.x, y: v.y, z: v.z });

/**
 * Turn the part tree into bones. A mirrored part makes two bones (the copy has x flipped);
 * everything that grows from a mirrored part is mirrored with it, attached to its own side.
 */
export function expandParts(recipe: Recipe): BoneDef[] {
  const bones: BoneDef[] = [];
  const instances = new Map<string, number[]>(); // partId → bone indices [as given, mirror copy?]

  const make = (pi: number, parentIndex: number, mirrored: boolean): number => {
    const p = recipe.parts[pi];
    const par = parentIndex >= 0 ? bones[parentIndex] : null;
    const offset = mirrored ? flipX(p.offset) : p.offset;
    const dir = mirrored ? flipX(p.dir) : p.dir;
    const base = par ? lerp(par.start, par.end, p.attach) : v3();
    const start = add(base, offset);
    bones.push({
      name: mirrored ? `${p.id}~m` : p.id,
      partId: p.id,
      mirrored,
      parent: parentIndex,
      role: p.role,
      region: p.region,
      start,
      end: add(start, scale(dir, p.length)),
      r0: p.r0,
      r1: p.r1,
      squash: p.squash,
      flatFacing: p.flatFacing,
      pointed: p.pointed,
      depth: par ? par.depth + 1 : 0,
    });
    return bones.length - 1;
  };

  recipe.parts.forEach((p, pi) => {
    if (p.parent === null) {
      instances.set(p.id, [make(pi, -1, false)]);
      return;
    }
    const parents = instances.get(p.parent)!;
    if (parents.length === 2) {
      // inside a mirrored limb: one bone per side
      instances.set(p.id, [make(pi, parents[0], bones[parents[0]].mirrored), make(pi, parents[1], bones[parents[1]].mirrored)]);
    } else if (p.mirror) {
      instances.set(p.id, [make(pi, parents[0], false), make(pi, parents[0], true)]);
    } else {
      instances.set(p.id, [make(pi, parents[0], bones[parents[0]].mirrored)]);
    }
  });
  return bones;
}

const isLimb = (r: Role) => r === 'leg' || r === 'foot';

/** The bones that touch the ground: the tip of every leg chain, else the torso bones, else the root. */
export function contactBones(bones: BoneDef[]): number[] {
  const tips: number[] = [];
  bones.forEach((b, i) => {
    if (b.role !== 'leg' || (b.parent >= 0 && isLimb(bones[b.parent].role))) return;
    let cur = i;
    for (;;) {
      const next = bones.findIndex((c) => c.parent === cur && isLimb(c.role));
      if (next < 0) break;
      cur = next;
    }
    tips.push(cur);
  });
  if (tips.length) return tips;
  const torso = bones.flatMap((b, i) => (b.role === 'torso' ? [i] : []));
  return torso.length ? torso : [0];
}

/** A bone's lowest surface point as the builder shapes it: its end balls (a pointed tip's small one), squashed along the thin axis. */
export function lowPoint(b: BoneDef): number {
  const k = b.squash >= 0.999 ? 1 : Math.sqrt(1 - (1 - b.squash ** 2) * thinAxis(b).y ** 2);
  return Math.min(b.start.y - b.r0 * k, b.end.y - tipRadius(b) * k);
}

/** Bones this close to the ground (× the body's height) touch it. */
const TOUCH = 0.05;

/**
 * Stand the creature up: its lowest point (any bone) touches y = 0 and its support centre is at x = z = 0. The
 * contacts are the leg tips (else the torso) while they touch the ground; when something else hangs lower (a body
 * stood on end whose legs stick out sideways), they are whichever bones touch it.
 */
export function groundFit(input: BoneDef[]): { bones: BoneDef[]; contacts: number[] } {
  const lows = input.map(lowPoint);
  const ground = Math.min(...lows);
  const top = Math.max(...input.map((b) => Math.max(b.start.y + b.r0, b.end.y + b.r1)));
  const touch = ground + TOUCH * (top - ground);
  const limbs = contactBones(input);
  const contacts = Math.min(...limbs.map((i) => lows[i])) <= touch ? limbs : lows.flatMap((l, i) => (l <= touch ? [i] : []));
  const dy = -ground;
  const cx = contacts.reduce((s, i) => s + input[i].end.x, 0) / contacts.length;
  const cz = contacts.reduce((s, i) => s + input[i].end.z, 0) / contacts.length;
  const shift = v3(Math.abs(cx) < 1e-9 ? 0 : -cx, dy, -cz);
  const bones = input.map((b) => ({ ...b, start: add(b.start, shift), end: add(b.end, shift) }));
  return { bones, contacts };
}

export function buildSkeleton(recipe: Recipe): Skeleton {
  const { bones, contacts } = groundFit(expandParts(recipe));
  const min = v3(Infinity, Infinity, Infinity);
  const max = v3(-Infinity, -Infinity, -Infinity);
  for (const b of bones) {
    const r = Math.max(b.r0, b.r1);
    for (const p of [b.start, b.end]) {
      min.x = Math.min(min.x, p.x - r); min.y = Math.min(min.y, p.y - r); min.z = Math.min(min.z, p.z - r);
      max.x = Math.max(max.x, p.x + r); max.y = Math.max(max.y, p.y + r); max.z = Math.max(max.z, p.z + r);
    }
  }
  return { bones, contacts, min, max, jaw: -1 };
}
