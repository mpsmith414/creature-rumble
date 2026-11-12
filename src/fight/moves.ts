import type { BoneDef, Skeleton } from '../builder/skeleton';
import type { Recipe, Role } from '../recipe/schema';
import { dist } from '../util/vec';
import { ringScale } from './scale';
import { FightPlanSchema, type FightPlan, type Move } from './types';

/** Heuristic thresholds (spec §3.3): × the torso's radius for hands, × the body's height for the rest. */
const BIG_HANDS = 0.45, TINY_RING = 0.95, LONG_LEGS = 0.55, LONG_TAIL = 0.6, ROUND_BODY = 0.35;

const R = (b: BoneDef) => Math.max(b.r0, b.r1);
const children = (sk: Skeleton, i: number, roles: readonly Role[]) =>
  sk.bones.flatMap((b, j) => (b.parent === i && roles.includes(b.role) ? [j] : []));

/** The longest chain of `roles` bones from bone i down: its length (m) and the bone at its tip. */
function chain(sk: Skeleton, i: number, roles: readonly Role[]): { length: number; tip: number } {
  const own = dist(sk.bones[i].start, sk.bones[i].end);
  let best = { length: 0, tip: i };
  for (const c of children(sk, i, roles)) {
    const sub = chain(sk, c, roles);
    if (sub.length > best.length) best = sub;
  }
  return { length: own + best.length, tip: best.tip };
}

/** The longest chain of `roles` bones starting from a bone whose parent is not one of them. */
function longest(sk: Skeleton, roles: readonly Role[]): { length: number; tip: number } | null {
  let best: { length: number; tip: number } | null = null;
  sk.bones.forEach((b, i) => {
    if (!roles.includes(b.role) || (b.parent >= 0 && roles.includes(sk.bones[b.parent].role))) return;
    const c = chain(sk, i, roles);
    if (!best || c.length > best.length) best = c;
  });
  return best;
}

const LEG: readonly Role[] = ['leg', 'foot'];
const TAIL: readonly Role[] = ['tail'];

function descendsFromHead(sk: Skeleton, i: number): boolean {
  for (let p = sk.bones[i].parent; p >= 0; p = sk.bones[p].parent) if (sk.bones[p].role === 'head') return true;
  return false;
}

/** The skeleton's height: top of its highest bone's ball to the bottom of its lowest (its bounding box). */
export const bodyHeight = (sk: Skeleton) => sk.max.y - sk.min.y;

/**
 * The signature move a body suggests, first match wins: big hands punch, tiny bodies jab, long legs kick, wings
 * divebomb, a long tail spins, horns on the head headbutt, a big round body bumps, and anything else punches.
 */
export function chooseMove(sk: Skeleton): Move {
  const h = bodyHeight(sk);
  const radius = (role: Role) => Math.max(0, ...sk.bones.filter((b) => b.role === role).map(R));
  const torso = radius('torso') || R(sk.bones[0]);
  const hand = radius('hand');
  if (hand > 0 && hand >= BIG_HANDS * torso) return 'punch';
  if (h * ringScale(h) < TINY_RING) return 'jab';
  if ((longest(sk, LEG)?.length ?? 0) >= LONG_LEGS * h) return 'kick';
  if (sk.bones.some((b) => b.role === 'wing')) return 'divebomb';
  if ((longest(sk, TAIL)?.length ?? 0) >= LONG_TAIL * h) return 'spin';
  if (sk.bones.some((b, i) => b.role === 'horn' && descendsFromHead(sk, i))) return 'headbutt';
  if (torso >= ROUND_BODY * h) return 'bump';
  return 'punch';
}

/** The parts a move hits with, from the skeleton: hands, feet, the head, the fattest torso part or the tail's tip. */
function weaponsFor(move: Move, sk: Skeleton): string[] {
  const ids = (role: Role) => [...new Set(sk.bones.filter((b) => b.role === role && !b.jaw).map((b) => b.partId))];
  const root = [sk.bones[0].partId];
  const first = (...lists: string[][]) => lists.find((l) => l.length > 0) ?? root;
  switch (move) {
    case 'punch': case 'jab': return first(ids('hand'), ids('arm'));
    case 'kick': {
      const tips = sk.contacts.filter((i) => LEG.includes(sk.bones[i].role)).map((i) => sk.bones[i].partId);
      return first(ids('foot'), [...new Set(tips)]);
    }
    case 'headbutt': case 'divebomb': return first(ids('head').slice(0, 1));
    case 'bump': {
      const torsos = sk.bones.filter((b) => b.role === 'torso');
      return torsos.length ? [torsos.reduce((a, b) => (R(b) > R(a) ? b : a)).partId] : root;
    }
    case 'spin': {
      const tail = longest(sk, TAIL);
      return tail ? [sk.bones[tail.tip].partId] : root;
    }
  }
}

/** The weigh-in words for a mass in kg. */
export function weightWords(kg: number): string {
  if (kg < 2) return 'one teeny tiny pound';
  if (kg < 30) return 'a wobbly thirty pounds';
  if (kg < 200) return 'a hefty fifty pounds';
  return 'a HUMONGOUS ton';
}

/**
 * The recipe does not know its maker: like the designer's own intros, the fallback writes `{maker}` where the name goes
 * and whoever shows or says it fills it in (src/show/intro.ts, "a mystery maker" when unknown).
 */
const introFor = (name: string, weight: string) =>
  `From the bedroom of {maker}! Weighing in at ${weight}! It's... ${name.toUpperCase()}!`;

/**
 * How this creature fights: the recipe's own plan when it is valid and names at least one of its parts as a weapon
 * (blank words filled in), else the move its body suggests with that move's weapons and the default words.
 */
export function planFor(recipe: Recipe, sk: Skeleton): FightPlan {
  const own = FightPlanSchema.safeParse(recipe.fight);
  const partIds = new Set(recipe.parts.map((p) => p.id));
  if (own.success) {
    const weapons = own.data.weapons.filter((w) => partIds.has(w));
    if (weapons.length) {
      const weight = own.data.weight.trim() ? own.data.weight : weightWords(recipe.life.massKg);
      return { move: own.data.move, weapons, weight, intro: own.data.intro.trim() ? own.data.intro : introFor(recipe.name, weight) };
    }
  }
  const move = chooseMove(sk);
  const weight = weightWords(recipe.life.massKg);
  return { move, weapons: weaponsFor(move, sk), weight, intro: introFor(recipe.name, weight) };
}
