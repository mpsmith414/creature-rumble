import type RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, test } from 'vitest';
import { addArenaColliders } from '../../src/arena/colliders';
import { buildSkeleton } from '../../src/builder/skeleton';
import { Fighter, type FightCtx, type Hit } from '../../src/fight/fighter';
import { planFor } from '../../src/fight/moves';
import { SPECIAL_FOR, type SpecialCue } from '../../src/fight/special';
import { ARMOR_POWER, METER_LAND, METER_PER_S } from '../../src/fight/specials';
import { MOVE_POWER, TUNE } from '../../src/fight/tune';
import { ragdollLayout } from '../../src/physics/layout';
import { createWorld, initPhysics } from '../../src/physics/world';
import { mulberry32 } from '../../src/util/rng';
import { EXPECTED_MOVE, KINDS, loadFixture } from '../fixtures/fighters';

beforeAll(initPhysics);

const DT = 1 / 60;

function ring(): RAPIER.World {
  const w = createWorld(TUNE.gravity);
  addArenaColliders(w, TUNE);
  return w;
}

function fighter(w: RAPIER.World, kind: string, id: string, at: Vector3, yaw: number, seed = 1): Fighter {
  const recipe = loadFixture(kind);
  const sk = buildSkeleton(recipe);
  const plan = planFor(recipe, sk);
  const f = new Fighter(id, w, ragdollLayout(sk, plan), plan, { tune: TUNE, rng: mulberry32(seed) });
  f.ragdoll.pose(at, yaw);
  f.state = 'fighting';
  return f;
}

/** Steps the fight (everyone thinks, then the world steps) until `until` says stop or `secs` run out; cues by fighter. */
function run(w: RAPIER.World, fs: Fighter[], secs: number, o: { boast?: boolean; from?: number; until?: (cues: readonly SpecialCue[]) => boolean; each?: (t: number, hits: Hit[]) => void } = {}) {
  const ctx: FightCtx = { others: fs, boast: o.boast ?? false, tune: TUNE, rng: mulberry32(9) };
  const cues: SpecialCue[] = [];
  let t = o.from ?? 0;
  const end = t + secs;
  while (t < end - 1e-9) {
    const hits = fs.filter((f) => f.state === 'fighting' || f.state === 'entering').flatMap((f) => f.think(DT, t, ctx));
    w.step();
    t += DT;
    for (const f of fs) cues.push(...f.takeCues());
    o.each?.(t, hits);
    if (o.until?.(cues)) break;
  }
  return { cues, t };
}

/** A duel: `kind` faces a fixture foe a little over arm's length away, its meter full. */
function duel(kind: string, gap = 1.6) {
  const w = ring();
  const foe = kind === 'blob' ? 'fists' : 'blob';
  const a = fighter(w, kind, `${kind}-1`, new Vector3(-gap / 2, 0, 0), Math.PI / 2, 1);
  const b = fighter(w, foe, `${foe}-2`, new Vector3(gap / 2, 0, 0), -Math.PI / 2, 2);
  return { w, a, b };
}

