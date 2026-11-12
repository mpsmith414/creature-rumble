import { beforeAll, describe, expect, it, test } from 'vitest';
import { Quaternion, Vector3 } from 'three/webgpu';
import { buildSkeleton } from '../../src/builder/skeleton';
import { MAX_SEGMENTS, ragdollLayout } from '../../src/physics/layout';
import { Ragdoll } from '../../src/physics/ragdoll';
import { createWorld, initPhysics } from '../../src/physics/world';
import { KINDS, loadFixture } from '../fixtures/fighters';
import { monster48Parts } from '../fixtures/monster';
import { floor } from '../fixtures/physics';

const layoutOf = (k: string) => ragdollLayout(buildSkeleton(loadFixture(k)), loadFixture(k).fight!);
const v = (p: { x: number; y: number; z: number }) => new Vector3(p.x, p.y, p.z);

beforeAll(initPhysics);

describe('createWorld', () => {
  it('pulls down with the given gravity at 60 steps a second', () => {
    const w = createWorld(20);
    expect(w.gravity).toEqual({ x: 0, y: -20, z: 0 });
    expect(w.timestep).toBeCloseTo(1 / 60);
  });
});

describe('Ragdoll', () => {
  test.each(KINDS)('%s ragdoll settles without exploding', (k) => {
    const w = createWorld(20); floor(w);
    const L = layoutOf(k);
    const r = new Ragdoll(w, L, { bounce: 0.35 });
    for (let i = 0; i < 300; i++) w.step();
    for (const p of r.pieces) {
      const t = p.body.translation();
      expect(Number.isFinite(t.y)).toBe(true);
      expect(Math.abs(t.x) + Math.abs(t.z)).toBeLessThan(5);
      expect(t.y).toBeGreaterThan(-0.05); // nothing sank through the floor
      expect(t.y).toBeLessThan(L.ringHeight); // nothing flew up
      // limbs may still swing or the body roll (spike damping), but nothing is flung
      expect(v(p.body.linvel()).length()).toBeLessThan(5);
    }
    expect(r.pos().y).toBeLessThan(L.standHeight); // no muscles yet: it flops down
  });

  test('huge recipe settles', () => {
    const L = ragdollLayout(buildSkeleton(monster48Parts()), loadFixture('fists').fight!);
    const w = createWorld(20); floor(w);
    const r = new Ragdoll(w, L, { bounce: 0.35 });
    expect(r.pieces.length).toBeLessThanOrEqual(MAX_SEGMENTS);
    expect(r.pieces).toHaveLength(L.segments.length);
    for (let i = 0; i < 300; i++) w.step();
    for (const p of r.pieces) {
      const t = p.body.translation();
      expect(Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.z)).toBe(true);
      expect(t.y).toBeGreaterThan(-0.05);
      expect(Math.abs(t.x) + Math.abs(t.z)).toBeLessThan(5);
    }
  });

  it('one piece per segment, built standing on the floor from the layout', () => {
    const L = layoutOf('fists');
    const w = createWorld(20);
    const r = new Ragdoll(w, L, { bounce: 0.35 });
    expect(r.pieces.map((p) => p.seg)).toEqual(L.segments);
    expect(r.torso).toBe(r.pieces[0]);
    expect(r.head?.seg.kind).toBe('head');
    expect(r.pos().y).toBeCloseTo(L.standHeight);
    expect(w.impulseJoints.len()).toBe(L.segments.length - 1);
    for (const p of r.pieces) {
      const mid = v(p.seg.a).add(v(p.seg.b)).multiplyScalar(0.5);
      expect(v(p.body.translation()).distanceTo(mid)).toBeLessThan(1e-5);
      expect(p.restP.distanceTo(mid)).toBeLessThan(1e-9);
      expect(p.body.isCcdEnabled()).toBe(true);
      const c = p.body.collider(0);
      expect(c.friction()).toBeCloseTo(0.7);
      expect(c.restitution()).toBeCloseTo(0.35);
    }
    expect(r.torso.body.angularDamping()).toBeCloseTo(1.5);
    expect(r.head!.body.angularDamping()).toBeCloseTo(2);
    const arm = r.pieces.find((p) => p.seg.kind === 'arm')!;
    expect(arm.body.angularDamping()).toBeCloseTo(0.8);
    expect(arm.body.linearDamping()).toBeCloseTo(0.15);
  });

  it('capsules run from a to b', () => {
    const r = new Ragdoll(createWorld(20), layoutOf('legs'), { bounce: 0.35 });
    for (const p of r.pieces) {
      const len = v(p.seg.a).distanceTo(v(p.seg.b));
      const axis = new Vector3(0, len / 2, 0).applyQuaternion(p.restQ);
      expect(p.restP.clone().add(axis).distanceTo(v(p.seg.b))).toBeLessThan(1e-6);
      expect(p.restP.clone().sub(axis).distanceTo(v(p.seg.a))).toBeLessThan(1e-6);
    }
  });

  it('mass is the sum of the pieces, and a blob belly is denser', () => {
    for (const k of KINDS) {
      const L = layoutOf(k);
      const r = new Ragdoll(createWorld(20), L, { bounce: 0.35 });
      const sum = r.pieces.reduce((t, p) => t + p.mass, 0);
      expect(r.mass).toBeCloseTo(sum);
      for (const p of r.pieces) {
        expect(p.mass).toBeGreaterThan(0);
        expect(p.mass).toBeCloseTo(p.body.mass());
      }
      const blobby = L.segments[0].radius >= 0.35 * L.ringHeight;
      expect(blobby).toBe(k === 'blob');
      expect(r.torso.body.collider(0).density()).toBeCloseTo(blobby ? 1.2 : 1);
      expect(r.pieces[1].body.collider(0).density()).toBeCloseTo(1);
    }
  });

  test('pose moves every piece by the same rigid transform', () => {
    const w = createWorld(20);
    const r = new Ragdoll(w, layoutOf('tail'), { bounce: 0.35 });
    for (let i = 0; i < 20; i++) w.step(); // falling: every piece moving
    r.pose(new Vector3(3, 0, 0), Math.PI / 2);
    const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const t0 = v(r.torso.body.translation());
    // the creature's origin goes to `root` and turns about +y (the spike's Creature.pose)
    expect(t0.distanceTo(r.torso.restP.clone().applyQuaternion(turn).add(new Vector3(3, 0, 0)))).toBeLessThan(1e-5);
    for (const p of r.pieces) {
      const off = v(p.body.translation()).sub(t0);
      const want = p.restP.clone().sub(r.torso.restP).applyQuaternion(turn);
      expect(off.distanceTo(want)).toBeLessThan(1e-5);
      const q = p.body.rotation();
      const wantQ = turn.clone().multiply(p.restQ);
      expect(Math.abs(new Quaternion(q.x, q.y, q.z, q.w).dot(wantQ))).toBeCloseTo(1, 5);
      expect(v(p.body.linvel()).length()).toBe(0);
      expect(v(p.body.angvel()).length()).toBe(0);
    }
    // bob lifts, spin turns further
    r.pose(new Vector3(0, 0, 0), 0, 0.5, Math.PI);
    const half = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
    for (const p of r.pieces) {
      const want = p.restP.clone().applyQuaternion(half).add(new Vector3(0, 0.5, 0));
      expect(v(p.body.translation()).distanceTo(want)).toBeLessThan(1e-5);
    }
    expect(r.vel().length()).toBe(0);
    expect(r.pos().distanceTo(v(r.torso.body.translation()))).toBe(0);
  });

  test('pose can leave some pieces free (a limb playing a move while the body is held)', () => {
    const w = createWorld(20);
    const r = new Ragdoll(w, layoutOf('fists'), { bounce: 0.35 });
    for (let i = 0; i < 20; i++) w.step();
    const hand = r.pieces.find((p) => p.seg.kind === 'hand')!;
    const was = v(hand.body.translation()), wasVel = v(hand.body.linvel());
    r.pose(new Vector3(3, 0, 0), 0, 0, 0, new Set([hand]));
    expect(v(hand.body.translation()).distanceTo(was)).toBe(0);
    expect(v(hand.body.linvel()).distanceTo(wasVel)).toBe(0);
    expect(v(r.torso.body.translation()).distanceTo(r.torso.restP.clone().add(new Vector3(3, 0, 0)))).toBeLessThan(1e-5);
    r.pose(new Vector3(3, 0, 0), 0, 0, 0, null); // and none free
    expect(v(hand.body.translation()).distanceTo(hand.restP.clone().add(new Vector3(3, 0, 0)))).toBeLessThan(1e-5);
  });

  it('setBounce changes every collider', () => {
    const r = new Ragdoll(createWorld(20), layoutOf('wings'), { bounce: 0.35 });
    r.setBounce(0.9);
    for (const p of r.pieces) for (let i = 0; i < p.body.numColliders(); i++) expect(p.body.collider(i).restitution()).toBeCloseTo(0.9);
  });

  it("a creature's own pieces never touch each other, but do touch the floor and other creatures", () => {
    const w = createWorld(20);
    const a = new Ragdoll(w, layoutOf('fists'), { bounce: 0.35 });
    const b = new Ragdoll(w, layoutOf('blob'), { bounce: 0.35 });
    const fl = floor(w);
    const touch = (x: number, y: number) => ((x >>> 16) & y & 0xffff) !== 0 && ((y >>> 16) & x & 0xffff) !== 0;
    const ga = a.torso.body.collider(0).collisionGroups(), gb = b.torso.body.collider(0).collisionGroups();
    for (const p of a.pieces) expect(p.body.collider(0).collisionGroups()).toBe(ga);
    expect(touch(ga, ga)).toBe(false);
    expect(touch(ga, gb)).toBe(true);
    expect(touch(ga, fl.collisionGroups())).toBe(true);
  });

  test('dispose removes every body', () => {
    const w = createWorld(20); floor(w);
    const before = w.bodies.len();
    const r = new Ragdoll(w, layoutOf('horns'), { bounce: 0.35 });
    expect(w.bodies.len()).toBe(before + r.pieces.length);
    for (let i = 0; i < 10; i++) w.step();
    r.dispose();
    expect(w.bodies.len()).toBe(before);
    expect(w.impulseJoints.len()).toBe(0);
    w.step();
  });
});
