import { InstancedMesh, Matrix4, Object3D, Scene, Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, test } from 'vitest';
import { buildSkeleton } from '../../src/builder/skeleton';
import { Fighter } from '../../src/fight/fighter';
import { planFor } from '../../src/fight/moves';
import { TUNE } from '../../src/fight/tune';
import { ragdollLayout } from '../../src/physics/layout';
import { createWorld, initPhysics } from '../../src/physics/world';
import { CONFETTI, Finale } from '../../src/show/finale';
import { mulberry32 } from '../../src/util/rng';
import { KINDS, loadFixture } from '../fixtures/fighters';

beforeAll(initPhysics);

const R = TUNE.ringRadius;

/** A fixture fighter standing at `at` (posed, no physics step). */
function standing(kind: string, at: Vector3): Fighter {
  const recipe = loadFixture(kind), sk = buildSkeleton(recipe), plan = planFor(recipe, sk);
  const f = new Fighter(kind, createWorld(TUNE.gravity), ragdollLayout(sk, plan), plan, { tune: TUNE, rng: mulberry32(1) });
  f.ragdoll.pose(at, 0);
  f.state = 'fighting';
  return f;
}
const named = (scene: Scene, name: string) => scene.getObjectByName(name)!;
/** The highest point of a fighter standing at rest (m). */
const topOf = (f: Fighter) => Math.max(...f.ragdoll.pieces.map((p) => Math.max(p.seg.a.y, p.seg.b.y) + p.seg.radius));

describe('Finale', () => {
  test.each(KINDS)('crowns %s: the crown sits on top of it, big enough to see, and rides along', (k) => {
    const scene = new Scene(), finale = new Finale(scene, { ringRadius: R, rng: mulberry32(2) });
    const at = new Vector3(1, 0, -1), f = standing(k, at);
    finale.crown(f);
    finale.update(1 / 60);
    const crown = named(scene, 'crown');
    expect(crown.visible).toBe(true);
    const H = f.layout.ringHeight;
    // on top: no lower than 85% of the body's highest point, no higher than a crown's height above it
    expect(crown.position.y).toBeGreaterThan(0.85 * topOf(f));
    expect(crown.position.y).toBeLessThan(topOf(f) + 0.5 * H);
    expect(Math.hypot(crown.position.x - at.x, crown.position.z - at.z)).toBeLessThan(0.5 * H);
    expect(crown.scale.x * 0.35).toBeGreaterThanOrEqual(0.14 * H - 1e-9); // its band is at least 14% of the height across
    // it rides the fighter
    f.ragdoll.pose(new Vector3(-2, 0, 2), 0);
    finale.update(1 / 60);
    expect(Math.hypot(crown.position.x + 2, crown.position.z - 2)).toBeLessThan(0.5 * H);
  });

  test('400 confetti pieces in one instanced mesh, never culled, raining over the champion then lying on the ring round it', () => {
    const scene = new Scene(), finale = new Finale(scene, { ringRadius: R, rng: mulberry32(3) });
    const at = new Vector3(2, 0, 1), f = standing('tiny', at), H = f.layout.ringHeight;
    finale.crown(f);
    const confetti = named(scene, 'confetti') as InstancedMesh;
    expect(confetti).toBeInstanceOf(InstancedMesh);
    expect(confetti.count).toBe(CONFETTI);
    expect(CONFETTI).toBe(400);
    expect(confetti.visible).toBe(true);
    expect(confetti.frustumCulled).toBe(false);
    const m = new Matrix4(), p = new Vector3();
    const where = (i: number) => p.setFromMatrixPosition((confetti.getMatrixAt(i, m), m)).clone();
    const torso = f.ragdoll.pos(); // the shower is centred over the champion's body
    for (let i = 0; i < CONFETTI; i++) {
      const q = where(i);
      expect(q.y).toBeGreaterThan(H); // starts over the champion's head
      expect(Math.hypot(q.x - torso.x, q.z - torso.z)).toBeLessThan(Math.max(1, 1.5 * H) + 1e-6);
    }
    // halfway down some is still in the air round the champion's height
    for (let t = 0; t < 1; t += 1 / 60) finale.update(1 / 60);
    let near = 0;
    for (let i = 0; i < CONFETTI; i++) if (where(i).y < 3 * H + 2) near++;
    expect(near).toBeGreaterThan(CONFETTI / 4);
    for (let t = 0; t < 9; t += 1 / 60) finale.update(1 / 60);
    let onRing = 0;
    for (let i = 0; i < CONFETTI; i++) {
      const q = where(i);
      if (Math.hypot(q.x, q.z) < R) {
        expect(q.y).toBeGreaterThan(0); // never under the ring's top
        expect(q.y).toBeLessThan(0.05);
        if (Math.hypot(q.x - at.x, q.z - at.z) < 4) onRing++;
      }
    }
    expect(onRing).toBeGreaterThan(0.9 * CONFETTI);
    expect(confetti.visible).toBe(true); // it stays down on the ring
    expect(named(scene, 'podium-glow').visible).toBe(true);
  });

  test('dispose takes it all out of the scene', () => {
    const scene = new Scene(), finale = new Finale(scene);
    finale.crown(standing('blob', new Vector3()));
    finale.dispose();
    const left: Object3D[] = [];
    scene.traverse((o) => { if (o !== scene) left.push(o); });
    expect(left).toEqual([]);
  });
});
