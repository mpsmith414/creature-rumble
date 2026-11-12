import { describe, expect, test } from 'vitest';
import { clearOf, type Band } from '../../src/show/pops';

/** The banner as it sits on a TV: across the middle, from 13% down to about a third of the way down. */
const BANNER: Band = { top: 0.13, bottom: 0.34, left: 0.2, right: 0.8 };
/** A pop's extent as it floats up (fractions of the screen, at size 1): it must miss the band all the way. */
const covers = (x: number, y: number, b: Band, size = 1) =>
  !(x + 0.09 * size < b.left || x - 0.09 * size > b.right) && !(y - 0.03 * size - 0.05 * size > b.bottom || y + 0.03 * size < b.top);

describe('clearOf: comic pops keep off the banner', () => {
  test('a pop that would land on the banner (or float up into it) moves to just below it', () => {
    for (const y of [0.15, 0.25, 0.33, 0.38]) {
      const out = clearOf(0.5, y, BANNER, 1.4);
      expect(out, `from ${y}`).toBeGreaterThan(BANNER.bottom);
      expect(covers(0.5, out, BANNER, 1.4)).toBe(false);
      expect(out).toBeLessThan(0.6); // just below, not far away
    }
  });

  test('a pop clear of it stays where it is', () => {
    expect(clearOf(0.5, 0.7, BANNER)).toBe(0.7); // well below
    expect(clearOf(0.05, 0.2, BANNER)).toBe(0.2); // beside it
    expect(clearOf(0.5, 0.05, { ...BANNER, top: 0.2 })).toBe(0.05); // above it
    expect(clearOf(0.5, 0.25, null)).toBe(0.25); // no banner up
  });

  test('with no room below, it goes above the banner instead', () => {
    const low: Band = { top: 0.6, bottom: 0.97, left: 0.2, right: 0.8 };
    const out = clearOf(0.5, 0.8, low);
    expect(out).toBeLessThan(low.top);
    expect(covers(0.5, out, low)).toBe(false);
  });
});
