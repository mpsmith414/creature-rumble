import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, it, test, vi } from 'vitest';
import { buildBody } from '../../src/builder/build';
import { buildSkeleton } from '../../src/builder/skeleton';
import { planFor } from '../../src/fight/moves';
import { ragdollLayout } from '../../src/physics/layout';
import { Ragdoll } from '../../src/physics/ragdoll';
import { createWorld, initPhysics } from '../../src/physics/world';
import { boneWorld, driveBones, GooglyEye, PUPIL_MAX, pieceRestMatrices, restBoneMatrices } from '../../src/render/drive';
import { createFighterObject, OUTLINE_COLOR, OUTLINE_PUSH, seatEye } from '../../src/render/fighter-object';
import { eyePlaces } from '../../src/skin/eyes';
import { loadFixture } from '../fixtures/fighters';

const fists = loadFixture('fists');
const fistsSk = buildSkeleton(fists);
const fistsLayout = ragdollLayout(fistsSk, planFor(fists, fistsSk));

const close = (a: Matrix4, b: Matrix4, eps = 1e-6) => a.elements.forEach((x, k) => expect(x).toBeCloseTo(b.elements[k], -Math.log10(eps)));
const xAxis = (m: Matrix4) => new Vector3().setFromMatrixColumn(m, 0).normalize();
const origin = (m: Matrix4) => new Vector3().setFromMatrixPosition(m);

describe('boneWorld', () => {
  test('bones at rest stay at rest', () => {
    const rest = restBoneMatrices(fistsSk.bones.map((b) => b.start), fistsLayout.scale);
    const pieces = pieceRestMatrices(fistsLayout);
    const world = boneWorld(fistsLayout, rest, pieces, pieces.map((m) => m.clone()));
    expect(world).toHaveLength(rest.length);
    world.forEach((m, i) => close(m, rest[i]));
  });

  test('a rotated hand turns its bones with it', () => {
    const L = fistsLayout;
    const rest = restBoneMatrices(fistsSk.bones.map((b) => b.start), L.scale);
    const pieces = pieceRestMatrices(L);
    const hand = L.segments.find((s) => s.kind === 'hand')!;
    const handBone = fistsSk.bones.findIndex((b, i) => b.role === 'hand' && L.boneSegment[i] === hand.id);
    const armBone = fistsSk.bones.findIndex((b, i) => b.role === 'arm' && L.boneSegment[i] === hand.parent);
    expect(handBone).toBeGreaterThanOrEqual(0);
    expect(armBone).toBeGreaterThanOrEqual(0);

    // the hand piece turned 90° about z, about its anchor (the wrist)
    const a = new Vector3(hand.anchor.x, hand.anchor.y, hand.anchor.z);
    const turn = new Matrix4().makeTranslation(a.x, a.y, a.z)
      .multiply(new Matrix4().makeRotationZ(Math.PI / 2))
      .multiply(new Matrix4().makeTranslation(-a.x, -a.y, -a.z));
    const now = pieces.map((m) => m.clone());
    now[hand.id].premultiply(turn);
    const world = boneWorld(L, rest, pieces, now);

    const x = xAxis(world[handBone]);
    expect(x.x).toBeCloseTo(0, 6);
    expect(x.y).toBeCloseTo(1, 6); // its x axis now points up
    // its start swung round the wrist with it
    const want = origin(rest[handBone]).sub(a).applyAxisAngle(new Vector3(0, 0, 1), Math.PI / 2).add(a);
    expect(origin(world[handBone]).distanceTo(want)).toBeLessThan(1e-6);
    close(world[armBone], rest[armBone]); // the arm stays put
  });

  it('writes into `out` when given one (no new matrices each frame)', () => {
    const rest = restBoneMatrices(fistsSk.bones.map((b) => b.start), fistsLayout.scale);
    const pieces = pieceRestMatrices(fistsLayout);
    const out = rest.map(() => new Matrix4());
    expect(boneWorld(fistsLayout, rest, pieces, pieces, out)).toBe(out);
    out.forEach((m, i) => close(m, rest[i]));
  });
});

