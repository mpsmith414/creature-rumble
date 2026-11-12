import type RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { addArenaColliders } from '../../src/arena/colliders';
import { ENTRY_ANGLE, entryDir } from '../../src/arena/geometry';
import { buildSkeleton } from '../../src/builder/skeleton';
import { Fighter, type FightCtx } from '../../src/fight/fighter';
import { planFor } from '../../src/fight/moves';
import { TUNE } from '../../src/fight/tune';
import { ENTRANCE_S, GROUP_ENTRANCE_S } from '../../src/match/rules';
import { ragdollLayout } from '../../src/physics/layout';
import { createWorld, initPhysics } from '../../src/physics/world';
import { Entrance, setFrozen, type EntranceCue, type EntranceStage } from '../../src/show/entrance';
import { LAND_IN, SHOW_JUMP, WALK_FROM, WALK_TO } from '../../src/show/timeline';
import { mulberry32 } from '../../src/util/rng';
import { KINDS, loadFixture } from '../fixtures/fighters';

beforeAll(initPhysics);

const DT = 1 / 60;
const R = TUNE.ringRadius;
const DIR = entryDir(ENTRY_ANGLE);
const v = (p: { x: number; y: number; z: number }) => new Vector3(p.x, p.y, p.z);
/** Distance from the ring's centre along the floor. */
const flatR = (p: Vector3) => Math.hypot(p.x, p.z);

/** The ring's colliders in a fresh world (no bridge collider: the walk-in is posed). */
function ring(): RAPIER.World {
  const w = createWorld(TUNE.gravity);
  addArenaColliders(w, TUNE);
  return w;
}

function fighter(w: RAPIER.World, kind: string, id = kind, seed = 1): Fighter {
  const recipe = loadFixture(kind);
  const sk = buildSkeleton(recipe);
  const plan = planFor(recipe, sk);
  return new Fighter(id, w, ragdollLayout(sk, plan), plan, { tune: TUNE, rng: mulberry32(seed) });
}

function stage() {
  return {
    entry: { angle: ENTRY_ANGLE, dir: DIR.clone() },
    bridge: { show: vi.fn<(on: boolean) => void>() },
    spot: { intensity: 0, position: new Vector3(), target: { position: new Vector3() } },
  } satisfies EntranceStage;
}

/** One frame of the fight loop with an entrance running: the entrance poses, every fighter thinks, the world steps. */
function tick(w: RAPIER.World, e: Entrance, fs: Fighter[], ctx: FightCtx, t: number): void {
  e.update(DT);
  for (const f of fs) f.think(DT, t, ctx);
  w.step();
}

/** Each piece's offset from the torso, as the creature stands at rest. */
const restOffsets = (f: Fighter) => f.ragdoll.pieces.map((p) => p.restP.clone().sub(f.ragdoll.torso.restP));
/** The largest gap (m) between where each piece is, relative to the torso, and where it would be at rest (turned as the torso is). */
function bend(f: Fighter, rest: Vector3[]): number {
  const t = v(f.ragdoll.torso.body.translation());
  const r = f.ragdoll.torso.body.rotation();
  const turn = f.ragdoll.torso.restQ.clone().invert().premultiply(new Quaternion(r.x, r.y, r.z, r.w));
  return Math.max(...f.ragdoll.pieces.map((p, i) => v(p.body.translation()).sub(t).distanceTo(rest[i].clone().applyQuaternion(turn))));
}

