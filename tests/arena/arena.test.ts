import RAPIER from '@dimforge/rapier3d-compat';
import { BoxGeometry, CylinderGeometry, InstancedMesh, Mesh, Scene, SpotLight, TorusGeometry } from 'three/webgpu';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createArena, PIT_Y } from '../../src/arena/arena';
import { BRIDGE_RISE_S, BRIDGE_UP_Y, ENTRY_ANGLE } from '../../src/arena/geometry';
import { TUNE } from '../../src/fight/tune';
import { createWorld, initPhysics } from '../../src/physics/world';

// No DOM here: the ring texture draws on a canvas whose 2D context ignores every call.
const g = globalThis as { document?: unknown };
const had = 'document' in g, before = g.document;
beforeAll(async () => {
  await initPhysics();
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
  g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
});
afterAll(() => { if (had) g.document = before; else delete g.document; });

const build = (tune = { ...TUNE }) => {
  const scene = new Scene(), world = createWorld(20);
  const arena = createArena(scene, world, tune);
  const meshes: Mesh[] = [];
  scene.traverse((o) => { if (o instanceof Mesh) meshes.push(o); });
  return { scene, world, arena, tune, meshes };
};
const cuboids = (w: RAPIER.World) => {
  let n = 0;
  w.colliders.forEach((c) => { if (c.shapeType() === RAPIER.ShapeType.Cuboid) n++; });
  return n;
};

describe('createArena', () => {
  test('adds the ring colliders, seven posts, one instanced pit of ~900 balls, and an entry at −0.55', () => {
    const { world, arena, meshes } = build();
    expect(world.colliders.len()).toBe(57);
    expect(arena.entry.angle).toBe(ENTRY_ANGLE);
    expect(Math.atan2(arena.entry.dir.z, arena.entry.dir.x)).toBeCloseTo(ENTRY_ANGLE);
    const posts = meshes.filter((m) => m.geometry instanceof CylinderGeometry && m.geometry.parameters.height === 2.2);
    expect(posts).toHaveLength(7);
    const pits = meshes.filter((m): m is InstancedMesh => m instanceof InstancedMesh);
    expect(pits).toHaveLength(1);
    expect(pits[0].count).toBeGreaterThanOrEqual(800);
    expect(pits[0].instanceColor).not.toBeNull();
    const y = pits[0].instanceMatrix.array[13]; // the first ball's height
    expect(y).toBeGreaterThan(PIT_Y);
    expect(y).toBeLessThan(PIT_Y + 1);
  });

  test('the spotlight starts off', () => {
    const { arena } = build();
    expect(arena.spot).toBeInstanceOf(SpotLight);
    expect(arena.spot.intensity).toBe(0);
    expect(arena.spot.target.parent).not.toBeNull();
  });

  test('the bridge (9 m, along the entry) is hidden until shown, then rises to the floor and drops away again', () => {
    const { arena, meshes } = build();
    const deck = meshes.find((m) => m.geometry instanceof BoxGeometry)!;
    expect((deck.geometry as BoxGeometry).parameters.width).toBe(9);
    expect(Math.atan2(deck.position.z, deck.position.x)).toBeCloseTo(ENTRY_ANGLE);
    expect(deck.visible).toBe(false);
    arena.bridge.show(true);
    arena.update(BRIDGE_RISE_S / 2);
    expect(deck.visible).toBe(true);
    const mid = deck.position.y;
    arena.update(BRIDGE_RISE_S);
    expect(deck.position.y).toBeCloseTo(BRIDGE_UP_Y);
    expect(mid).toBeLessThan(BRIDGE_UP_Y);
    arena.bridge.show(false);
    arena.update(BRIDGE_RISE_S * 2);
    expect(deck.visible).toBe(false);
  });

  test('follows a live change of tune.bumper: colliders rebuilt (still 56) and the torus rescaled', () => {
    const { arena, world, tune, meshes } = build();
    const torus = meshes.find((m) => m.geometry instanceof TorusGeometry)!;
    const s0 = torus.scale.z;
    tune.bumper = 1.1;
    arena.update(1 / 60);
    expect(cuboids(world)).toBe(56);
    world.colliders.forEach((c) => { if (c.shapeType() === RAPIER.ShapeType.Cuboid) expect(c.halfExtents()!.y).toBeCloseTo(0.55); });
    expect(torus.scale.z).toBeGreaterThan(s0);
    expect(torus.position.y).toBeCloseTo(0.55);
    tune.bumper = 0;
    arena.update(1 / 60);
    expect(cuboids(world)).toBe(0);
    expect(torus.visible).toBe(false);
  });
});
