import { describe, expect, test } from 'vitest';
import { TUNE } from '../../src/fight/tune';
import { ENTRANCE_S, GROUP_ENTRANCE_S } from '../../src/match/rules';
import {
  column, entranceAt, LAND_IN, landingAngle, marchOrder, MEMBER_GAP, SHOW_JUMP, WALK_BOB, WALK_FROM, WALK_TO,
} from '../../src/show/timeline';
import { starScale, starsVisible } from '../../src/show/stars';

test('solo entrance phases and banners', () => {
  expect(entranceAt(1, false)).toMatchObject({ phase: 'walk', banner: 'maker' });
  expect(entranceAt(2, false).banner).toBe('name');
  expect(entranceAt(5, false).phase).toBe('showOff');
  expect(entranceAt(8.6, false).phase).toBe('done');
});
test('dizzy stars show only once a fighter is wobbly enough', () => { expect(starsVisible(0, 0.035)).toBe(false); expect(starsVisible(15, 0.035)).toBe(true); });
test('group entrance is about 5 s', () => { expect(entranceAt(4.9, true).phase).not.toBe('done'); expect(entranceAt(5.1, true).phase).toBe('done'); });

describe('entranceAt', () => {
  test('solo: walk 0–4.5 s, show-off 4.5–6, hop in 6–7.5, landed until 8.5 (the match’s entrance)', () => {
    expect(entranceAt(0, false).phase).toBe('walk');
    expect(entranceAt(4.49, false).phase).toBe('walk');
    expect(entranceAt(4.51, false).phase).toBe('showOff');
    expect(entranceAt(5.99, false).phase).toBe('showOff');
    expect(entranceAt(6.01, false).phase).toBe('hopIn');
    expect(entranceAt(8.4, false)).toMatchObject({ phase: 'hopIn', hop: 1, walk: 1 });
    expect(entranceAt(ENTRANCE_S, false).phase).toBe('done');
  });

  test('group: walk 0–2.5 s, show-off 2.5–3.5, hop in 3.5–4.5, done at the match’s 5 s', () => {
    expect(entranceAt(2.4, true).phase).toBe('walk');
    expect(entranceAt(2.6, true).phase).toBe('showOff');
    expect(entranceAt(3.6, true).phase).toBe('hopIn');
    expect(entranceAt(4.6, true)).toMatchObject({ phase: 'hopIn', hop: 1 });
    expect(entranceAt(GROUP_ENTRANCE_S, true).phase).toBe('done');
  });

  test('the walk goes 0 → 1 along the bridge, eased, with a hop bob of |sin 9t| × 0.35 that settles at the end', () => {
    expect(entranceAt(0, false).walk).toBe(0);
    expect(entranceAt(2.25, false).walk).toBeCloseTo(0.5);
    expect(entranceAt(4.5, false).walk).toBe(1);
    expect(entranceAt(0.5, false).walk).toBeLessThan(0.5 / 4.5); // eased in
    const t = 1.3;
    expect(entranceAt(t, false).bob).toBeCloseTo(Math.abs(Math.sin(9 * t)) * WALK_BOB);
    expect(entranceAt(4.5, false).bob).toBeCloseTo(0); // no jump into the show-off
    for (let s = 0; s < 4.5; s += 0.05) expect(entranceAt(s, false).bob).toBeLessThanOrEqual(WALK_BOB + 1e-9);
  });

  test('group members bob out of step', () => {
    expect(entranceAt(1, true, 0).bob).not.toBeCloseTo(entranceAt(1, true, 1).bob);
    expect(entranceAt(1, true, 0).phase).toBe(entranceAt(1, true, 1).phase);
  });

  test('the show-off spins once round and jumps (a fraction of SHOW_JUMP × ring height), landing where it took off', () => {
    expect(entranceAt(4.5, false)).toMatchObject({ spin: 0, jump: 0 });
    expect(entranceAt(5.25, false).spin).toBeCloseTo(Math.PI);
    expect(entranceAt(5.25, false).jump).toBeCloseTo(1);
    expect(entranceAt(5.99, false).spin).toBeCloseTo(2 * Math.PI, 1);
    expect(entranceAt(5.99, false).jump).toBeLessThan(0.05);
    expect(entranceAt(6.5, false)).toMatchObject({ spin: 0, jump: 0, bob: 0 });
    expect(SHOW_JUMP).toBe(1.4);
  });

  test('the hop goes 0 → 1 over 6–7.5 s', () => {
    expect(entranceAt(6, false).hop).toBe(0);
    expect(entranceAt(6.75, false).hop).toBeCloseTo(0.5);
    expect(entranceAt(7.5, false).hop).toBe(1);
    expect(entranceAt(3, false).hop).toBe(0);
  });

  test('banners: solo shows the maker from 0 and the name from 1.6 s; a group shows the names from the start', () => {
    expect(entranceAt(0, false).banner).toBe('maker');
    expect(entranceAt(1.59, false).banner).toBe('maker');
    expect(entranceAt(1.61, false).banner).toBe('name');
    expect(entranceAt(6, false).banner).toBe('name');
    expect(entranceAt(7, false).banner).toBeNull();
    expect(entranceAt(0, true).banner).toBe('name');
    expect(entranceAt(4.7, true).banner).toBeNull();
    expect(entranceAt(9, false).banner).toBeNull();
  });
});

