import { describe, expect, it } from 'vitest';
import { buildSkeleton } from '../../src/builder/skeleton';
import { bodyHeight } from '../../src/fight/moves';
import { ringScale } from '../../src/fight/scale';
import { MAX_SEGMENTS, ragdollLayout, ringScale as reExported } from '../../src/physics/layout';
import { KINDS, loadFixture } from '../fixtures/fighters';
import { monster48Parts } from '../fixtures/monster';

const fx = loadFixture;
const layoutOf = (k: string) => ragdollLayout(buildSkeleton(fx(k)), fx(k).fight!);

describe('ringScale', () => {
  it('clamps', () => {
    expect(reExported).toBe(ringScale);
    expect(0.02 * ringScale(0.02)).toBeCloseTo(0.7);
    expect(8 * ringScale(8)).toBeCloseTo(2.4);
    expect(1 * ringScale(1)).toBeCloseTo(1.4);
  });
});

describe('ragdollLayout', () => {
  it('fists fixture: torso root, head, two arms, two hands as weapons', () => {
    const L = layoutOf('fists');
    expect(L.segments[0].kind).toBe('torso');
    expect(L.segments[0].parent).toBe(-1);
    expect(L.segments.filter((s) => s.kind === 'hand' && s.weapon)).toHaveLength(2);
    expect(L.segments.filter((s) => s.kind === 'arm')).toHaveLength(2);
    expect(L.segments.some((s) => s.kind === 'head')).toBe(true);
    expect(L.segments.filter((s) => s.weapon)).toHaveLength(2);
  });

  it('eyes and horns merge into the head', () => {
    const sk = buildSkeleton(fx('horns'));
    const L = ragdollLayout(sk, fx('horns').fight!);
    expect(L.segments.some((s) => s.kind === 'other')).toBe(false);
    const head = L.segments.find((s) => s.kind === 'head')!;
    sk.bones.forEach((b, i) => {
      if (b.role === 'horn' || b.role === 'eye') expect(L.boneSegment[i]).toBe(head.id);
    });
    expect(head.weapon).toBe(true); // the horn is the headbutt weapon
  });

  it('keeps the left and right limbs as separate segments', () => {
    const L = layoutOf('fists');
    const arms = L.segments.filter((s) => s.kind === 'arm');
    expect(arms[0].a.x * arms[1].a.x).toBeLessThan(0);
  });

  it('scales to the ring and stands on the floor', () => {
    for (const k of KINDS) {
      const sk = buildSkeleton(fx(k));
      const L = ragdollLayout(sk, fx(k).fight!);
      const h = bodyHeight(sk);
      expect(L.scale).toBeCloseTo(ringScale(h));
      expect(L.ringHeight).toBeCloseTo(h * L.scale);
      expect(L.standHeight).toBeGreaterThan(0);
      expect(L.standHeight).toBeLessThan(L.ringHeight);
      const root = L.segments[0];
      expect(L.standHeight).toBeCloseTo((root.a.y + root.b.y) / 2);
      expect(root.anchor).toEqual(root.a);
      for (const s of L.segments) expect(s.radius).toBeGreaterThan(0);
    }
  });

  it('keeps a 3-bone tail as three segments', () => {
    expect(layoutOf('tail').segments.filter((s) => s.kind === 'tail')).toHaveLength(3);
  });

  it('layout caps segments', () => {
    const r = monster48Parts();
    expect(r.parts.length).toBeGreaterThanOrEqual(48);
    const sk = buildSkeleton(r);
    expect(sk.bones.length).toBeGreaterThanOrEqual(90);
    const L = ragdollLayout(sk, fx('fists').fight!);
    expect(L.segments.length).toBeLessThanOrEqual(MAX_SEGMENTS);
    expect(L.segments.length).toBeGreaterThan(10);
    expect(L.segments.filter((s) => s.kind === 'tail').length).toBeLessThanOrEqual(3);
  });

  it('every bone maps to a segment', () => {
    for (const k of [...KINDS, 'monster']) {
      const r = k === 'monster' ? monster48Parts() : fx(k);
      const sk = buildSkeleton(r);
      const L = ragdollLayout(sk, fx('fists').fight!);
      expect(L.boneSegment).toHaveLength(sk.bones.length);
      for (const id of L.boneSegment) expect(L.segments[id]).toBeDefined();
      L.segments.forEach((s, i) => {
        expect(s.id).toBe(i);
        expect(s.parent).toBeLessThan(i);
        for (const b of s.bones) expect(L.boneSegment[b]).toBe(i);
      });
    }
  });
});

