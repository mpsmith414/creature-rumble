import { describe, expect, it } from 'vitest';
import { ringScale } from '../../src/fight/scale';

describe('ringScale', () => {
  it('brings every creature to a ring height between 0.7 m and 2.4 m', () => {
    expect(0.02 * ringScale(0.02)).toBeCloseTo(0.7, 6);
    expect(1 * ringScale(1)).toBeCloseTo(1.4, 6);
    expect(8 * ringScale(8)).toBeCloseTo(2.4, 6);
  });
  it('keeps taller creatures taller in the ring (until the cap)', () => {
    const ring = (h: number) => h * ringScale(h);
    expect(ring(0.5)).toBeLessThan(ring(1));
    expect(ring(1)).toBeLessThan(ring(2));
  });
});
