import { describe, expect, it } from 'vitest';
import { importance } from '../../src/builder/importance';
import { buildSkeleton } from '../../src/builder/skeleton';
import { fox } from '../fixtures/cast/fox';
import { add, norm, scale, sub, v3, type Vec3 } from '../../src/util/vec';

describe('importance', () => {
  const sk = buildSkeleton(fox);
  const bone = (name: string) => sk.bones.find((b) => b.name === name)!;
  const at = (p: Vec3) => importance(sk, new Float32Array([p.x, p.y, p.z]))[0];

  it('weighs the nose tip most', () => {
    const s = bone('snout');
    expect(at(add(s.end, scale(norm(sub(s.end, s.start)), s.r1)))).toBe(8);
  });

  it('weighs the hips least', () => {
    const h = bone('hips');
    expect(at(v3((h.start.x + h.end.x) / 2, (h.start.y + h.end.y) / 2 + 0.085, (h.start.z + h.end.z) / 2))).toBe(1);
  });

  it('weighs a knee as a joint', () => {
    const t = bone('thigh');
    expect(at(add(t.end, v3(t.r1, 0, 0)))).toBeGreaterThanOrEqual(2.5);
  });

  it('raises marked vertices by 6 × their strongest mark', () => {
    const h = bone('hips'), p = new Float32Array([h.start.x, h.start.y + 0.085, h.start.z, h.start.x, h.start.y + 0.085, h.start.z]);
    const plain = importance(sk, p);
    const marked = importance(sk, p, new Float32Array([0, 0, 0, 0, 0.2, 0.5, 0, 0.1]));
    expect(marked[0]).toBe(plain[0]);
    expect(marked[1]).toBeCloseTo(plain[1] + 3, 6);
  });
});
