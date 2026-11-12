import { expandParts } from '../builder/skeleton';
import { cross, dot, norm, sub, scale, type Vec3 } from '../util/vec';
import { normalizeRecipe } from './normalize';
import type { Part, Recipe } from './schema';

/** A root growing with less than this much +y lies flat (a snake, a fish, a quadruped's body). */
const FLAT = 0.5;
/** The stubby arm a fighter is given when it has none (× the length of the torso chain it hangs from, and its top part's end radius). */
const ARM_LENGTH = 0.35, ARM_R0 = 0.3, ARM_TAPER = 0.8, ARM_AT = 0.85;
/** Its hand: a ball 1.4 × the arm's end radius. */
const HAND_R = 1.4, HAND_LENGTH = 0.5;
/** Arms hang down, a little out to the side and forward. */
const ARM_DIR = norm({ x: 0.4, y: -1, z: 0.15 });

const NECK_OR_HEAD = (p: Part) => p.role === 'neck' || p.role === 'head';

/** Limbs that keep the direction they were drawn in when the body they grow from rears up. */
const LIMB = new Set<Part['role']>(['leg', 'foot', 'arm', 'hand', 'tail']);
/** A leg chain starting this far (× the torso chain's height) above the lowest one is a front leg: it becomes an arm. */
const FRONT_LEG = 0.2;
/** A front leg turned arm hangs out from the side at least this much (x against the rest of its direction). */
const ARM_OUT = 0.4;

const freeId = (parts: Part[], want: string) => {
  let id = want;
  for (let n = 2; parts.some((p) => p.id === id); n++) id = `${want}_${n}`;
  return id;
};

/**
 * Rear the torso up so the root grows straight up (+y), like an animal standing on its hind legs: the old back now
 * faces backwards (−z) and the belly forwards; for a root along ±z this is a pure turn about x (offsets and directions
 * are creature-space vectors, so turning them turns the body about the root's start). Only the body turns: the torso
 * chain and what sits on its surface (wings, fins, ears, spikes). What reaches away from it keeps the direction it was
 * drawn in, so a long creature is not squashed into a tall stack:
 * - each neck or head chain (with its eyes, mouth, ears, horns), start offset included, so the face looks forward (+z)
 *   and a long neck or snout still reaches out as drawn;
 * - legs, arms and tails growing from the body (their start turns with the body, so it stays on the same spot of its
 *   surface): the hind legs reach down to the ground and a tail still reaches back behind. A creature with no legs on
 *   its body (a fish) stands on its tail instead, so there the tail rears with the body, as the spec pictures it.
 * Returns the ids of the torso chain.
 */
function standUp(parts: Part[], along: Vec3): Set<string> {
  const f = norm(along);
  const back = norm(sub(scale(f, f.y), { x: 0, y: 1, z: 0 })); // the old down, square to the root (|f.y| < FLAT, so never zero): the new +z
  const s = cross(f, back); // (s, f, back) is right-handed, so this is a rotation, not a mirror
  const turn = (v: Vec3): Vec3 => ({ x: dot(v, s), y: dot(v, f), z: dot(v, back) });
  const byId = new Map(parts.map((p) => [p.id, p]));
  const parentOf = (p: Part) => (p.parent === null ? undefined : byId.get(p.parent));
  // the torso chain: the root and every torso part joined to it through torso parts
  const torso = new Set<string>();
  for (const p of parts) {
    let q: Part | undefined = p;
    while (q && q.parent !== null && q.role === 'torso') q = parentOf(q);
    if (q && q.parent === null && (p === q || p.role === 'torso')) torso.add(p.id);
  }
  const onBody = (p: Part) => p.parent !== null && torso.has(p.parent) && !torso.has(p.id);
  const legged = parts.some((p) => (p.role === 'leg' || p.role === 'foot') && onBody(p));
  /** The part p's kept chain starts at (p itself or an ancestor), or null when p turns with the body. */
  const keptFrom = (p: Part): { from: Part; head: boolean } | null => {
    for (let q: Part | undefined = p; q && q.parent !== null; q = parentOf(q)) {
      const up = parentOf(q);
      if (NECK_OR_HEAD(q) && up && !NECK_OR_HEAD(up)) return { from: q, head: true };
      if (onBody(q) && LIMB.has(q.role) && (legged || q.role !== 'tail')) return { from: q, head: false };
    }
    return null;
  };
  for (const p of parts) {
    const k = keptFrom(p);
    if (!k) {
      p.dir = norm(turn(p.dir));
      p.offset = turn(p.offset);
    } else if (k.from === p && !k.head) p.offset = turn(p.offset);
  }
  return torso;
}

/**
 * After standing up, leg chains growing from the torso well above the lowest ones are front legs. With no arms drawn
 * they become the arms (leg → arm, foot → hand, and a ball fist on the end when there is no foot), each moved out to the
 * side of the body and hanging a little outward, like a fighter's; the lowest legs stay legs. Returns the arm chains' tops.
 */
