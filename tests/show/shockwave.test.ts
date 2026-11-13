import { Mesh, Scene, Vector3 } from 'three/webgpu';
import { describe, expect, test } from 'vitest';
import { SHOCK_MIN, SHOCK_POOL, SHOCK_S, Shockwaves, shockwaveAt } from '../../src/show/shockwave';

describe('shockwaveAt', () => {
  test('bursts out to its reach as it fades, over about 0.6 s', () => {
    expect(SHOCK_S).toBeCloseTo(0.6, 5);
    const r = 3;
    let lastScale = 0, lastOpacity = Infinity;
    for (let t = 0; t < SHOCK_S; t += 0.02) {
      const s = shockwaveAt(t, r);
      expect(s.alive).toBe(true);
      expect(s.scale).toBeGreaterThanOrEqual(lastScale);
      expect(s.opacity).toBeLessThanOrEqual(lastOpacity);
      expect(s.scale).toBeLessThanOrEqual(r + 1e-9);
      lastScale = s.scale;
      lastOpacity = s.opacity;
    }
    expect(shockwaveAt(0, r).scale).toBeLessThan(r * 0.3);
    expect(shockwaveAt(SHOCK_S * 0.5, r).scale).toBeGreaterThan(r * 0.8); // fast out, then slows
    expect(shockwaveAt(SHOCK_S * 0.98, r).opacity).toBeLessThan(0.02);
  });

  test('is gone after its time, and before its start', () => {
    expect(shockwaveAt(SHOCK_S, 3)).toMatchObject({ alive: false, opacity: 0 });
    expect(shockwaveAt(-0.1, 3).alive).toBe(false);
  });

  test('scales to the reach, never smaller than SHOCK_MIN', () => {
    expect(shockwaveAt(0.3, 4).scale).toBeCloseTo(2 * shockwaveAt(0.3, 2).scale);
    expect(shockwaveAt(0.59, 0.1).scale).toBeLessThanOrEqual(SHOCK_MIN + 1e-9);
    expect(shockwaveAt(0.59, Number.NaN).scale).toBeCloseTo(shockwaveAt(0.59, SHOCK_MIN).scale);
  });
});

describe('Shockwaves', () => {
  test('a pool made once: rings show, grow, hide; the oldest is reused when all are busy', () => {
    const scene = new Scene();
    const w = new Shockwaves(scene);
    expect(scene.children).toHaveLength(1);
    expect(w.group.children).toHaveLength(SHOCK_POOL);
    w.spawn(new Vector3(1, 0, 2), 3);
    expect(w.live).toBe(1);
    const ring = w.group.children.find((c) => c.visible) as Mesh;
    expect(ring.position.x).toBe(1);
    expect(ring.position.y).toBeGreaterThan(0); // lies just over the floor
    const s0 = ring.scale.x;
    w.update(0.2);
    expect(ring.scale.x).toBeGreaterThan(s0);
    for (let i = 0; i < SHOCK_POOL + 3; i++) w.spawn(new Vector3(), 2);
    expect(w.live).toBe(SHOCK_POOL);
    expect(w.group.children).toHaveLength(SHOCK_POOL);
    w.update(SHOCK_S + 0.01);
    expect(w.live).toBe(0);
    w.spawn(new Vector3(), 2);
    w.clear();
    expect(w.live).toBe(0);
    w.dispose();
    expect(scene.children).toHaveLength(0);
  });

  test('an impact up in the air still rings the floor below it', () => {
    const w = new Shockwaves(new Scene());
    w.spawn(new Vector3(0, 4, 0), 2);
    expect((w.group.children.find((c) => c.visible) as Mesh).position.y).toBeLessThan(0.6);
  });
});
