import type RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three/webgpu';
import { addArenaColliders } from '../arena/colliders';
import { buildSkeleton } from '../builder/skeleton';
import blob from '../fixtures/fighters/blob.json';
import fists from '../fixtures/fighters/fists.json';
import horns from '../fixtures/fighters/horns.json';
import legs from '../fixtures/fighters/legs.json';
import tail from '../fixtures/fighters/tail.json';
import tiny from '../fixtures/fighters/tiny.json';
import wings from '../fixtures/fighters/wings.json';
import { isOut } from '../match/rules';
import { ragdollLayout } from '../physics/layout';
import { createWorld } from '../physics/world';
import type { Recipe } from '../recipe/schema';
import { mulberry32 } from '../util/rng';
import { Fighter, type FightCtx } from './fighter';
import { planFor } from './moves';
import { TUNE, type Tune } from './tune';

/**
 * Headless bouts for balancing (no rendering): fixture fighters round the ring, each fighter thinks then the world
 * steps at 1/60 s, a fighter that `isOut` is ringed out and removed. All randomness comes from the seed.
 */

/** The seven body kinds with a fighter fixture (one per row of the spec's moves table). */
export const BODY_KINDS = ['fists', 'legs', 'tiny', 'blob', 'wings', 'tail', 'horns'] as const;
const FIXTURES: Record<string, unknown> = { fists, legs, tiny, blob, wings, tail, horns };

const DT = 1 / 60;
/** Fighters start on a circle this far (m) from the middle, facing in (the spike's quick fill). */
const START_R = 3;

export type BoutResult = {
  /** Who left the ring, when (s), in order. */
  ringOuts: { id: string; t: number }[];
  /** The last one standing; null when the bout ran out of time with 2+ left, or the last ones fell out together. */
  winner: string | null;
  /** Longest stretch (s) without a landed hit while 2+ fight. */
  longestQuiet: number;
  /** Hits landed, by fighter id. */
  hits: Record<string, number>;
  /** When (s) one or none was left, or `seconds` if time ran out first. */
  end: number;
  /** Time ran out with 2+ still fighting. */
  timedOut: boolean;
};

/** A fighter's id in a bout: its kind and its place, e.g. `blob-2`. */
export const kindOf = (id: string) => id.replace(/-\d+$/, '');

/**
 * Runs one bout of `kinds` (fixture names, repeats allowed) for at most `seconds`, ending early once one or none is
 * left. Call `await initPhysics()` first.
 */
export function simulateBout(kinds: string[], o: { seconds: number; seed: number; tune?: Partial<Tune> }): BoutResult {
  const tune: Tune = { ...TUNE, ...o.tune };
  const rng = mulberry32(o.seed);
  const world = createWorld(tune.gravity);
  addArenaColliders(world, tune);
  try {
    const fs = kinds.map((k, i) => {
      const a = (i / kinds.length) * Math.PI * 2;
      const f = spawn(world, k, `${k}-${i + 1}`, tune, rng);
      f.ragdoll.pose(new Vector3(Math.cos(a) * START_R, 0, Math.sin(a) * START_R), Math.atan2(-Math.cos(a), -Math.sin(a)));
      f.state = 'fighting';
      return f;
    });

    const ringOuts: BoutResult['ringOuts'] = [];
    let fighting = fs.slice();
    const ctx: FightCtx = { others: fighting, boast: false, tune, rng };
    let t = 0, lastHit = 0, longestQuiet = 0;
    const steps = Math.round(o.seconds / DT);
    for (let s = 0; s < steps && fighting.length >= 2; s++) {
      let hit = false;
      for (const f of fighting) if (f.think(DT, t, ctx).length) hit = true;
      world.step();
      t = (s + 1) * DT;
      if (hit) lastHit = t;
      longestQuiet = Math.max(longestQuiet, t - lastHit);

      const outs = fighting.filter((f) => isOut(f.ragdoll.pos(), tune.ringRadius));
      if (!outs.length) continue;
      for (const f of outs) {
        ringOuts.push({ id: f.id, t });
        f.state = 'out';
        f.dispose();
      }
      fighting = fighting.filter((f) => !outs.includes(f));
      ctx.others = fighting;
    }

    const timedOut = fighting.length >= 2;
    return {
      ringOuts,
      winner: fighting.length === 1 ? fighting[0].id : null,
      longestQuiet,
      hits: Object.fromEntries(fs.map((f) => [f.id, f.hits])),
      end: timedOut ? o.seconds : (ringOuts.at(-1)?.t ?? 0),
      timedOut,
    };
  } finally {
    world.free();
  }
}

function spawn(world: RAPIER.World, kind: string, id: string, tune: Tune, rng: () => number): Fighter {
  const raw = FIXTURES[kind];
  if (!raw) throw new Error(`no fighter fixture "${kind}"`);
  const recipe = structuredClone(raw) as Recipe;
  const sk = buildSkeleton(recipe);
  const plan = planFor(recipe, sk);
  return new Fighter(id, world, ragdollLayout(sk, plan), plan, { tune, rng });
}

// ---------- reports ----------

export type FourWayReport = {
  bouts: BoutResult[];
  /** The kinds in each bout, in order. */
  cast: string[][];
  medianFirstOut: number;
  medianEnd: number;
  maxQuiet: number;
  /** Bouts whose longest quiet was over 3 s. */
  quietOver3: number;
  timedOut: number;
  /** Per kind: bouts it took part in, bouts it won, and wins ÷ bouts. */
  kinds: Record<string, { bouts: number; wins: number; winRate: number }>;
};

const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Four different kinds drawn at random. */
export function drawFour(rng: () => number): string[] {
  const pool: string[] = [...BODY_KINDS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 4);
}

/**
 * `n` four-way bouts of different kinds drawn at random (seeded by `seed`). A bout with no first ring-out counts its
 * first ring-out as `seconds` (as does a timed-out bout's end). `onBout` sees each bout as it finishes.
 */
export function fourWayReport(n: number, o: { seconds?: number; seed?: number; tune?: Partial<Tune>; onBout?: (i: number, cast: string[], r: BoutResult) => void } = {}): FourWayReport {
  const seconds = o.seconds ?? 240, pick = mulberry32(o.seed ?? 1);
  const bouts: BoutResult[] = [], cast: string[][] = [];
  for (let i = 0; i < n; i++) {
    const c = drawFour(pick);
    const r = simulateBout(c, { seconds, seed: 1000 + i * 7919 + (o.seed ?? 1), tune: o.tune });
    bouts.push(r);
    cast.push(c);
    o.onBout?.(i, c, r);
  }
  const kinds: FourWayReport['kinds'] = {};
  for (const k of BODY_KINDS) kinds[k] = { bouts: 0, wins: 0, winRate: 0 };
  bouts.forEach((r, i) => {
    for (const k of cast[i]) kinds[k].bouts++;
    if (r.winner) kinds[kindOf(r.winner)].wins++;
  });
  for (const k of BODY_KINDS) kinds[k].winRate = kinds[k].bouts ? kinds[k].wins / kinds[k].bouts : 0;
  return {
    bouts, cast,
    medianFirstOut: median(bouts.map((r) => r.ringOuts[0]?.t ?? seconds)),
    medianEnd: median(bouts.map((r) => r.end)),
    maxQuiet: Math.max(...bouts.map((r) => r.longestQuiet)),
    quietOver3: bouts.filter((r) => r.longestQuiet > 3).length,
    timedOut: bouts.filter((r) => r.timedOut).length,
    kinds,
  };
}
