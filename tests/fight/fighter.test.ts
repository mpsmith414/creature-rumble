import type RAPIER from '@dimforge/rapier3d-compat';
import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, it, test } from 'vitest';
import { addArenaColliders } from '../../src/arena/colliders';
import { buildSkeleton } from '../../src/builder/skeleton';
import { Fighter, type FightCtx, type Hit } from '../../src/fight/fighter';
import { planFor } from '../../src/fight/moves';
import { MOVE_POWER, MOVE_TIMING, TUNE, knockMultiplier, speedFor } from '../../src/fight/tune';
import { ragdollLayout } from '../../src/physics/layout';
import { createWorld, initPhysics } from '../../src/physics/world';
import { mulberry32 } from '../../src/util/rng';
import { loadFixture } from '../fixtures/fighters';

beforeAll(initPhysics);

const DT = 1 / 60;
const R = TUNE.ringRadius;

/** The ring (floor + bumper) in a fresh world, as the arena builds it. */
function ring(): RAPIER.World {
  const w = createWorld(TUNE.gravity);
  addArenaColliders(w, TUNE);
  return w;
}

/** A fighter from a fixture, standing on the ground point `at`, facing `yaw`, already fighting. */
function fighter(w: RAPIER.World, kind: string, at: Vector3, yaw = 0, seed = 1): Fighter {
  const recipe = loadFixture(kind);
  const sk = buildSkeleton(recipe);
  const plan = planFor(recipe, sk);
  const f = new Fighter(kind, w, ragdollLayout(sk, plan), plan, { tune: TUNE, rng: mulberry32(seed) });
  f.ragdoll.pose(at, yaw);
  f.state = 'fighting';
  return f;
}

/** Runs the fight loop (every fighter thinks, then the world steps) for `secs`; `each` sees every tick. */
function run(w: RAPIER.World, fs: Fighter[], secs: number, opts: { from?: number; boast?: boolean; seed?: number; each?: (t: number, hits: Hit[]) => void } = {}): number {
  const ctx: FightCtx = { others: fs, boast: opts.boast ?? false, tune: TUNE, rng: mulberry32(opts.seed ?? 7) };
  let t = opts.from ?? 0;
  const end = t + secs;
  while (t < end - 1e-9) {
    const hits = fs.flatMap((f) => f.think(DT, t, ctx));
    w.step();
    t += DT;
    opts.each?.(t, hits);
  }
  return t;
}

/**
 * Lays a fighter on its back along the bumper, limbs hanging either side: its torso at r = R + 0.2 (over the bumper's
 * middle, R + 0.15), resting on top (y = bumper + torso radius).
 */
function layOnBumper(f: Fighter): void {
  // creature up → along the edge (+z at angle 0), creature forward → up, creature right → in toward the centre
  const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 1, 0)));
  const torso = f.ragdoll.torso;
  const at = new Vector3(R + 0.2, TUNE.bumper + torso.seg.radius, 0);
  for (const p of f.ragdoll.pieces) {
    const pos = p.restP.clone().sub(torso.restP).applyQuaternion(q).add(at);
    const rq = q.clone().multiply(p.restQ);
    p.body.setTranslation(pos, true);
    p.body.setRotation({ x: rq.x, y: rq.y, z: rq.z, w: rq.w }, true);
  }
}

