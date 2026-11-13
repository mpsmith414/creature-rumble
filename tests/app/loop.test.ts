import type RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { MAX_RAGDOLLS, RingLoop } from '../../src/app/loop';
import { addArenaColliders } from '../../src/arena/colliders';
import { buildSkeleton } from '../../src/builder/skeleton';
import { Fighter, type Hit } from '../../src/fight/fighter';
import type { SpecialCue } from '../../src/fight/special';
import { planFor } from '../../src/fight/moves';
import { TUNE } from '../../src/fight/tune';
import { Match } from '../../src/match/match';
import { ragdollLayout } from '../../src/physics/layout';
import { createWorld, initPhysics } from '../../src/physics/world';
import { SlowMo } from '../../src/show/slowmo';
import { mulberry32 } from '../../src/util/rng';
import { loadFixture } from '../fixtures/fighters';

beforeAll(initPhysics);

const DT = 1 / 60;
const R = TUNE.ringRadius;

function ring(gravity = TUNE.gravity): RAPIER.World {
  const w = createWorld(gravity);
  addArenaColliders(w, TUNE);
  return w;
}

function fighter(w: RAPIER.World, id: string, kind = 'blob', at = new Vector3()): Fighter {
  const recipe = loadFixture(kind);
  const sk = buildSkeleton(recipe);
  const plan = planFor(recipe, sk);
  const f = new Fighter(id, w, ragdollLayout(sk, plan), plan, { tune: TUNE, rng: mulberry32(3) });
  f.ragdoll.pose(at, 0);
  return f;
}

/** A match with `ids` already fighting (their entrance run to its end). */
function fightingMatch(ids: string[]): Match {
  const m = new Match();
  m.arrive(ids);
  m.tick(30);
  expect([...m.fighting].sort()).toEqual([...ids].sort());
  return m;
}

/** Real frames of `dt` s for `secs`, the clock running from `from`. */
function frames(loop: RingLoop, secs: number, from = 0, dt = DT) {
  const hits = [], outs: string[] = [];
  let t = from;
  for (let i = 0; i < Math.round(secs / dt); i++) {
    t += dt;
    const r = loop.step(dt, t);
    hits.push(...r.hits);
    outs.push(...r.outs);
  }
  return { hits, outs, t };
}

