import { describe, expect, test } from 'vitest';
import {
  angleDiff, BRIDGE_DOWN_Y, BRIDGE_RISE_S, BRIDGE_UP_Y, bridgeStep, bridgeY, BUMPER_TUBE, bumperScale, ENTRY_ANGLE, entryDir,
  POST_GAP, postAngles,
} from '../../src/arena/geometry';

describe('the posts', () => {
  test('seven of the eight stand round the ring; none in the entry gap', () => {
    const a = postAngles();
    expect(ENTRY_ANGLE).toBe(-0.55);
    expect(a).toHaveLength(7);
    for (const x of a) expect(Math.abs(angleDiff(x, ENTRY_ANGLE))).toBeGreaterThanOrEqual(POST_GAP);
  });

  test('the skipped one is the post nearest the entry, whatever the entry angle', () => {
    for (const entry of [0, 1, 2.5, -2]) {
      const all = postAngles(entry, 8, 0.2, 0);
      const kept = postAngles(entry, 8, 0.2, 0.4);
      expect(all).toHaveLength(8);
      const gone = all.filter((x) => !kept.includes(x));
      const nearest = all.reduce((b, x) => (Math.abs(angleDiff(x, entry)) < Math.abs(angleDiff(b, entry)) ? x : b));
      expect(gone).toEqual([nearest]);
    }
  });
});

describe('the entry', () => {
  test('dir points out from the centre at the entry angle, flat and unit length', () => {
    const d = entryDir(ENTRY_ANGLE);
    expect(d.y).toBe(0);
    expect(d.length()).toBeCloseTo(1);
    expect(Math.atan2(d.z, d.x)).toBeCloseTo(ENTRY_ANGLE);
    expect(d.x).toBeGreaterThan(0);
    expect(d.z).toBeLessThan(0);
  });
});

describe('the bridge', () => {
  test('rises at a steady rate, clamps at the top, and drops back the same way', () => {
    let p = 0;
    p = bridgeStep(p, true, BRIDGE_RISE_S / 2);
    expect(p).toBeCloseTo(0.5);
    p = bridgeStep(p, true, 10);
    expect(p).toBe(1);
    p = bridgeStep(p, false, BRIDGE_RISE_S / 4);
    expect(p).toBeCloseTo(0.75);
    p = bridgeStep(p, false, 10);
    expect(p).toBe(0);
  });

  test('its height eases in and out: down below, top at the floor when up, halfway at half', () => {
    expect(bridgeY(0)).toBeCloseTo(BRIDGE_DOWN_Y);
    expect(bridgeY(1)).toBeCloseTo(BRIDGE_UP_Y);
    expect(BRIDGE_UP_Y + 0.2).toBeCloseTo(0); // a 0.4 m slab: its top is the floor
    expect(bridgeY(0.5)).toBeCloseTo((BRIDGE_DOWN_Y + BRIDGE_UP_Y) / 2);
    // soft at both ends (small first and last steps), quickest in the middle
    const first = bridgeY(0.05) - bridgeY(0), mid = bridgeY(0.525) - bridgeY(0.475), last = bridgeY(1) - bridgeY(0.95);
    expect(first).toBeLessThan(mid / 4);
    expect(last).toBeLessThan(mid / 4);
    // never overshoots
    for (let p = -0.5; p <= 1.5; p += 0.05) {
      expect(bridgeY(p)).toBeGreaterThanOrEqual(BRIDGE_DOWN_Y - 1e-9);
      expect(bridgeY(p)).toBeLessThanOrEqual(BRIDGE_UP_Y + 1e-9);
    }
  });
});

describe('the bumper torus', () => {
  test('scaled so its tube spans the bumper height', () => {
    for (const h of [0.4, 0.65, 1.2]) expect(2 * BUMPER_TUBE * bumperScale(h)).toBeCloseTo(h);
    expect(bumperScale(0.05)).toBe(0.3); // never squashed flat
  });
});
