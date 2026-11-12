import { Color } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { packRegions, patternMaskCPU } from '../../src/skin/patterns';
import { quadruped } from '../fixtures/recipes';

describe('packRegions', () => {
  it('pads to 8 and maps coverings and patterns to indices', () => {
    const p = packRegions(quadruped, ['body', 'tail']);
    expect(p.base).toHaveLength(8);
    expect(p.covering[0]).toBe(0); // fur
    expect(p.covering[1]).toBe(1); // scales
    expect(p.patKind[0]).toBe(-1); // none
    expect(p.patKind[1]).toBe(1); // spots
    expect(p.hasBelly[0]).toBe(1);
    expect(p.furLength[1]).toBe(0); // scales have no fur
  });
});

describe('packRegions face colours', () => {
  const headRegion = quadruped.parts.find((p) => p.role === 'head')!.region;
  const headColor = new Color(quadruped.skin.regions.find((r) => r.id === headRegion)!.color);

  it('a darkened head colour for the nose, unless the face gives one', () => {
    const nose = new Color(packRegions(quadruped, ['body', 'tail']).nose);
    expect(nose.r).toBeCloseTo(headColor.r * 0.35, 2);
    expect(nose.g).toBeCloseTo(headColor.g * 0.35, 2);
    expect(nose.b).toBeCloseTo(headColor.b * 0.35, 2);
    expect(packRegions({ ...quadruped, face: { ...quadruped.face, noseColor: '#112233' } }, ['body']).nose).toBe('#112233');
  });

  it('a warm, lighter ear colour inside the ears, unless the face gives one', () => {
    const inner = new Color(packRegions(quadruped, ['body']).earInner), pink = new Color('#f0c8b8');
    const ear = new Color(quadruped.skin.regions.find((r) => r.id === (quadruped.parts.find((p) => p.role === 'ear')?.region ?? headRegion))!.color);
    expect(inner.r).toBeCloseTo((ear.r + pink.r) / 2, 2);
    expect(inner.b).toBeCloseTo((ear.b + pink.b) / 2, 2);
    expect(packRegions({ ...quadruped, face: { ...quadruped.face, earInner: '#ffeedd' } }, ['body']).earInner).toBe('#ffeedd');
  });
});

describe('patternMaskCPU', () => {
  const at = (z: number, y = 0) => ({ x: 0, y, z });

  it('alternates stripes across one repeat', () => {
    const s = 0.2;
    const a = patternMaskCPU('stripes', at(s * 0.75), 0, 0, s, 0.5);
    const b = patternMaskCPU('stripes', at(s * 0.25), 0, 0, s, 0.5);
    expect(a).not.toBe(b);
    expect(patternMaskCPU('stripes', at(s * 1.75), 0, 0, s, 0.5)).toBe(a);
  });

  it('flips rings every repeat along the part', () => {
    expect(patternMaskCPU('rings', at(0), 0, 0.01, 0.1, 0.5)).toBe(1);
    expect(patternMaskCPU('rings', at(0), 0, 0.06, 0.1, 0.5)).toBe(0);
    expect(patternMaskCPU('rings', at(0), 0, 0.11, 0.1, 0.5)).toBe(1);
  });

  it('grows a gradient along the part', () => {
    expect(patternMaskCPU('gradient', at(0), 0.2, 0, 1, 1)).toBeLessThan(patternMaskCPU('gradient', at(0), 0.8, 0, 1, 1));
  });
});
