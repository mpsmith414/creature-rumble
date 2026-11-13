import type RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three/webgpu';
import { beforeAll, expect, test } from 'vitest';
import { addArenaColliders } from '../../src/arena/colliders';
import { buildSkeleton } from '../../src/builder/skeleton';
import { Fighter, type FightCtx } from '../../src/fight/fighter';
import { planFor } from '../../src/fight/moves';
import { TUNE } from '../../src/fight/tune';
import { ragdollLayout } from '../../src/physics/layout';
import type { Piece } from '../../src/physics/ragdoll';
import { createWorld, initPhysics } from '../../src/physics/world';
import { mulberry32 } from '../../src/util/rng';
import { KINDS, loadFixture } from '../fixtures/fighters';

beforeAll(initPhysics);

const DT = 1 / 60;
const UP = new Vector3(0, 1, 0);
/**
 * A head may be squashed under its neck for a moment by a foe landing on it from a pop-up (big fights), never longer
 * than this (s): a neck that fails holds the head down for good.
 */
const SQUASHED_S = 0.25;
/** Seconds after a stun (or a flight) before a fighter counts as standing: the scramble back up plus a breath. */
const SETTLE = TUNE.recoverS + 0.25;

function fighter(w: RAPIER.World, kind: string, id: string, at: Vector3, yaw: number, seed: number): Fighter {
  const recipe = loadFixture(kind);
  const sk = buildSkeleton(recipe);
  const plan = planFor(recipe, sk);
  const f = new Fighter(id, w, ragdollLayout(sk, plan), plan, { tune: TUNE, rng: mulberry32(seed) });
  f.ragdoll.pose(at, yaw);
  f.state = 'fighting';
  return f;
}

/** The piece's up (its rest pose's up, turned as the piece is turned now) · world up. */
function upness(p: Piece): number {
  const r = p.body.rotation();
  const q = new Quaternion(r.x, r.y, r.z, r.w).multiply(p.restQ.clone().invert());
  return UP.clone().applyQuaternion(q).dot(UP);
}

/** Where the piece hangs from its parent (its joint), in the world. */
function neckOf(p: Piece): Vector3 {
  const r = p.body.rotation(), t = p.body.translation();
  const local = new Vector3(p.seg.anchor.x, p.seg.anchor.y, p.seg.anchor.z).sub(p.restP).applyQuaternion(p.restQ.clone().invert());
  return local.applyQuaternion(new Quaternion(r.x, r.y, r.z, r.w)).add(new Vector3(t.x, t.y, t.z));
}

/**
 * A 10 s duel against another kind. "Standing" = fighting, on the ring, torso upright (not lying: the tail's spin lays
 * its own torso nearly flat), not stunned (nor limp from a launch) and past the scramble back up plus a breath. A
 * stunned head may flop; a standing one keeps its head up and over its neck.
 */
test.each(KINDS)('%s keeps its head up while it moves and fights', (kind) => {
  const w = createWorld(TUNE.gravity);
  addArenaColliders(w, TUNE);
  try {
    const foe = KINDS[(KINDS.indexOf(kind) + 3) % KINDS.length];
    const a = fighter(w, kind, `${kind}-1`, new Vector3(-1.5, 0, 0), Math.PI / 2, 1);
    const b = fighter(w, foe, `${foe}-2`, new Vector3(1.5, 0, 0), -Math.PI / 2, 2);
    const fs = [a, b];
    const ctx: FightCtx = { others: fs, boast: false, tune: TUNE, rng: mulberry32(7) };
    const lastStun = new Map<Fighter, number>(fs.map((f) => [f, -Infinity]));
    let t = 0, standing = 0, steady = 0, up = 0, hung = 0, attacks = 0, travel = 0;
    const was = a.ragdoll.pos();
    const hangs: string[] = [];
    const hungFor = new Map<Fighter, number>();
    while (t < 10) {
      for (const f of fs) f.think(DT, t, ctx);
      w.step();
      t += DT;
      if (a.attack === 'strike') attacks++;
      const p = a.ragdoll.pos();
      travel += Math.hypot(p.x - was.x, p.z - was.z);
      was.copy(p);
      for (const f of fs) {
        if (f.stun > 0) lastStun.set(f, t);
        const head = f.ragdoll.head!;
        if (f.state !== 'fighting' || f.ragdoll.pos().y < 0 || f.stun > 0) continue;
        steady++; // not stunned, on the ring
        if (upness(f.ragdoll.torso) <= 0.5 || t - lastStun.get(f)! < SETTLE) continue;
        standing++;
        if (upness(head) > 0.5) up++;
        if (head.body.translation().y < neckOf(head).y) {
          const run = (hungFor.get(f) ?? 0) + 1;
          hungFor.set(f, run);
          if (run * DT > SQUASHED_S) {
            hung++;
            if (hangs.length < 3) hangs.push(`${f.id} at ${t.toFixed(2)} s`);
          }
        } else hungFor.set(f, 0);
      }
    }
    expect(travel, 'it moved about').toBeGreaterThan(1);
    expect(attacks, 'it fought').toBeGreaterThan(0);
    expect(standing, 'enough standing to judge').toBeGreaterThan(3 / DT);
    expect(standing / steady, 'standing is most of the time not stunned (the exclusions swallow little)').toBeGreaterThan(0.5);
    expect(up / standing, 'head up (up · world up > 0.5) on 95% of standing steps').toBeGreaterThanOrEqual(0.95);
    expect(hung, `head never below its neck for long while standing: ${hangs.join(', ')}`).toBe(0);
  } finally {
    w.free();
  }
}, 30_000);

/**
 * Knocked flat, a head is not held: its neck lets go while stunned (str 0), so it flops about on its joint. Over three
 * hard knocks a flopping head is tipped over (up · world up < 0.5) on 65–85% of stunned steps and ends up upside down;
 * a neck still holding through the stun keeps it tipped on under 5%, never past 0.1.
 */
test.each(KINDS)('%s: a stunned head flops', (kind) => {
  const w = createWorld(TUNE.gravity);
  addArenaColliders(w, TUNE);
  try {
    const f = fighter(w, kind, `${kind}-1`, new Vector3(0, 0, 0), 0, 3);
    const ctx: FightCtx = { others: [f], boast: false, tune: TUNE, rng: mulberry32(5) };
    let t = 0, stunned = 0, lowest = 1, down = 0;
    const run = (secs: number) => {
      for (const end = t + secs; t < end - 1e-9;) {
        f.think(DT, t, ctx);
        w.step();
        t += DT;
        if (f.stun <= 0) continue;
        const u = upness(f.ragdoll.head!);
        stunned++;
        lowest = Math.min(lowest, u);
        if (u < 0.5) down++;
      }
    };
    run(1);
    for (const from of [new Vector3(-1, 0.5, 0), new Vector3(0, 0.5, 1), new Vector3(1, 0.5, -1)]) {
      f.knock(f.ragdoll.pos().add(from), 6);
      run(2.5);
    }
    expect(stunned, 'it was stunned').toBeGreaterThan(1 / DT);
    expect(down / stunned, 'stunned steps with the head tipped over').toBeGreaterThan(0.3);
    expect(lowest, 'the head goes past sideways').toBeLessThan(0);
  } finally {
    w.free();
  }
}, 30_000);