describe('Entrance (solo)', () => {
  test('after the show-off move ends the entrance keeps posing the fighter until done, then hands it back', () => {
    const w = ring();
    const f = fighter(w, 'horns');
    const s = stage();
    const e = new Entrance(s, TUNE);
    const ctx: FightCtx = { others: [f], boast: false, tune: TUNE, rng: mulberry32(3) };
    const rest = restOffsets(f);
    e.run([f], false);
    expect(f.state).toBe('entering');
    expect(s.bridge.show).toHaveBeenLastCalledWith(true);

    let t = 0, moved = false, ended = -1, worstBend = 0, lowest = Infinity;
    const seen = new Set<string>();
    while (e.active && t < 20) {
      tick(w, e, [f], ctx, t);
      t += DT;
      seen.add(f.attack);
      const settled = ended >= 0; // the move ended before this step: the entrance has posed it whole since
      if (f.attack !== 'none') moved = true;
      else if (moved && ended < 0) ended = t;
      if (settled && e.active) {
        // the move is over and it is still entering: held whole, standing, not sagging
        worstBend = Math.max(worstBend, bend(f, rest));
        lowest = Math.min(lowest, f.ragdoll.pos().y);
        expect(f.state).toBe('entering');
      }
    }
    expect(seen).toContain('strike'); // the signature move played
    expect(ended).toBeGreaterThan(0);
    expect(ended).toBeLessThan(ENTRANCE_S - 0.3); // with time to spare before the entrance ends
    expect(worstBend).toBeLessThan(0.02);
    expect(lowest).toBeGreaterThan(f.ragdoll.torso.restP.y - 0.02);
    expect(t).toBeCloseTo(ENTRANCE_S, 1);
    expect(f.hits).toBe(0);

    // handed back: fighting, standing in the ring just inside the entry, the bridge going down and the spot off
    expect(f.state).toBe('fighting');
    expect(s.bridge.show).toHaveBeenLastCalledWith(false);
    expect(s.spot.intensity).toBe(0);
    const p = f.ragdoll.pos();
    expect(flatR(p)).toBeCloseTo(R - LAND_IN, 0);
    expect(new Vector3(p.x, 0, p.z).normalize().dot(DIR)).toBeGreaterThan(0.95);
    // and its own muscles hold it up from there
    for (let k = 0; k < 90; k++) { f.think(DT, t, ctx); w.step(); t += DT; }
    expect(f.ragdoll.pos().y).toBeGreaterThan(0.7 * f.ragdoll.torso.restP.y);
  });

  test('walks the bridge held up by the pose (there is no bridge collider), then hops over the bumper', () => {
    const w = ring();
    const f = fighter(w, 'fists');
    const e = new Entrance(stage(), TUNE);
    const ctx: FightCtx = { others: [f], boast: false, tune: TUNE, rng: mulberry32(3) };
    const rest = restOffsets(f);
    e.run([f], false);
    const start = flatR(f.ragdoll.pos());
    expect(start).toBeGreaterThan(R + WALK_FROM - 0.5);
    let t = 0, crossed = false;
    const H = f.ragdoll.torso.restP.y;
    while (t < 4.4) {
      tick(w, e, [f], ctx, t); t += DT;
      expect(f.ragdoll.pos().y).toBeGreaterThan(H - 0.02);
      expect(bend(f, rest)).toBeLessThan(0.02); // the walk is posed whole
    }
    expect(flatR(f.ragdoll.pos())).toBeLessThan(R + WALK_TO + 0.5);
    while (e.active) {
      const before = flatR(f.ragdoll.pos());
      tick(w, e, [f], ctx, t); t += DT;
      const now = flatR(f.ragdoll.pos());
      // over the bumper (at R + 0.15): its feet (the pose's root, H below the torso) are above the bumper's top
      if (before >= R + 0.15 && now < R + 0.15) { crossed = true; expect(f.ragdoll.pos().y - H).toBeGreaterThan(TUNE.bumper); }
    }
    expect(crossed).toBe(true);
  });

  test('the signature move shows: the weapon limb swings while the body is held', () => {
    const w = ring();
    const f = fighter(w, 'fists');
    const e = new Entrance(stage(), TUNE);
    const ctx: FightCtx = { others: [f], boast: false, tune: TUNE, rng: mulberry32(3) };
    const rest = restOffsets(f);
    e.run([f], false);
    let t = 0, most = 0;
    while (e.active) {
      tick(w, e, [f], ctx, t); t += DT;
      if (f.attack === 'strike') most = Math.max(most, bend(f, rest));
    }
    expect(most).toBeGreaterThan(0.1);
  });

  test('cues the banners, one TA-DA and the end', () => {
    const w = ring();
    const f = fighter(w, 'tiny');
    const cues: { t: number; c: EntranceCue }[] = [];
    let t = 0;
    const e = new Entrance(stage(), TUNE, (c) => cues.push({ t, c }));
    const ctx: FightCtx = { others: [f], boast: false, tune: TUNE, rng: mulberry32(3) };
    e.run([f], false);
    while (e.active) { tick(w, e, [f], ctx, t); t += DT; }
    expect(cues.map((x) => x.c.type)).toEqual(['maker', 'name', 'taDa', 'done']);
    expect(cues[1].t).toBeCloseTo(1.6, 1);
    expect(cues[2].t).toBeGreaterThan(4.5);
    expect(cues[2].t).toBeLessThan(6);
  });
});