describe('group spacing', () => {
  test('one walks the whole bridge; two or three walk in single file 1.2 m apart', () => {
    expect(column(1)).toEqual({ gap: MEMBER_GAP, travel: WALK_FROM - WALK_TO });
    const two = column(2), three = column(3);
    expect(two.gap).toBe(1.2);
    expect(three.gap).toBe(1.2);
    expect(three.travel).toBeCloseTo(WALK_FROM - WALK_TO - 2 * 1.2);
  });

  test('a long line still fits on the bridge: the last one starts no further out than the solo walker', () => {
    for (let n = 1; n <= 8; n++) {
      const { gap, travel } = column(n);
      expect(gap).toBeGreaterThan(0.9);
      expect(gap).toBeLessThanOrEqual(MEMBER_GAP);
      expect(travel).toBeGreaterThanOrEqual(0);
      expect(WALK_TO + (n - 1) * gap + travel).toBeCloseTo(WALK_FROM);
    }
  });

  test('the champion walks in last; everyone else keeps their order', () => {
    expect(marchOrder(['a', 'champ', 'b', 'c'], 'champ')).toEqual(['a', 'b', 'c', 'champ']);
    expect(marchOrder(['a', 'b'], null)).toEqual(['a', 'b']);
    expect(marchOrder(['a', 'b'], 'zed')).toEqual(['a', 'b']);
    const list = ['x', 'y'];
    marchOrder(list, 'x');
    expect(list).toEqual(['x', 'y']); // not changed in place
  });

  test('landing spots fan out round the ring, about a member apart, all inside the bumper', () => {
    expect(landingAngle(0, 1, TUNE.ringRadius)).toBe(0);
    const R = TUNE.ringRadius, r = R - LAND_IN;
    for (let n = 2; n <= 8; n++) {
      const as = Array.from({ length: n }, (_, i) => landingAngle(i, n, R));
      expect(as[0]).toBeCloseTo(-as[n - 1]); // centred on the entry
      for (let i = 1; i < n; i++) expect(r * (as[i] - as[i - 1])).toBeGreaterThan(1.1); // apart on the ring
      expect(Math.abs(as[0])).toBeLessThan(Math.PI / 2);
    }
  });
});

describe('dizzy stars', () => {
  test('appear once the knock multiplier passes 0.8, with the live build', () => {
    const at = (0.8 - 0.3) / TUNE.build;
    expect(starsVisible(at - 0.1, TUNE.build)).toBe(false);
    expect(starsVisible(at + 0.1, TUNE.build)).toBe(true);
  });
  test('grow as the fighter gets wobblier, within limits', () => {
    const b = 0.045;
    expect(starScale(12, b)).toBeLessThan(starScale(20, b));
    expect(starScale(0, b)).toBeGreaterThan(0);
    expect(starScale(1000, b)).toBe(starScale(2000, b));
  });
});