describe('GooglyEye', () => {
  test('pupils lag and settle', () => {
    const eye = new GooglyEye(1);
    const still = new Vector3();
    eye.update(1 / 60, new Vector3(5, 0, 0), still);
    expect(eye.offset.length()).toBeGreaterThan(0);
    expect(eye.offset.length()).toBeLessThanOrEqual(PUPIL_MAX + 1e-9);
    expect(eye.offset.x).toBeLessThan(0); // it lags behind the motion
    for (let i = 0; i < 120; i++) eye.update(1 / 60, still, still);
    expect(eye.offset.length()).toBeLessThan(0.01);
  });

  it('never leaves the eye however hard it is shaken, and moves its pupil in eye units', () => {
    const r = 0.05;
    const pupil = { position: new Vector3(0, 0, 0.62) };
    const eye = new GooglyEye(r, pupil);
    for (let i = 0; i < 90; i++) {
      eye.update(1 / 60, new Vector3(Math.sin(i) * 40, Math.cos(i * 1.3) * 40, 0), new Vector3(0, 30, 0));
      expect(eye.offset.length()).toBeLessThanOrEqual(PUPIL_MAX * r + 1e-9);
      expect(pupil.position.x).toBeCloseTo(eye.offset.x / r, 9);
      expect(pupil.position.y).toBeCloseTo(eye.offset.y / r, 9);
      expect(pupil.position.z).toBe(0.62);
    }
  });

  it('a long frame is stepped in pieces, so it stays calm', () => {
    const a = new GooglyEye(1), b = new GooglyEye(1);
    const jolt = new Vector3(3, -2, 0), still = new Vector3();
    a.update(0.1, jolt, still);
    for (let i = 0; i < 6; i++) b.update(1 / 60, jolt, still);
    expect(a.offset.distanceTo(b.offset)).toBeLessThan(1e-9);
  });
});