describe('tuning', () => {
  test('fresh fighters are hard to shift, wobbly ones fly', () => {
    expect(knockMultiplier(0, 0.035)).toBeCloseTo(0.3);
    expect(knockMultiplier(40, 0.035)).toBeCloseTo(1.7);
  });

  it('holds the balanced numbers (npm run balance; the spike started from knock 0.6, flop 1, recover 0.7)', () => {
    expect(TUNE).toEqual({ knock: 0.45, flop: 0.75, bounce: 0.15, gravity: 20, build: 0.045, heal: 0.05, bumper: 0.65, ringRadius: 6.5, recoverS: 0.5, edgeMargin: 2.5, spin: 1 });
    expect(MOVE_TIMING.punch).toEqual([0.45, 0.75, 0.4]);
    expect(MOVE_TIMING.divebomb).toEqual([0.45, 1.0, 0.8]);
    expect(MOVE_POWER).toEqual({ punch: 2.8, jab: 1.35, kick: 2.55, bump: 1.85, headbutt: 3.2, spin: 3.2, divebomb: 2.95 });
  });

  it('small fighters scurry, big ones lumber, within limits', () => {
    expect(speedFor(1.4)).toBeCloseTo(4.5);
    expect(speedFor(0.7)).toBeCloseTo(4.5 * Math.SQRT2);
    expect(speedFor(0.1)).toBeCloseTo(4.5 * 1.6);
    expect(speedFor(2.4)).toBeCloseTo(4.5 * 0.764, 2);
    expect(speedFor(10)).toBeCloseTo(4.5 * 0.75);
  });
});

