import { describe, expect, test } from 'vitest';
import { TUNE } from '../../src/fight/tune';
import { bigLaunch, SlowMo } from '../../src/show/slowmo';

test('slow-mo fires once per cooldown', () => {
  const s = new SlowMo();
  expect(s.trigger(10)).toBe(true); expect(s.timeScale(10.4)).toBeCloseTo(0.25);
  expect(s.timeScale(11)).toBe(1); expect(s.trigger(12)).toBe(false); expect(s.trigger(16.1)).toBe(true);
});

describe('SlowMo', () => {
  test('runs at full speed until triggered', () => {
    const s = new SlowMo();
    expect(s.timeScale(0)).toBe(1);
    expect(s.timeScale(123)).toBe(1);
  });

  test('eases back to full speed over the last moment, never below the scale nor above 1', () => {
    const s = new SlowMo();
    s.trigger(0);
    let last = 0;
    for (let t = 0; t <= 0.8; t += 0.01) {
      const k = s.timeScale(t);
      expect(k).toBeGreaterThanOrEqual(0.25 - 1e-9);
      expect(k).toBeLessThanOrEqual(1);
      expect(k).toBeGreaterThanOrEqual(last - 1e-9);
      last = k;
    }
    expect(s.timeScale(0.7)).toBeGreaterThan(0.25);
    expect(s.timeScale(0.8)).toBe(1);
  });

  test('takes its scale, length and cooldown', () => {
    const s = new SlowMo({ scale: 0.5, seconds: 2, cooldown: 3 });
    expect(s.trigger(0)).toBe(true);
    expect(s.timeScale(1)).toBeCloseTo(0.5);
    expect(s.trigger(2.9)).toBe(false);
    expect(s.trigger(3)).toBe(true);
  });

  test('is not slowed before the moment it was triggered (a clock running backwards)', () => {
    const s = new SlowMo();
    s.trigger(10);
    expect(s.timeScale(9)).toBe(1);
  });
});

describe('bigLaunch: a hit that would carry its target over the bumper', () => {
  const R = TUNE.ringRadius, b = TUNE.build;
  const wobbly = (1 - 0.3) / b + 1; // knock multiplier just over 1

  test('needs the target near the edge and wobbly enough to fly', () => {
    expect(bigLaunch({ x: R - 1.5, z: 0 }, wobbly, b, R)).toBe(true);
    expect(bigLaunch({ x: 0, z: -(R - 1) }, wobbly, b, R)).toBe(true);
    expect(bigLaunch({ x: R - 2.5, z: 0 }, wobbly, b, R)).toBe(false); // too far in
    expect(bigLaunch({ x: R - 1, z: 0 }, wobbly - 2, b, R)).toBe(false); // not wobbly enough
  });

  test('a big pop-up near the edge counts even before the target is wobbly', () => {
    expect(bigLaunch({ x: R - 1, z: 0 }, 0, b, R, 9, 8.4)).toBe(true);
    expect(bigLaunch({ x: R - 1, z: 0 }, 0, b, R, 8, 8.4)).toBe(false); // not launched hard enough
    expect(bigLaunch({ x: 0, z: 0 }, 0, b, R, 20, 8.4)).toBe(false); // far from the edge
  });
});