describe('createFighterObject', () => {
  beforeAll(initPhysics);
  const body = buildBody(fists, [2]);
  const layout = ragdollLayout(body.skeleton, planFor(fists, body.skeleton));

  it('is the body scaled to the ring, with a dark back-face outline on the same skeleton', () => {
    const f = createFighterObject(body, fists, layout);
    expect(f.root.scale.x).toBeCloseTo(layout.scale, 9);
    expect(f.bones).toHaveLength(body.skeleton.bones.length);
    expect(f.outline.isSkinnedMesh).toBe(true);
    expect(f.outline.skeleton).toBe(f.mesh.skeleton);
    const m = f.outline.material as unknown as { side: number; color: { getHexString(): string } };
    expect(m.side).toBe(1); // BackSide
    expect('#' + m.color.getHexString()).toBe(OUTLINE_COLOR);
    // pushed out along the normals by 0.012 × ring height (in ring metres; the geometry is in creature metres)
    const push = (OUTLINE_PUSH * layout.ringHeight) / layout.scale;
    const p = body.lods[0].positions, n = body.lods[0].normals, q = f.outline.geometry.attributes.position.array;
    for (let k = 0; k < p.length; k += 97) expect(q[k]).toBeCloseTo(p[k] + n[k] * push, 6);
    expect(f.outline.geometry.index!.array).toBe(body.lods[0].indices);
    expect(f.outline.castShadow).toBe(false);
    f.dispose();
  });

  it('frees its skeleton (the bone texture) once when disposed: the outline shares it', () => {
    const f = createFighterObject(body, fists, layout);
    expect(f.outline.skeleton).toBe(f.mesh.skeleton);
    const spy = vi.spyOn(f.mesh.skeleton, 'dispose');
    f.dispose();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('has googly eyes where the eye placement puts them, each with a black pupil', () => {
    const f = createFighterObject(body, fists, layout);
    const places = eyePlaces(body, fists.skin.eyes.size).map((p) => seatEye(body.lods[0], p)); // seated on the body
    expect(places.length).toBeGreaterThan(0);
    expect(f.eyes).toHaveLength(places.length);
    f.root.updateMatrixWorld(true);
    places.forEach((pl, i) => {
      const e = f.eyes[i];
      expect(e.pupil).toBeTruthy();
      const at = new Vector3().setFromMatrixPosition(e.ball!.matrixWorld);
      const want = new Vector3(pl.centre.x, pl.centre.y, pl.centre.z).multiplyScalar(layout.scale);
      expect(at.distanceTo(want)).toBeLessThan(1e-6);
      expect(e.radius).toBeCloseTo(pl.r * layout.scale, 9);
    });
    f.dispose();
  });

  it('skins the body where its ragdoll stands: posed and turned, every vertex goes with it', () => {
    const world = createWorld(20);
    const rag = new Ragdoll(world, layout, { bounce: 0.35 });
    const f = createFighterObject(body, fists, layout);
    const at = new Vector3(3, 0, -1), yaw = Math.PI / 2;
    rag.pose(at, yaw);
    driveBones(f, rag);
    f.root.updateMatrixWorld(true);
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
    const pos = f.mesh.geometry.attributes.position;
    const v = new Vector3();
    for (let i = 0; i < pos.count; i += 53) {
      f.mesh.getVertexPosition(i, v).applyMatrix4(f.mesh.matrixWorld);
      const want = new Vector3().fromBufferAttribute(pos, i).multiplyScalar(layout.scale).applyQuaternion(q).add(at);
      expect(v.distanceTo(want)).toBeLessThan(1e-4);
    }
    // the eyes ride along
    f.root.updateMatrixWorld(true);
    const place = seatEye(body.lods[0], eyePlaces(body, fists.skin.eyes.size)[0]);
    const eyeAt = new Vector3().setFromMatrixPosition(f.eyes[0].ball!.matrixWorld);
    const want = new Vector3(place.centre.x, place.centre.y, place.centre.z).multiplyScalar(layout.scale).applyQuaternion(q).add(at);
    expect(eyeAt.distanceTo(want)).toBeLessThan(1e-4);
    f.dispose();
    rag.dispose();
    world.free();
  });

  it('wobbles the pupils when the piece they sit on moves', () => {
    const world = createWorld(20);
    const rag = new Ragdoll(world, layout, { bounce: 0.35 });
    const f = createFighterObject(body, fists, layout);
    rag.pieces[f.boneSegment[f.eyes[0].bone]].body.setLinvel({ x: 0, y: 6, z: 0 }, true); // the piece the eye rides on
    driveBones(f, rag, 1 / 60);
    expect(f.eyes[0].offset.length()).toBeGreaterThan(0);
    f.dispose();
    rag.dispose();
    world.free();
  });

  it('carries a jaw the layout never saw on its head piece (a layout made from the plain skeleton)', () => {
    const wings = loadFixture('wings');
    const wb = buildBody(wings, [2]);
    expect(wb.skeleton.jaw).toBeGreaterThanOrEqual(0);
    const sk = buildSkeleton(wings);
    const L = ragdollLayout(sk, planFor(wings, sk)); // one bone short: no jaw
    expect(L.boneSegment.length).toBe(wb.skeleton.bones.length - 1);
    const world = createWorld(20);
    const rag = new Ragdoll(world, L, { bounce: 0.35 });
    const f = createFighterObject(wb, wings, L);
    const jaw = wb.skeleton.jaw, head = wb.skeleton.bones[jaw].parent;
    expect(f.boneSegment[jaw]).toBe(f.boneSegment[head]);
    // the head piece turns: the jaw turns with it, staying where it sat against the head
    const hp = rag.pieces[f.boneSegment[head]];
    const turn = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.8);
    const r = new Quaternion().multiplyQuaternions(turn, hp.restQ);
    hp.body.setRotation({ x: r.x, y: r.y, z: r.z, w: r.w }, true);
    driveBones(f, rag);
    const rel = (m: Matrix4[]) => m[head].clone().invert().multiply(m[jaw]);
    close(rel(f.bones.map((b) => b.matrixWorld)), rel(f.restBones), 1e-5);
    f.dispose();
    rag.dispose();
    world.free();
  }, 20_000);
});