describe('RingLoop', () => {
  test('loop does not step while frozen', () => {
    const world = ring();
    const match = fightingMatch(['a']);
    match.arrive(['b']); // an entrance is due: the fight freezes
    expect(match.frozen).toBe(true);
    const loop = new RingLoop({ world, match, slowmo: new SlowMo(), tune: TUNE });
    const a = fighter(world, 'a');
    a.state = 'fighting';
    loop.add(a);
    const step = vi.spyOn(world, 'step');
    const think = vi.spyOn(a, 'think');
    frames(loop, 1);
    expect(step).toHaveBeenCalledTimes(0);
    expect(think).toHaveBeenCalledTimes(0);
  });

  test('a frozen ring still steps while someone is entering (the entrance plays)', () => {
    const world = ring();
    const match = fightingMatch(['a']);
    match.arrive(['b']);
    const update = vi.fn();
    const loop = new RingLoop({ world, match, slowmo: new SlowMo(), tune: TUNE, entrance: { update } });
    const a = fighter(world, 'a');
    a.state = 'fighting';
    const b = fighter(world, 'b', 'tiny', new Vector3(R + 3, 0, 0));
    b.state = 'entering';
    loop.add(a);
    loop.add(b);
    const step = vi.spyOn(world, 'step');
    const thinkA = vi.spyOn(a, 'think');
    const thinkB = vi.spyOn(b, 'think');
    frames(loop, 1);
    expect(step).toHaveBeenCalledTimes(60);
    expect(update).toHaveBeenCalledTimes(60);
    expect(thinkA).toHaveBeenCalledTimes(0); // frozen mid-flail
    expect(thinkB).toHaveBeenCalledTimes(60); // the entering fighter plays its show-off
    expect(a.ragdoll.torso.body.isEnabled()).toBe(false);
  });

  test('slow-mo slows simulated time', () => {
    const world = ring();
    const match = new Match();
    const slowmo = new SlowMo({ scale: 0.25, seconds: 100 });
    slowmo.trigger(0);
    const loop = new RingLoop({ world, match, slowmo, tune: TUNE });
    const step = vi.spyOn(world, 'step');
    frames(loop, 1);
    expect(step.mock.calls.length).toBeGreaterThanOrEqual(14);
    expect(step.mock.calls.length).toBeLessThanOrEqual(16);
  });

  test('full speed takes 60 steps a second, and never more than 4 in one frame', () => {
    const world = ring();
    const loop = new RingLoop({ world, match: new Match(), slowmo: new SlowMo(), tune: TUNE });
    const step = vi.spyOn(world, 'step');
    frames(loop, 1);
    expect(step).toHaveBeenCalledTimes(60);
    step.mockClear();
    loop.step(0.5, 2); // a stalled frame
    expect(step).toHaveBeenCalledTimes(4);
  });

  test('fallen fighters are disposed', () => {
    const world = ring();
    const match = fightingMatch(['a', 'b']);
    const loop = new RingLoop({ world, match, slowmo: new SlowMo(), tune: TUNE });
    const a = fighter(world, 'a', 'blob', new Vector3(-2, 0, 0));
    const b = fighter(world, 'b', 'tiny', new Vector3(R + 6, 0, 0)); // pushed off: already far past the ring
    a.state = b.state = 'fighting';
    loop.add(a);
    loop.add(b);
    const bodies = world.bodies.len();
    const gone = vi.fn();
    loop.onGone = gone;
    const first = frames(loop, DT);
    expect(first.outs).toEqual(['b']);
    expect(b.state).toBe('out');
    expect(match.fighting).toEqual(['a']);
    frames(loop, 5, first.t);
    expect(b.ragdoll.pieces.length).toBe(0);
    expect(b.state).toBe('gone');
    expect(world.bodies.len()).toBe(bodies - b.layout.segments.length);
    expect(gone).toHaveBeenCalledWith(b);
    expect(loop.size).toBe(1);
  });

  test('a fallen fighter that never reaches the pit is still disposed 5 s after it went out', () => {
    const world = ring(0); // no gravity: it hangs where it was knocked
    const match = fightingMatch(['b']);
    const loop = new RingLoop({ world, match, slowmo: new SlowMo(), tune: TUNE });
    const b = fighter(world, 'b', 'tiny', new Vector3(R + 6, 0, 0));
    b.state = 'fighting';
    loop.add(b);
    const r = frames(loop, 4.9);
    expect(r.outs).toEqual(['b']);
    expect(b.ragdoll.pieces.length).toBeGreaterThan(0);
    frames(loop, 0.2, r.t);
    expect(b.ragdoll.pieces.length).toBe(0);
  });

  test(`never more than ${MAX_RAGDOLLS} ragdolls: room is made by letting the fallen go early, else refused`, () => {
    const world = ring();
    const loop = new RingLoop({ world, match: new Match(), slowmo: new SlowMo(), tune: TUNE });
    const fs: Fighter[] = [];
    for (let i = 0; i < MAX_RAGDOLLS; i++) {
      expect(loop.makeRoom()).toBe(true);
      const f = fighter(world, `f${i}`, 'tiny', new Vector3((i % 4) * 2 - 3, 0, Math.floor(i / 4) * 2 - 3));
      f.state = 'fighting';
      loop.add(f);
      fs.push(f);
    }
    expect(loop.makeRoom()).toBe(false); // everyone is in play: nobody can be let go
    const extra = fighter(createWorld(0), 'extra');
    expect(() => loop.add(extra)).toThrow(/ragdoll/);
    fs[3].state = 'out';
    fs[5].state = 'out';
    expect(loop.makeRoom()).toBe(true);
    expect(fs[3].state).toBe('gone'); // the earliest fallen went first
    expect(fs[5].state).toBe('out');
    expect(loop.size).toBe(MAX_RAGDOLLS - 1);
  });

  test('a fighter whose brain throws is ruled out and let go; the world keeps stepping for the rest', () => {
    const world = ring();
    const match = fightingMatch(['a', 'b']);
    const loop = new RingLoop({ world, match, slowmo: new SlowMo(), tune: TUNE });
    const a = fighter(world, 'a', 'blob', new Vector3(-2, 0, 0));
    const b = fighter(world, 'b', 'tiny', new Vector3(2, 0, 0));
    a.state = b.state = 'fighting';
    loop.add(a);
    loop.add(b);
    const gone = vi.fn();
    loop.onGone = gone;
    vi.spyOn(b, 'think').mockImplementation(() => { throw new Error('a broken brain'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const step = vi.spyOn(world, 'step');
    const r = frames(loop, 1);
    expect(r.outs).toEqual(['b']);
    expect(b.state).toBe('gone');
    expect(loop.get('b')).toBeUndefined();
    expect(gone).toHaveBeenCalledWith(b);
    expect(match.fighting).toEqual(['a']);
    expect(step).toHaveBeenCalledTimes(60);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  test('special cues come up through step, charge to end, named by the fighter', () => {
    const world = ring();
    const match = fightingMatch(['a', 'b']);
    const loop = new RingLoop({ world, match, slowmo: new SlowMo(), tune: TUNE });
    const a = fighter(world, 'a', 'fists', new Vector3(-0.8, 0, 0));
    const b = fighter(world, 'b', 'blob', new Vector3(0.8, 0, 0));
    a.ragdoll.pose(new Vector3(-0.8, 0, 0), Math.PI / 2);
    b.ragdoll.pose(new Vector3(0.8, 0, 0), -Math.PI / 2);
    a.state = b.state = 'fighting';
    loop.add(a);
    loop.add(b);
    frames(loop, 0.3);
    a.special.meter = 1;
    const cues: SpecialCue[] = [];
    const specialHits: Hit[] = [];
    let t = 0.3;
    for (let i = 0; i < 6 * 60 && !cues.some((c) => c.phase === 'end'); i++) {
      t += DT;
      const r = loop.step(DT, t);
      cues.push(...r.specials);
      specialHits.push(...r.hits.filter((h) => h.special));
      if (a.special.active) expect(a.special.meter).toBe(0);
    }
    expect(cues.map((c) => c.phase)).toEqual(['charge', 'release', 'impact', 'end']);
    for (const c of cues) {
      expect(c.id).toBe('a');
      expect(c.special).toBe('megaPunch');
    }
    expect(specialHits.length).toBeGreaterThan(0);
    expect(a.special.active).toBeNull();
  });

  test('a fighter let go mid-special still sends its end', () => {
    const world = ring();
    const match = fightingMatch(['a', 'b']);
    const loop = new RingLoop({ world, match, slowmo: new SlowMo(), tune: TUNE });
    const a = fighter(world, 'a', 'horns', new Vector3(-2, 0, 0));
    const b = fighter(world, 'b', 'blob', new Vector3(2, 0, 0));
    a.state = b.state = 'fighting';
    loop.add(a);
    loop.add(b);
    a.special.meter = 1;
    const first = loop.step(DT * 2, DT * 2);
    expect(first.specials.map((c) => c.phase)).toEqual(['charge']);
    loop.remove('a');
    const next = loop.step(DT, DT * 3);
    expect(next.specials.map((c) => c.phase)).toEqual(['end']);
    expect(next.specials[0].id).toBe('a');
  });

  test('hits are counted per fighter for the crowning', () => {
    const world = ring();
    const match = fightingMatch(['a', 'b']);
    const loop = new RingLoop({ world, match, slowmo: new SlowMo(), tune: TUNE });
    const a = fighter(world, 'a', 'fists', new Vector3(-0.8, 0, 0));
    const b = fighter(world, 'b', 'blob', new Vector3(0.8, 0, 0));
    a.state = b.state = 'fighting';
    loop.add(a);
    loop.add(b);
    const r = frames(loop, 8);
    expect(r.hits.length).toBeGreaterThan(0);
    const hits = loop.hits();
    expect((hits.get('a') ?? 0) + (hits.get('b') ?? 0)).toBe(r.hits.length);
  });
});
