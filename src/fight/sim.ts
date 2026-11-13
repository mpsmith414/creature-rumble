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
  /** Every landed hit's flight: how high (m above the ring top) the target's torso got and how long it was up (s). */
  launches: Launch[];
  /** Specials started, by fighter id. */
  specials: Record<string, number>;
  /** Fighter-seconds spent fighting with at least one opponent (the specials rate's time base). */
  fightSeconds: number;
};

/**
 * One landed hit's flight, watched for `WATCH_S` after it: `peak` is the highest the target's torso got (m above the
 * ring top); `air` is how long (s) until the torso came back down to the height it was hit at (0 when it never rose);
 * `launch` is the hit's launch speed (m/s, `Hit.launch`).
 */
export type Launch = { peak: number; air: number; special: boolean; launch: number };

/** How long (s) a hit's flight is watched. */
const WATCH_S = 3;
/** A torso that rose less than this (m) over where it was hit was not launched. */
const ROSE = 0.05;

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
    let t = 0, lastHit = 0, longestQuiet = 0, fightSeconds = 0;
    const launches: Launch[] = [];
    const watching: (Launch & { f: Fighter; t0: number; y0: number; rose: boolean })[] = [];
    const specials: Record<string, number> = Object.fromEntries(fs.map((f) => [f.id, 0]));
    const steps = Math.round(o.seconds / DT);
    for (let s = 0; s < steps && fighting.length >= 2; s++) {
      let hit = false;
      for (const f of fighting) {
        for (const h of f.think(DT, t, ctx)) {
          hit = true;
          const w = { f: h.target, t0: t, y0: h.target.ragdoll.pos().y, peak: 0, air: 0, special: !!h.special, launch: h.launch, rose: false };
          w.peak = w.y0;
          watching.push(w);
          launches.push(w);
        }
        for (const c of f.takeCues()) if (c.phase === 'charge') specials[f.id]++;
      }
      world.step();
      t = (s + 1) * DT;
      fightSeconds += fighting.length * DT;
      if (hit) lastHit = t;
      longestQuiet = Math.max(longestQuiet, t - lastHit);
      watch(watching, t);

      const outs = fighting.filter((f) => isOut(f.ragdoll.pos(), tune.ringRadius));
      if (!outs.length) continue;
      for (const f of outs) {
        ringOuts.push({ id: f.id, t });
        f.state = 'out';
        // its flight ends where it fell out
        for (const w of watching) if (w.f === f && w.air === 0) w.air = w.rose ? t - w.t0 : 0;
        for (let i = watching.length - 1; i >= 0; i--) if (watching[i].f === f) watching.splice(i, 1);
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
      launches: launches.map(({ peak, air, special, launch }) => ({ peak, air, special, launch })),
      specials,
      fightSeconds,
    };
  } finally {
    world.free();
  }
}

/** Follows each watched flight one step: its peak, and when it came back down; drops it after `WATCH_S`. */
function watch(ws: (Launch & { f: Fighter; t0: number; y0: number; rose: boolean })[], t: number): void {
  for (let i = ws.length - 1; i >= 0; i--) {
    const w = ws[i], y = w.f.ragdoll.pos().y, age = t - w.t0;
    w.peak = Math.max(w.peak, y);
    if (y > w.y0 + ROSE) w.rose = true;
    const down = w.rose && y <= w.y0;
    if (down) w.air = age;
    if (down || age >= WATCH_S) {
      if (!down) w.air = w.rose ? age : 0;
      ws.splice(i, 1);
    }
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
  /** Normal (not special) landed hits: the median peak torso height (m above the ring top) of their targets. */
  medianPeak: number;
  /** Share of normal landed hits whose target's torso peaked at 1.5 m or higher. */
  highShare: number;
  /** Median air time (s) of normal landed hits that launched their target (rose at all). */
  medianAir: number;
  /** Specials each fighter performs per 45 s of fighting, on average. */
  specialsPer45: number;
};

/** A torso peaking this high (m above the ring top) after a hit is a high launch. */
export const HIGH_LAUNCH = 1.5;

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
  const normal = bouts.flatMap((r) => r.launches.filter((l) => !l.special));
  const flew = normal.filter((l) => l.air > 0);
  const specials = bouts.reduce((n, r) => n + Object.values(r.specials).reduce((a, b) => a + b, 0), 0);
  const fightSeconds = bouts.reduce((n, r) => n + r.fightSeconds, 0);
  return {
    bouts, cast,
    medianFirstOut: median(bouts.map((r) => r.ringOuts[0]?.t ?? seconds)),
    medianEnd: median(bouts.map((r) => r.end)),
    maxQuiet: Math.max(...bouts.map((r) => r.longestQuiet)),
    quietOver3: bouts.filter((r) => r.longestQuiet > 3).length,
    timedOut: bouts.filter((r) => r.timedOut).length,
    kinds,
    medianPeak: normal.length ? median(normal.map((l) => l.peak)) : 0,
    highShare: normal.length ? normal.filter((l) => l.peak >= HIGH_LAUNCH).length / normal.length : 0,
    medianAir: flew.length ? median(flew.map((l) => l.air)) : 0,
    specialsPer45: fightSeconds > 0 ? (45 * specials) / fightSeconds : 0,
  };
}