describe('specials', () => {
  test.each(KINDS)('%s: its special winds up, lets go, lands and ends, then it fights on', (kind) => {
    const { w, a, b } = duel(kind);
    try {
      run(w, [a, b], 0.5); // settle
      a.special.meter = 1;
      const hits: Hit[] = [];
      const { cues, t } = run(w, [a, b], 8, {
        from: 0.5,
        each: (_t, hs) => hits.push(...hs.filter((h) => h.attacker === a && h.special)),
        until: (cs) => cs.some((c) => c.id === a.id && c.phase === 'end'),
      });
      const mine = cues.filter((c) => c.id === a.id);
      expect(mine.map((c) => c.phase)).toEqual(['charge', 'release', 'impact', 'end']);
      for (const c of mine) expect(c.special).toBe(SPECIAL_FOR[EXPECTED_MOVE[kind]]);
      expect(a.special.active).toBeNull();
      expect(a.special.meter).toBeLessThan(0.2);
      expect(hits.length, 'its special landed').toBeGreaterThan(0);
      for (const h of hits) expect(h.special).toBe(SPECIAL_FOR[EXPECTED_MOVE[kind]]);
      // not stuck: it is back to its normal attacks soon after
      const phases = new Set<string>();
      run(w, [a, b], 6, { from: t, each: () => phases.add(a.attack) });
      expect(a.state).toBe('fighting');
      expect(phases.has('strike')).toBe(true);
    } finally {
      w.free();
    }
  }, 30_000);

  test('a shockwave throws a nearby fighter UP', () => {
    const { w, a, b } = duel('blob', 2);
    try {
      run(w, [a, b], 0.5);
      a.special.meter = 1;
      let impact: SpecialCue | null = null, hitAt = -1, top = -Infinity, now = 0;
      run(w, [a, b], 6, {
        from: 0.5,
        each: (t, hs) => {
          now = t;
          if (hitAt < 0 && hs.some((h) => h.attacker === a && h.special === 'bellyBomb' && h.target === b)) hitAt = t;
          if (hitAt >= 0) top = Math.max(top, b.ragdoll.pos().y);
        },
        until: (cs) => {
          impact ??= cs.find((c) => c.id === a.id && c.phase === 'impact') ?? null;
          return hitAt >= 0 && now - hitAt > 1.5;
        },
      });
      expect(impact, 'the slam landed').not.toBeNull();
      expect(impact!.radius).toBeGreaterThan(1.5);
      expect(hitAt).toBeGreaterThan(0);
      expect(top - b.layout.standHeight, 'thrown well over its own height').toBeGreaterThan(1);
    } finally {
      w.free();
    }
  }, 30_000);

  test('the meter fills from time and hits, and empties when the special starts', () => {
    const { w, a, b } = duel('fists', 6); // far apart: no hits at first
    try {
      let hit = false;
      run(w, [a, b], 0.2, { each: (_t, hs) => { if (hs.length) hit = true; } });
      const before = a.special.meter;
      expect(before).toBeGreaterThan(0); // time fills it
      run(w, [a, b], 0.3, { from: 0.2, each: (_t, hs) => { if (hs.length) hit = true; } });
      expect(hit).toBe(false);
      expect(a.special.meter - before).toBeCloseTo(0.3 * METER_PER_S, 4);
      // landing a hit adds METER_LAND (on top of the time)
      const close = duel('fists', 1.6);
      run(close.w, [close.a, close.b], 0.3);
      let m0 = 0, landed = false;
      run(close.w, [close.a, close.b], 5, {
        from: 0.3,
        each: (_t, hs) => {
          if (!landed && hs.some((h) => h.attacker === close.a)) { landed = true; m0 = close.a.special.meter; }
        },
        until: () => landed,
      });
      expect(landed).toBe(true);
      expect(m0).toBeGreaterThanOrEqual(METER_LAND);
      close.w.free();
      // full: it goes, and the meter is spent
      a.special.meter = 1;
      run(w, [a, b], 4, { from: 0.5, until: () => a.special.active !== null });
      expect(a.special.active).toBe('megaPunch');
      expect(a.special.meter).toBe(0);
    } finally {
      w.free();
    }
  }, 30_000);

  test('no special while entering or boasting', () => {
    const { w, a, b } = duel('horns', 2);
    try {
      a.state = 'entering';
      a.special.meter = 1;
      const { cues } = run(w, [a], 3);
      expect(cues).toEqual([]);
      expect(a.special.active).toBeNull();
      a.state = 'fighting';
      const boast = run(w, [a, b], 4, { boast: true, from: 3 });
      expect(boast.cues.filter((c) => c.id === a.id)).toEqual([]);
      expect(a.special.active).toBeNull();
      expect(a.special.meter).toBe(1); // still full, waiting for a real fight
    } finally {
      w.free();
    }
  }, 30_000);

  test.each(['knocked', 'ruled out', 'let go'] as const)('a fighter %s mid-special still ends it', (how) => {
    const { w, a, b } = duel('fists');
    try {
      run(w, [a, b], 0.5);
      a.special.meter = 1;
      const { cues, t } = run(w, [a, b], 4, { from: 0.5, until: () => a.special.active !== null });
      expect(cues.filter((c) => c.id === a.id).map((c) => c.phase)).toEqual(['charge']);
      // a divebomb's blow, the hardest normal one: it breaks the armour
      if (how === 'knocked') a.knock(a.ragdoll.pos().add(new Vector3(1, 0, 0)), MOVE_POWER.divebomb * TUNE.knock);
      if (how === 'ruled out') a.state = 'out';
      if (how === 'let go') a.dispose();
      const after = a.takeCues();
      expect(after.map((c) => c.phase)).toEqual(['end']);
      expect(after[0].id).toBe(a.id);
      expect(Number.isFinite(after[0].at.x)).toBe(true);
      expect(a.special.active).toBeNull();
      if (how === 'knocked') {
        // it lands, gets up and fights on
        const phases = new Set<string>();
        run(w, [a, b], 6, { from: t, each: () => phases.add(a.attack) });
        expect(phases.has('strike')).toBe(true);
      }
    } finally {
      w.free();
    }
  }, 30_000);

  test('one special at a time: two full meters never overlap, the second waits for the first to end', () => {
    const { w, a, b } = duel('fists', 1.8); // two punchers: both in range at once
    try {
      run(w, [a, b], 0.3);
      a.special.meter = b.special.meter = 1;
      let overlap = 0;
      const { cues } = run(w, [a, b], 12, {
        from: 0.3,
        each: () => { if (a.special.active && b.special.active) overlap++; },
        until: (cs) => cs.filter((c) => c.phase === 'end').length >= 2,
      });
      expect(overlap).toBe(0);
      const order = cues.map((c) => `${c.id}:${c.phase}`);
      expect(order.filter((c) => c.endsWith(':charge'))).toHaveLength(2); // both went, in turn
      const [first] = order;
      const firstEnd = order.indexOf(`${first.split(':')[0]}:end`);
      const secondCharge = order.findIndex((c, i) => i > 0 && c.endsWith(':charge'));
      expect(secondCharge).toBeGreaterThan(firstEnd);
    } finally {
      w.free();
    }
  }, 30_000);

  test('a full meter waits (past its engage wait) while another fighter’s special is under way', () => {
    const { w, a, b } = duel('fists', 1.6);
    try {
      run(w, [a, b], 0.3);
      b.special.active = 'bellyBomb'; // someone else's special, held under way (b does not think here)
      a.special.meter = 1;
      const ctx: FightCtx = { others: [a, b], boast: false, tune: TUNE, rng: mulberry32(9) };
      let t = 0.3;
      for (let i = 0; i < 4 * 60; i++) { a.think(DT, t, ctx); w.step(); t += DT; }
      expect(a.special.active).toBeNull();
      expect(a.special.meter).toBe(1);
      expect(a.takeCues()).toEqual([]);
      b.special.active = null; // it ended: now a goes
      for (let i = 0; i < 4 * 60 && !a.special.active; i++) { a.think(DT, t, ctx); w.step(); t += DT; }
      expect(a.special.active).toBe('megaPunch');
    } finally {
      w.free();
    }
  }, 30_000);

  test('the hardest normal blow breaks the armour; most do not', () => {
    expect(MOVE_POWER.divebomb * TUNE.knock).toBeGreaterThanOrEqual(ARMOR_POWER);
    for (const m of ['punch', 'jab', 'kick', 'bump', 'headbutt', 'spin'] as const) expect(MOVE_POWER[m] * TUNE.knock, m).toBeLessThan(ARMOR_POWER);
  });

  test('one special’s blow cancels another fighter’s special', () => {
    // one at a time is the rule, so here each fighter is shown the other's special as not under way while it thinks
    const w = ring();
    const a = fighter(w, 'fists', 'fists-1', new Vector3(-0.8, 0, 0), Math.PI / 2, 1);
    const b = fighter(w, 'tail', 'tail-2', new Vector3(0.8, 0, 0), -Math.PI / 2, 2);
    try {
      const fs = [a, b], ctx: FightCtx = { others: fs, boast: false, tune: TUNE, rng: mulberry32(9) };
      a.special.meter = b.special.meter = 1;
      let t = 0, cancelled = false;
      const cues: SpecialCue[] = [];
      for (let i = 0; i < 8 * 60 && !cancelled; i++) {
        for (const [me, other] of [[a, b], [b, a]] as const) {
          const hidden = other.special.active;
          other.special.active = null;
          const hits = me.think(DT, t, ctx);
          const theirs = other.takeCues();
          cues.push(...me.takeCues(), ...theirs);
          const ended = theirs.some((c) => c.phase === 'end');
          if (!ended) other.special.active = hidden; // still under way
          if (ended && hidden && hits.some((h) => h.special && h.target === other)) cancelled = true;
        }
        w.step();
        t += DT;
      }
      expect(cancelled, 'a special blow ended the other’s special').toBe(true);
      expect(cues.filter((c) => c.phase === 'charge')).toHaveLength(2);
    } finally {
      w.free();
    }
  }, 30_000);

  test('resetSpecial calls a special off: its end goes, the meter empties, the wait starts again', () => {
    const { w, a, b } = duel('fists');
    try {
      run(w, [a, b], 0.5);
      a.special.meter = 1;
      run(w, [a, b], 4, { from: 0.5, until: () => a.special.active !== null });
      a.takeCues();
      a.resetSpecial();
      expect(a.takeCues().map((c) => c.phase)).toEqual(['end']);
      expect(a.special).toEqual({ meter: 0, active: null });
      a.special.meter = 0.5;
      a.resetSpecial(); // nothing under way: just empties the meter
      expect(a.takeCues()).toEqual([]);
      expect(a.special.meter).toBe(0);
    } finally {
      w.free();
    }
  }, 30_000);

  test('a long stun is never shortened by a hit, and a stunned fighter runs no special', () => {
    const { w, a, b } = duel('fists');
    try {
      run(w, [a, b], 0.5);
      a.special.meter = 1;
      run(w, [a, b], 4, { from: 0.5, until: () => a.special.active !== null });
      a.stun = 999; // the crowning holds the losers limp
      a.knock(a.ragdoll.pos().add(new Vector3(1, 0, 0)), 0.7);
      expect(a.stun).toBeGreaterThan(998);
      run(w, [a, b], 2, { from: 4 });
      expect(a.special.active).toBeNull();
      a.special.meter = 1;
      run(w, [a, b], 2, { from: 6 });
      expect(a.special.active).toBeNull();
    } finally {
      w.free();
    }
  }, 30_000);

  test('a weak normal blow does not stop a special (super armour)', () => {
    const { w, a, b } = duel('fists');
    try {
      run(w, [a, b], 0.5);
      a.special.meter = 1;
      const { cues } = run(w, [a, b], 4, { from: 0.5, until: () => a.special.active !== null });
      a.knock(a.ragdoll.pos().add(new Vector3(1, 0, 0)), 1);
      expect(a.special.active).toBe('megaPunch');
      expect([...cues, ...a.takeCues()].filter((c) => c.id === a.id).map((c) => c.phase)).toEqual(['charge']);
    } finally {
      w.free();
    }
  }, 30_000);
});