describe('Fighter', () => {
  test('a lone fighter stands for 10 s', () => {
    const w = ring();
    const f = fighter(w, 'fists', new Vector3(0, 0, 0));
    const H = f.ragdoll.pos().y; // posed standing: the torso at its stand height
    let lo = Infinity, hi = -Infinity;
    run(w, [f], 10, { each: (t) => { if (t >= 2) { const y = f.ragdoll.pos().y; lo = Math.min(lo, y); hi = Math.max(hi, y); } } });
    expect(lo).toBeGreaterThan(0.85 * H);
    expect(hi).toBeLessThan(1.15 * H);
    expect(f.state).toBe('fighting');
  });

  test('two fighters land hits within 10 s', () => {
    const w = ring();
    const a = fighter(w, 'fists', new Vector3(-1.5, 0, 0), Math.PI / 2, 1);
    const b = fighter(w, 'blob', new Vector3(1.5, 0, 0), -Math.PI / 2, 2);
    const all: Hit[] = [];
    run(w, [a, b], 10, { each: (_t, h) => all.push(...h) });
    expect(a.hits + b.hits).toBeGreaterThan(0);
    expect(all).toHaveLength(a.hits + b.hits);
    for (const h of all) {
      expect(h.attacker).not.toBe(h.target);
      expect(h.power).toBeCloseTo(MOVE_POWER[h.attacker.plan.move] * TUNE.knock);
      expect(h.launch).toBeGreaterThan(0);
      expect(Number.isFinite(h.at.x + h.at.y + h.at.z)).toBe(true);
    }
  });

  test('a hit raises wobble by its power and launches by the knockback rule', () => {
    const w = ring();
    const f = fighter(w, 'tail', new Vector3(0, 0, 0));
    const hits: Hit[] = [];
    const g = fighter(w, 'horns', new Vector3(0, 0, 1.2), Math.PI, 3);
    run(w, [g, f], 10, { each: (_t, h) => hits.push(...h.filter((x) => x.target === f)) });
    expect(hits.length).toBeGreaterThan(0);
    let wobble = 0;
    for (const h of hits) {
      wobble += h.power;
      // what the first hit launched by, given the wobble it had then (healing is slow over a few seconds)
      if (h === hits[0]) expect(h.launch).toBeCloseTo((h.power * 2.6 * knockMultiplier(h.power, TUNE.build)) / f.ragdoll.mass ** 0.3, 3);
    }
    expect(f.wobble).toBeGreaterThan(wobble - 10 * TUNE.heal - 1e-9);
    expect(f.wobble).toBeLessThanOrEqual(wobble);
  });

  test('stun makes the fighter go limp then stand again', () => {
    const w = ring();
    const f = fighter(w, 'fists', new Vector3(0, 0, 0));
    const H = f.ragdoll.pos().y;
    let t = run(w, [f], 2);
    f.knock(f.ragdoll.pos().add(new Vector3(-1, 0, 0)), 3);
    const stun = f.stun;
    expect(stun).toBeCloseTo(TUNE.flop * (0.45 + 3 * 0.18));
    const knockedAt = t;
    let down = -1, up = -1;
    t = run(w, [f], stun + 1.5, {
      from: t,
      each: (now) => {
        const y = f.ragdoll.pos().y;
        if (down < 0 && y < 0.6 * H) down = now;
        if (down >= 0 && up < 0 && y > 0.85 * H) up = now;
      },
    });
    expect(down).toBeGreaterThan(0);
    expect(down - knockedAt).toBeLessThan(stun);
    expect(up).toBeGreaterThan(down);
    expect(up - knockedAt).toBeLessThanOrEqual(stun + 1.5);
    expect(f.stun).toBeLessThanOrEqual(0);
  });

  test('fighter lying on the bumper is nudged off within 4 s', () => {
    const w = ring();
    const f = fighter(w, 'fists', new Vector3(0, 0, 0));
    layOnBumper(f);
    f.stun = Infinity; // limp for good: no muscles, only the bumper rule can move it
    let fell = -1;
    run(w, [f], 4, { each: (t) => { if (fell < 0 && f.ragdoll.pos().y < -2.5) fell = t; } });
    expect(fell).toBeGreaterThan(3); // it lay there the full 3 s first
    expect(fell).toBeLessThan(4);
  });

  test('a limp fighter left on the bumper stays there without the rule', () => {
    // the same placement, but nobody thinks: it really does rest on the bumper (so the rule above is what moves it)
    const w = ring();
    const f = fighter(w, 'fists', new Vector3(0, 0, 0));
    layOnBumper(f);
    for (let i = 0; i < 240; i++) w.step();
    const p = f.ragdoll.pos();
    expect(p.y).toBeGreaterThan(TUNE.bumper);
    expect(Math.hypot(p.x, p.z)).toBeGreaterThan(R);
  });

  test('showing off plays the signature move without hitting anyone, then fights as normal', () => {
    const [wind, strike, cool] = MOVE_TIMING.punch;
    const showEnd = wind + strike + cool * 0.7; // the earliest a cool-down can end (× 0.7–1.3)
    const setup = () => {
      const w = ring();
      const a = fighter(w, 'fists', new Vector3(-0.7, 0, 0), Math.PI / 2, 1);
      const b = fighter(w, 'horns', new Vector3(0.7, 0, 0), -Math.PI / 2, 2); // its headbutt winds up slower than a punch
      return { w, a, b };
    };
    // control: the same start without showing off lands a punch in that window
    {
      const { w, a, b } = setup();
      run(w, [a, b], showEnd);
      expect(a.hits).toBeGreaterThan(0);
    }
    const { w, a, b } = setup();
    a.showOff();
    expect(a.attack).toBe('windup');
    const phases = new Set<string>();
    run(w, [a, b], showEnd, { each: () => phases.add(a.attack) });
    expect(a.hits).toBe(0);
    expect([...phases]).toEqual(expect.arrayContaining(['windup', 'strike', 'cool']));
    // back to normal: the show-off ends and the next punches land
    run(w, [a, b], 10, { from: showEnd });
    expect(a.hits).toBeGreaterThan(0);
  });

  test('a fighter still entering only moves for a show-off', () => {
    const w = ring();
    const f = fighter(w, 'horns', new Vector3(0, 0, 0));
    f.state = 'entering';
    const ctx: FightCtx = { others: [f], boast: false, tune: TUNE, rng: mulberry32(1) };
    expect(f.think(DT, 0, ctx)).toEqual([]);
    expect(f.attack).toBe('none');
    f.showOff();
    const H = f.ragdoll.pos().y;
    let t = 0, low = Infinity;
    const seen = new Set<string>();
    // until the move is over (after it an entering fighter has no muscles: the entrance poses it — tests/show/entrance.test.ts)
    while (t < 3 && f.attack !== 'none') {
      f.think(DT, t, ctx); w.step(); t += DT; seen.add(f.attack);
      low = Math.min(low, f.ragdoll.pos().y);
    }
    expect(seen).toContain('strike');
    expect(f.attack).toBe('none'); // the show-off ends by itself
    expect(f.state).toBe('entering');
    expect(low).toBeGreaterThan(0.85 * H); // it held itself up to show the move
  });
});