function frontLegsToArms(recipe: Recipe, torso: Set<string>): string[] {
  const parts = recipe.parts;
  const isLeg = (p: Part) => p.role === 'leg' || p.role === 'foot';
  const tops = parts.filter((p) => isLeg(p) && p.parent !== null && torso.has(p.parent));
  if (!tops.length) return [];
  const bones = expandParts(recipe).filter((b) => !b.mirrored);
  const startY = (id: string) => bones.find((b) => b.partId === id)?.start.y ?? 0;
  const body = bones.filter((b) => torso.has(b.partId));
  const height = Math.max(...body.map((b) => Math.max(b.start.y, b.end.y))) - Math.min(...body.map((b) => Math.min(b.start.y, b.end.y)));
  const lowest = Math.min(...tops.map((t) => startY(t.id)));
  const front = tops.filter((t) => startY(t.id) > lowest + FRONT_LEG * height);
  for (const top of front) {
    const parent = parts.find((p) => p.id === top.parent)!;
    const side = top.mirror || top.offset.x >= 0 ? 1 : -1;
    const r = parent.r0 + (parent.r1 - parent.r0) * top.attach;
    top.offset = { x: side * Math.max(Math.abs(top.offset.x), r), y: 0, z: 0 };
    top.dir = norm({ x: side * Math.max(side * top.dir.x, ARM_OUT * Math.hypot(top.dir.y, top.dir.z)), y: top.dir.y, z: top.dir.z });
    let tip = top, fist = false;
    for (const todo = [top]; todo.length; ) {
      const p = todo.pop()!;
      if (!isLeg(p)) continue; // ears or spikes on a leg stay what they are
      if (p.role === 'foot') fist = true;
      p.role = p.role === 'foot' ? 'hand' : 'arm';
      if (p.role === 'arm') tip = p;
      todo.push(...parts.filter((c) => c.parent === p.id));
    }
    if (!fist) {
      const rr = HAND_R * tip.r1;
      const hand: Part = {
        ...tip, id: freeId(parts, 'hand'), parent: tip.id, role: 'hand', attach: 1, offset: { x: 0, y: 0, z: 0 },
        dir: { ...tip.dir }, length: HAND_LENGTH * rr, r0: rr, r1: rr, squash: 1, pointed: false, mirror: false,
      };
      parts.splice(parts.indexOf(tip) + 1, 0, hand);
    }
  }
  return front.map((t) => t.id);
}

/**
 * Make any recipe fight-ready: upright, with arms. A root lying flat is stood up (`standUp`: the torso rears up while
 * its neck, head, legs and tail keep the directions they were drawn in) and its front legs become its arms; a body
 * still without arms gets a mirrored stubby arm with a ball hand on its upper torso. A body whose legs don't reach the
 * ground needs nothing: `groundFit` stands every body on its lowest point. `fixes` names each change; a ready fighter comes back as is.
 */
export function ensureFighter(input: Recipe): { recipe: Recipe; fixes: string[] } {
  const recipe = structuredClone(input);
  const fixes: string[] = [];
  const root = recipe.parts.find((p) => p.parent === null) ?? recipe.parts[0];

  if (Math.abs(norm(root.dir).y) < FLAT) {
    const torso = standUp(recipe.parts, root.dir);
    fixes.push(`root "${root.id}" lay flat → stood up`);
    if (!recipe.parts.some((p) => p.role === 'arm')) {
      const arms = frontLegsToArms(recipe, torso);
      if (arms.length) fixes.push(`front legs ${arms.map((a) => `"${a}"`).join(', ')} → arms with fists`);
    }
  }

  if (!recipe.parts.some((p) => p.role === 'arm')) {
    // the arms hang from the highest torso part (the root itself for a one-piece body), not from a mirrored copy
    const bones = expandParts(recipe).filter((b) => !b.mirrored);
    const torsos = bones.filter((b) => b.role === 'torso');
    const top = (torsos.length ? torsos : bones).reduce((a, b) => (b.end.y > a.end.y ? b : a));
    const t = recipe.parts.find((p) => p.id === top.partId)!;
    // the torso chain it hangs from: the top part and every torso part below it (a snake's whole body)
    let chain = 0;
    for (let q: Part | undefined = t; q && q.role === t.role; q = q.parent === null ? undefined : recipe.parts.find((x) => x.id === q!.parent)) chain += q.length;
    const armId = freeId(recipe.parts, 'arm');
    const arm: Part = {
      id: armId, parent: t.id, role: 'arm', attach: ARM_AT,
      offset: { x: t.r1, y: 0, z: 0 }, dir: { ...ARM_DIR },
      length: ARM_LENGTH * chain, r0: ARM_R0 * t.r1, r1: ARM_R0 * ARM_TAPER * t.r1,
      squash: 1, flatFacing: 'up', pointed: false, mirror: true, region: t.region,
    };
    const r = HAND_R * arm.r1;
    const hand: Part = {
      ...arm, id: freeId(recipe.parts, 'hand'), parent: armId, role: 'hand', attach: 1,
      offset: { x: 0, y: 0, z: 0 }, dir: { ...ARM_DIR }, length: HAND_LENGTH * r, r0: r, r1: r, mirror: false,
    };
    // right after their torso, so a bone budget cut (which drops the last leaves) never takes them
    recipe.parts.splice(recipe.parts.indexOf(t) + 1, 0, arm, hand);
    fixes.push(`no arms → stubby arms with hands on "${t.id}"`);
  }

  if (!fixes.length) return { recipe, fixes };
  const n = normalizeRecipe(recipe);
  return { recipe: n.recipe, fixes: [...fixes, ...n.fixes] };
}