describe('spectacle metrics', () => {
  test('a bout reports every landed hit\'s flight and the specials, and the report sums them', async () => {
    const { simulateBout, fourWayReport } = await import('../../src/fight/sim');
    const r = simulateBout(['fists', 'blob'], { seconds: 20, seed: 3 });
    const landed = Object.values(r.hits).reduce((a, b) => a + b, 0);
    expect(r.launches.length).toBe(landed);
    expect(r.launches.length).toBeGreaterThan(0);
    for (const l of r.launches) {
      expect(Number.isFinite(l.peak) && Number.isFinite(l.air) && Number.isFinite(l.launch)).toBe(true);
      expect(l.air).toBeGreaterThanOrEqual(0);
      expect(l.air).toBeLessThanOrEqual(3 + 1e-9);
    }
    expect(r.launches.some((l) => l.air > 0 && l.peak > 1)).toBe(true);
    expect(r.fightSeconds).toBeGreaterThan(0);
    expect(Object.keys(r.specials).sort()).toEqual(['blob-2', 'fists-1']);
    const rep = fourWayReport(1, { seconds: 15, seed: 4 });
    const normal = rep.bouts[0].launches.filter((l) => !l.special);
    expect(rep.medianPeak).toBeGreaterThan(0);
    expect(rep.highShare).toBeCloseTo(normal.filter((l) => l.peak >= 1.5).length / normal.length);
    expect(rep.medianAir).toBeGreaterThan(0);
    const sp = Object.values(rep.bouts[0].specials).reduce((a, b) => a + b, 0);
    expect(rep.specialsPer45).toBeCloseTo((45 * sp) / rep.bouts[0].fightSeconds);
  }, 60_000);
});