describe('Entrance (group)', () => {
  test('walks in single file, champion last, and lands everyone apart inside the ring after ~5 s', () => {
    const w = ring();
    const fs = ['fists', 'tiny', 'legs'].map((k, i) => fighter(w, k, k, i + 1));
    const champ = fs[0];
    const e = new Entrance(stage(), TUNE);
    const ctx: FightCtx = { others: fs, boast: false, tune: TUNE, rng: mulberry32(3) };
    e.run(fs, true, champ);
    let t = 0;
    while (t < 2.5 - DT / 2) { tick(w, e, fs, ctx, t); t += DT; }
    // end of the walk: in file along the bridge, 1.2 m apart, the champion at the back
    const rs = fs.map((f) => flatR(e.spotOf(f)!));
    const order = [...fs].sort((a, b) => flatR(e.spotOf(a)!) - flatR(e.spotOf(b)!));
    for (const f of fs) expect(e.spotOf(f)!.clone().normalize().dot(DIR)).toBeCloseTo(1); // on the entry line
    expect(order.at(-1)).toBe(champ);
    const sorted = [...rs].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeCloseTo(1.2, 1);
    expect(sorted[0]).toBeCloseTo(R + WALK_TO, 1);
    while (e.active) { tick(w, e, fs, ctx, t); t += DT; }
    expect(t).toBeCloseTo(GROUP_ENTRANCE_S, 1);
    for (const f of fs) {
      expect(f.state).toBe('fighting');
      expect(flatR(f.ragdoll.pos())).toBeLessThan(R - 1);
    }
    for (let i = 0; i < fs.length; i++) {
      for (let j = i + 1; j < fs.length; j++) expect(fs[i].ragdoll.pos().setY(0).distanceTo(fs[j].ragdoll.pos().setY(0))).toBeGreaterThan(1.1);
    }
  });

  test('an arrival joining a running entrance upgrades it to a group: the walker keeps going, the clock restarts', () => {
    const w = ring();
    const a = fighter(w, 'fists', 'a', 1), b = fighter(w, 'blob', 'b', 2);
    const e = new Entrance(stage(), TUNE);
    const ctx: FightCtx = { others: [a, b], boast: false, tune: TUNE, rng: mulberry32(3) };
    e.run([a], false);
    let t = 0;
    while (t < 1) { tick(w, e, [a], ctx, t); t += DT; }
    const was = flatR(e.spotOf(a)!);
    e.run([a, b], true);
    expect(e.group).toBe(true);
    expect(flatR(e.spotOf(a)!)).toBeLessThanOrEqual(was + 1e-6); // not sent back up the bridge
    expect(flatR(e.spotOf(b)!)).toBeGreaterThanOrEqual(flatR(e.spotOf(a)!) + 1.2 - 1e-6); // the newcomer a gap behind
    const from = t;
    while (e.active) { tick(w, e, [a, b], ctx, t); t += DT; }
    expect(t - from).toBeCloseTo(GROUP_ENTRANCE_S, 1);
    expect(a.state).toBe('fighting');
    expect(b.state).toBe('fighting');
  });
});

describe('Entrance: after the hand-back', () => {
  /** How upright the torso is: its up axis's height (1 = straight up, 0 = lying down). */
  const upright = (f: Fighter) => {
    const r = f.ragdoll.torso.body.rotation();
    const turn = new Quaternion(r.x, r.y, r.z, r.w).multiply(f.ragdoll.torso.restQ.clone().invert());
    return new Vector3(0, 1, 0).applyQuaternion(turn).y;
  };

  test.each(KINDS)('%s, alone in the ring, stands and boasts: upright 2 s after the hand-back, and never left lying', (k) => {
    const w = ring();
    const f = fighter(w, k);
    const e = new Entrance(stage(), TUNE);
    const ctx: FightCtx = { others: [f], boast: true, tune: TUNE, rng: mulberry32(5) }; // the lone boast
    e.run([f], false);
    let t = 0;
    while (e.active) { tick(w, e, [f], ctx, t); t += DT; }
    expect(f.state).toBe('fighting');
    const H = f.ragdoll.torso.restP.y, handBack = t;
    let lowest = Infinity, idleUp = Infinity, sinceMove = Infinity;
    while (t < handBack + 8) {
      f.think(DT, t, ctx); w.step(); t += DT;
      sinceMove = f.attack === 'none' ? sinceMove + DT : 0;
      lowest = Math.min(lowest, f.ragdoll.pos().y);
      // between boasts (once a move has had 0.5 s to settle) it stands
      if (sinceMove > 0.5) idleUp = Math.min(idleUp, upright(f));
      if (Math.abs(t - handBack - 2) < DT / 2 && f.attack === 'none') expect(upright(f)).toBeGreaterThan(0.9);
      if (Math.abs(t - handBack - 1.4) < DT / 2) expect(upright(f)).toBeGreaterThan(0.95); // before its first strut
    }
    expect(idleUp).toBeGreaterThan(0.9);
    expect(lowest).toBeGreaterThan(0.6 * H); // held up throughout (a tail spin tips its torso sideways, never down)
  });
});

