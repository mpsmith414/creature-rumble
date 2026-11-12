import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { buildBody } from '../../src/builder/build';
import { gaze, eyePlaces } from '../../src/skin/eyes';
import { fox } from '../fixtures/cast/fox';
import { deer } from '../fixtures/cast/deer';
import { frog } from '../fixtures/cast/frog';

// coarse bodies (built inside the tests, under this timeout): only their skeletons matter here
const BUILD = 30_000;
const turn = (d: { x: number; y: number; z: number }) => gaze(new Vector3(d.x, d.y, d.z));

describe('eyePlaces', () => {
  it('puts one eyeball on each eye bone, looking along it', () => {
    const body = buildBody(fox, [2]);
    const eyes = body.skeleton.bones.filter((d) => d.role === 'eye');
    const places = eyePlaces(body, fox.skin.eyes.size);
    expect(places).toHaveLength(eyes.length);
    expect(places.length).toBeGreaterThan(0);
    for (const p of places) expect(Math.hypot(p.dir.x, p.dir.y, p.dir.z)).toBeCloseTo(1, 9);
  }, BUILD);
});

describe('gaze', () => {
  it("turns local +z along the gaze and keeps local up as near the body up as can be, a frog's upturned eye too", () => {
    const body = buildBody(frog, [2]);
    const places = eyePlaces(body, frog.skin.eyes.size);
    expect(places.some((p) => p.dir.y > 0.5)).toBe(true);
    for (const p of places) {
      const q = turn(p.dir), z = new Vector3(0, 0, 1).applyQuaternion(q), y = new Vector3(0, 1, 0).applyQuaternion(q);
      expect(z.distanceTo(new Vector3(p.dir.x, p.dir.y, p.dir.z))).toBeLessThan(1e-9);
      expect(y.y).toBeCloseTo(Math.sqrt(1 - p.dir.y * p.dir.y), 9);
    }
  }, BUILD);

  it("stands a fox's slit upright and lays a deer's bar level (local y vertical-ish, local x level)", () => {
    expect(fox.skin.eyes.pupil).toBe('slit');
    expect(deer.skin.eyes.pupil).toBe('bar');
    for (const p of eyePlaces(buildBody(fox, [2]), fox.skin.eyes.size)) {
      const q = turn(p.dir), x = new Vector3(1, 0, 0).applyQuaternion(q), y = new Vector3(0, 1, 0).applyQuaternion(q);
      expect(y.y).toBeCloseTo(Math.sqrt(1 - p.dir.y * p.dir.y), 9);
      expect(x.y).toBeCloseTo(0, 9);
    }
    for (const p of eyePlaces(buildBody(deer, [2]), deer.skin.eyes.size)) expect(new Vector3(1, 0, 0).applyQuaternion(turn(p.dir)).y).toBeCloseTo(0, 9);
  }, BUILD);
});
