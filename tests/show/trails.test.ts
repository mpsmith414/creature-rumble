import { Color, Matrix4, Scene, Vector3 } from 'three/webgpu';
import { describe, expect, test } from 'vitest';
import { GHOSTS, ghostFade, ghostsDue, TRAIL_EVERY, TRAIL_LIFE, trailColour, Trails, TRAILS } from '../../src/show/trails';
import { loadFixture } from '../fixtures/fighters';

const RED = new Color(1, 0, 0);
const DT = 1 / 60;

describe('ghostFade', () => {
  test('a ghost starts full size and shrinks steadily to nothing at TRAIL_LIFE', () => {
    expect(ghostFade(0)).toBeCloseTo(1);
    let last = Infinity;
    for (let a = 0; a < TRAIL_LIFE; a += 0.01) {
      const k = ghostFade(a);
      expect(k).toBeLessThanOrEqual(last);
      expect(k).toBeGreaterThanOrEqual(0);
      last = k;
    }
    expect(ghostFade(TRAIL_LIFE)).toBe(0);
    expect(ghostFade(-1)).toBe(0);
  });
});

describe('ghostsDue', () => {
  test('one ghost every TRAIL_EVERY s, whatever the frame rate', () => {
    let since = 0, n = 0;
    for (let i = 0; i < 60; i++) {
      const d = ghostsDue(since, DT);
      since = d.left;
      n += d.n;
    }
    expect(n).toBe(Math.floor(1 / TRAIL_EVERY + 1e-9));
  });
  test('a stalled frame drops at most a whole trail', () => {
    expect(ghostsDue(0, 10).n).toBe(GHOSTS);
  });
});

describe('Trails', () => {
  const visible = (t: Trails) => {
    const m = new Matrix4(), s = new Vector3();
    let n = 0;
    for (let i = 0; i < TRAILS * GHOSTS; i++) {
      t.mesh.getMatrixAt(i, m);
      s.setFromMatrixScale(m);
      if (s.x > 1e-6) n++;
    }
    return n;
  };

  test('one instanced mesh for every ghost, made once', () => {
    const scene = new Scene();
    const t = new Trails(scene);
    expect(scene.children).toEqual([t.mesh]);
    expect(t.mesh.count).toBe(TRAILS * GHOSTS);
    expect(visible(t)).toBe(0);
  });

  test('a flier leaves ghosts behind it that shrink away once it lands, and its slot is freed', () => {
    const t = new Trails(new Scene());
    const key = {};
    for (let i = 0; i < 20; i++) t.update(key, { x: i * 0.2, y: 3, z: 0 }, 1.4, true, RED, DT);
    expect(t.count).toBe(1);
    expect(t.ghosts).toBeGreaterThan(3);
    expect(t.ghosts).toBeLessThanOrEqual(GHOSTS);
    expect(visible(t)).toBe(t.ghosts);
    for (let i = 0; i < 30; i++) t.update(key, { x: 4, y: 1, z: 0 }, 1.4, false, RED, DT);
    expect(t.ghosts).toBe(0);
    expect(t.count).toBe(0);
    expect(visible(t)).toBe(0);
  });

  test('someone on the ground never takes a slot', () => {
    const t = new Trails(new Scene());
    t.update({}, { x: 0, y: 1, z: 0 }, 1.4, false, RED, DT);
    expect(t.count).toBe(0);
  });

  test('at most TRAILS fliers trail at once; remove and clear free them', () => {
    const t = new Trails(new Scene());
    const keys = Array.from({ length: TRAILS + 4 }, () => ({}));
    for (const k of keys) t.update(k, { x: 0, y: 3, z: 0 }, 1, true, RED, DT);
    expect(t.count).toBe(TRAILS);
    t.remove(keys[0]);
    expect(t.count).toBe(TRAILS - 1);
    t.update(keys[TRAILS + 1], { x: 0, y: 3, z: 0 }, 1, true, RED, DT);
    expect(t.count).toBe(TRAILS);
    t.clear();
    expect(t.count).toBe(0);
    expect(visible(t)).toBe(0);
  });

  test('the ghosts take the fighter’s colour', () => {
    const t = new Trails(new Scene());
    t.update({}, { x: 0, y: 3, z: 0 }, 1, true, RED, DT);
    const c = new Color();
    t.mesh.getColorAt(0, c);
    expect(c.r).toBeCloseTo(1);
    expect(c.g).toBeCloseTo(0);
  });

  test('trailColour is the body’s colour, a little lighter', () => {
    const r = loadFixture('fists');
    const c = trailColour(r);
    const root = r.parts.find((p) => p.parent === null)!;
    const base = new Color(r.skin.regions.find((x) => x.id === root.region)!.color);
    expect(c.r).toBeGreaterThanOrEqual(base.r - 1e-6);
    expect(c.g).toBeGreaterThanOrEqual(base.g - 1e-6);
  });
});