describe('Entrance: what the camera follows', () => {
  test('the lift (bounce, jump, hop), the fighter’s height and the swing to the show-off shot', () => {
    const w = ring();
    const f = fighter(w, 'legs');
    const e = new Entrance(stage(), TUNE);
    const ctx: FightCtx = { others: [f], boast: false, tune: TUNE, rng: mulberry32(3) };
    e.run([f], false);
    expect(e.height).toBe(f.layout.ringHeight);
    expect(e.side).toBe(0);
    let t = 0, most = 0, sideAtShow = 0;
    while (e.active) {
      tick(w, e, [f], ctx, t); t += DT;
      if (e.phase === 'showOff') { most = Math.max(most, e.lift); sideAtShow = e.side; }
      // the torso rides the lift: feet (the ground point) + lift + the torso's own height
      if (e.active) expect(f.ragdoll.pos().y).toBeCloseTo(e.lift + f.ragdoll.torso.restP.y, 1);
    }
    expect(most).toBeCloseTo(SHOW_JUMP * f.layout.ringHeight, 1);
    expect(sideAtShow).toBe(1);
  });

  test('a member gone mid-entrance (left the page) does not pull the focus toward the ring’s middle', () => {
    const w = ring();
    const a = fighter(w, 'fists', 'a', 1), b = fighter(w, 'tiny', 'b', 2);
    const e = new Entrance(stage(), TUNE);
    e.run([a, b], true);
    b.dispose(); // state 'gone'
    e.update(DT);
    expect(e.focus.distanceTo(e.spotOf(a)!)).toBeLessThan(1e-9);
  });

  test('upgrading a walking champion’s entrance never sends it back up the bridge; the newcomer walks in front of it', () => {
    const w = ring();
    const champ = fighter(w, 'blob', 'champ', 1), other = fighter(w, 'tiny', 'other', 2), late = fighter(w, 'fists', 'late', 3);
    const e = new Entrance(stage(), TUNE);
    const ctx: FightCtx = { others: [champ, other, late], boast: false, tune: TUNE, rng: mulberry32(3) };
    e.run([champ, other], true, champ); // "Again!": the champion at the back
    let t = 0;
    while (t < 1) { tick(w, e, [champ, other], ctx, t); t += DT; }
    const was = flatR(e.spotOf(champ)!);
    e.run([champ, other, late], true, champ); // someone joins within the share window
    const now = flatR(e.spotOf(champ)!);
    expect(now).toBeLessThanOrEqual(was + 1e-6);
    // between the two already walking (with too little room for a full gap, they share what there is)
    expect(flatR(e.spotOf(late)!)).toBeLessThan(now - 0.4);
    expect(flatR(e.spotOf(late)!)).toBeGreaterThan(flatR(e.spotOf(other)!) + 0.4);
    while (e.active) { tick(w, e, [champ, other, late], ctx, t); t += DT; }
    const order = [champ, other, late].map((f) => f.state);
    expect(order).toEqual(['fighting', 'fighting', 'fighting']);
  });
});

describe('setFrozen', () => {
  test('freezes fighters mid-flail and lets them carry on as they were', () => {
    const w = ring();
    const f = fighter(w, 'tiny');
    f.ragdoll.pose(new Vector3(0, 2, 0), 0);
    f.ragdoll.torso.body.setLinvel({ x: 2, y: 3, z: 0 }, true);
    w.step();
    const at = f.ragdoll.pos(), vel = f.ragdoll.vel();
    setFrozen([f], true);
    for (let i = 0; i < 30; i++) w.step();
    expect(f.ragdoll.pos().distanceTo(at)).toBe(0);
    setFrozen([f], false);
    expect(f.ragdoll.vel().distanceTo(vel)).toBeLessThan(1e-6);
    w.step();
    expect(f.ragdoll.pos().x).toBeGreaterThan(at.x);
  });
});