describe('small bodies keep their ends', () => {
  it('a small head and small hands still get segments', () => {
    const L = layoutOf('legs'); // head 0.096 m and hands 0.025 m on a 1.5 m body
    expect(L.segments.some((s) => s.kind === 'head')).toBe(true);
    expect(L.segments.filter((s) => s.kind === 'hand')).toHaveLength(2);
  });
});

const segDist = (p: { x: number; y: number; z: number }, a: typeof p, b: typeof p) => {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, ap = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z };
  const l2 = ab.x ** 2 + ab.y ** 2 + ab.z ** 2;
  const t = l2 < 1e-12 ? 0 : Math.min(1, Math.max(0, (ap.x * ab.x + ap.y * ab.y + ap.z * ab.z) / l2));
  return Math.hypot(p.x - a.x - t * ab.x, p.y - a.y - t * ab.y, p.z - a.z - t * ab.z);
};

describe('layout geometry', () => {
  const near = (u: { x: number; y: number; z: number }, v: typeof u) => expect(Math.hypot(u.x - v.x, u.y - v.y, u.z - v.z)).toBeLessThan(1e-9);
  const sc = (v: { x: number; y: number; z: number }, k: number) => ({ x: v.x * k, y: v.y * k, z: v.z * k });

  it('folding leaves into the root keeps the root capsule on its own bone', () => {
    const sk = buildSkeleton(monster48Parts());
    const L = ragdollLayout(sk, fx('fists').fight!);
    near(L.segments[0].a, sc(sk.bones[0].start, L.scale));
    near(L.segments[0].b, sc(sk.bones[0].end, L.scale));
    expect(L.standHeight).toBeCloseTo(((sk.bones[0].start.y + sk.bones[0].end.y) / 2) * L.scale, 9);
    expect(L.segments[0].radius).toBeCloseTo(Math.max(sk.bones[0].r0, sk.bones[0].r1) * L.scale, 9);
  });

  it('every anchor sits on its parent capsule', () => {
    for (const k of [...KINDS, 'monster']) {
      const sk = buildSkeleton(k === 'monster' ? monster48Parts() : fx(k));
      const L = ragdollLayout(sk, fx('fists').fight!);
      for (const s of L.segments.slice(1)) {
        const p = L.segments[s.parent];
        expect(segDist(s.anchor, p.a, p.b), `${k} segment ${s.id}`).toBeLessThanOrEqual(p.radius + s.radius + 1e-9);
      }
    }
  });

  it('a grouped tail spans its bones and a merged horn does not move the head', () => {
    const r = monster48Parts();
    r.parts = r.parts.filter((p) => !p.id.match(/^(arm|fore|claw)/));
    const sk = buildSkeleton(r);
    const L = ragdollLayout(sk, fx('fists').fight!);
    const tails = L.segments.filter((s) => s.kind === 'tail');
    const idx = sk.bones.flatMap((b, i) => (b.role === 'tail' ? [i] : []));
    near(tails[0].a, sc(sk.bones[idx[0]].start, L.scale));
    near(tails[tails.length - 1].b, sc(sk.bones[idx[idx.length - 1]].end, L.scale));
    const head = L.segments.find((s) => s.kind === 'head')!;
    const hb = sk.bones.findIndex((b) => b.role === 'head');
    near(head.a, sc(sk.bones[hb].start, L.scale));
    near(head.b, sc(sk.bones[hb].end, L.scale));
  });
});
