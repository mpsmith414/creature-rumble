import { describe, expect, it } from 'vitest';
import { packUniforms, reliefKind } from '../../src/skin/material';
import { packRegions } from '../../src/skin/patterns';
import { quadruped } from '../fixtures/recipes';

describe('reliefKind', () => {
  it('gives scales and shells cells, feathers ripples, the rest a fine grain', () => {
    expect(reliefKind('scales')).toBe('cells');
    expect(reliefKind('shell')).toBe('cells');
    expect(reliefKind('feathers')).toBe('ripple');
    expect(reliefKind('fur')).toBe('grain');
    expect(reliefKind('skin')).toBe('grain');
    expect(reliefKind('slime')).toBe('grain');
  });
});

describe('packUniforms', () => {
  it('carries the belly flag in colA.w', () => {
    const w = (u: ReturnType<typeof packUniforms>, i: number) => (u.colA.array[i] as { w: number }).w;
    const u = packUniforms(packRegions(quadruped, ['body', 'tail']));
    expect(w(u, 0)).toBe(1); // the furred body has a belly
    expect(w(u, 1)).toBe(0); // the scaly tail has none
  });
});
