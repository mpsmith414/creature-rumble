import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three/webgpu';
import { beforeAll, expect, test } from 'vitest';
import { addArenaColliders } from '../../src/arena/colliders';
import { TUNE } from '../../src/fight/tune';
import { createWorld, initPhysics } from '../../src/physics/world';

beforeAll(initPhysics);

const cuboids = (w: RAPIER.World) => {
  const out: RAPIER.Collider[] = [];
  w.colliders.forEach((c) => { if (c.shapeType() === RAPIER.ShapeType.Cuboid) out.push(c); });
  return out;
};

test('bumper has 56 segments at the configured height', () => {
  const w = createWorld(20);
  addArenaColliders(w, { ...TUNE, bumper: 0.65 });
  const segs = cuboids(w);
  expect(segs).toHaveLength(56);
  expect(w.colliders.len()).toBe(57); // and the ring top
  for (const c of segs) {
    expect(c.halfExtents()!.y).toBeCloseTo(0.65 / 2);
    const t = c.translation();
    expect(Math.hypot(t.x, t.z)).toBeCloseTo(TUNE.ringRadius + 0.15);
    expect(t.y).toBeCloseTo(0.65 / 2);
    const r = c.rotation(); // thin side out, long side along the edge
    const out = new Vector3(1, 0, 0).applyQuaternion(new Quaternion(r.x, r.y, r.z, r.w));
    expect(out.dot(new Vector3(t.x, 0, t.z).normalize())).toBeCloseTo(1);
    expect(c.friction()).toBeCloseTo(0.3);
    expect(c.restitution()).toBeCloseTo(TUNE.bumperBounce);
    expect(c.restitutionCombineRule()).toBe(RAPIER.CoefficientCombineRule.Max);
  }
});

test('rebuilding the bumper replaces, not adds', () => {
  const w = createWorld(20);
  const arena = addArenaColliders(w, TUNE);
  arena.rebuildBumper(0.8);
  arena.rebuildBumper(0.8);
  const segs = cuboids(w);
  expect(segs).toHaveLength(56);
  for (const c of segs) expect(c.halfExtents()!.y).toBeCloseTo(0.4);
  expect(w.colliders.len()).toBe(57);
  arena.rebuildBumper(0); // no bumper at all
  expect(cuboids(w)).toHaveLength(0);
  expect(w.colliders.len()).toBe(1);
});

test('a ball dropped inside the ring rests on top at y≈0', () => {
  const w = createWorld(20);
  addArenaColliders(w, TUNE);
  const body = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(2, 2, -1));
  w.createCollider(RAPIER.ColliderDesc.ball(0.25), body);
  for (let i = 0; i < 240; i++) w.step();
  expect(body.translation().y).toBeCloseTo(0.25, 1);
  let top: RAPIER.Collider | null = null;
  w.colliders.forEach((c) => { if (c.shapeType() === RAPIER.ShapeType.Cylinder) top = c; });
  expect(top).not.toBeNull();
  const t = top as unknown as RAPIER.Collider;
  expect(t.radius()).toBeCloseTo(TUNE.ringRadius);
  expect(t.translation().y + t.halfHeight()).toBeCloseTo(0);
  expect(t.friction()).toBeCloseTo(0.9);
  expect(t.restitution()).toBeCloseTo(TUNE.floorBounce);
  expect(t.restitutionCombineRule()).toBe(RAPIER.CoefficientCombineRule.Max);
});
