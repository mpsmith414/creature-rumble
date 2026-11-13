import { describe, expect, test } from 'vitest';
import { SPECIAL_FOR, SPECIAL_TITLE, type SpecialName } from '../../src/fight/special';
import {
  AIR_ABOVE, AIR_OUT, AIR_UP, airborne, GLOW_FAINT, GLOW_HIGH, GLOW_HZ, GLOW_LOW, glowLevel, outward, shakeFor, SPECIAL_POP, specialSaid,
} from '../../src/show/special-fx';
import { SHAKE_MAX } from '../../src/show/camera';

const NAMES = Object.keys(SPECIAL_TITLE) as SpecialName[];

describe('glowLevel', () => {
  test('a special under way pulses softly between GLOW_LOW and GLOW_HIGH, never off', () => {
    let lo = Infinity, hi = -Infinity;
    for (let t = 0; t < 3; t += 0.01) {
      const g = glowLevel(0, true, t);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
    expect(lo).toBeGreaterThanOrEqual(GLOW_LOW - 1e-9);
    expect(hi).toBeLessThanOrEqual(GLOW_HIGH + 1e-9);
    expect(hi - lo).toBeGreaterThan(0.2); // it does pulse
    expect(GLOW_HZ).toBeLessThan(3); // gentle: well under a flashing screen's limit
  });

  test('a filling meter glows faintly, more as it fills, none when empty', () => {
    expect(glowLevel(0, false, 1)).toBe(0);
    expect(glowLevel(0.3, false, 1)).toBe(0);
    const at = (m: number) => Math.max(...Array.from({ length: 100 }, (_, i) => glowLevel(m, false, i * 0.013)));
    expect(at(0.7)).toBeGreaterThan(0);
    expect(at(1)).toBeGreaterThan(at(0.7));
    expect(at(1)).toBeLessThanOrEqual(GLOW_FAINT + 1e-9);
    expect(at(1)).toBeLessThan(GLOW_LOW); // faint is well under the special's own glow
  });

  test('a bad meter never makes a bad glow', () => {
    expect(glowLevel(Number.NaN, false, 0)).toBe(0);
    expect(glowLevel(5, false, 0)).toBeLessThanOrEqual(GLOW_FAINT);
  });
});

describe('the special words', () => {
  test('every special has its own big pop word', () => {
    for (const s of NAMES) expect(SPECIAL_POP[s]).toMatch(/!$/);
    expect(new Set(Object.values(SPECIAL_POP)).size).toBe(NAMES.length);
    expect(Object.values(SPECIAL_POP)).toContain('KA-BLAMMO!');
  });

  test('the announcer says the title without its shout mark', () => {
    expect(specialSaid('megaPunch')).toBe('MEGA PUNCH');
    for (const s of NAMES) expect(specialSaid(s)).not.toMatch(/!/);
    for (const m of Object.keys(SPECIAL_FOR)) expect(specialSaid(SPECIAL_FOR[m as keyof typeof SPECIAL_FOR])).toBeTruthy();
  });

  test('a bigger impact shakes a little more, and never past the camera cap at any reach the fight sends', () => {
    expect(shakeFor(3)).toBeGreaterThan(shakeFor(1));
    for (const r of [0, 1, 2.5, 6, 100, Number.NaN]) expect(shakeFor(r)).toBeLessThanOrEqual(SHAKE_MAX + 1e-9);
  });
});

describe('airborne', () => {
  test('standing, walking or a small hop is not flying', () => {
    expect(airborne(1, 1, 0, 0)).toBe(false);
    expect(airborne(1 + AIR_ABOVE * 0.5, 1, 2, 3)).toBe(false);
  });
  test('well up, going up fast, or flying outward fast is', () => {
    expect(airborne(1 + AIR_ABOVE + 0.1, 1, 0, 0)).toBe(true);
    expect(airborne(1, 1, AIR_UP + 0.1, 0)).toBe(true);
    expect(airborne(1, 1, 0, AIR_OUT + 0.1)).toBe(true);
  });
  test('dropping into the ball pit is not', () => {
    expect(airborne(-3, 1, -5, 10)).toBe(false);
  });
  test('outward speed is the part of the motion away from the ring’s middle', () => {
    expect(outward(3, 0, 2, 5)).toBeCloseTo(2);
    expect(outward(0, -2, 0, 4)).toBeCloseTo(-4);
    expect(outward(0, 0, 3, 4)).toBeCloseTo(5);
  });
});
