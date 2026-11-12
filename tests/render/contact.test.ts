import { Vector3, type BufferAttribute } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { buildSkeleton } from '../../src/builder/skeleton';
import { castUnder, contactOpacity, createContactShadows, footprint, groundNormal } from '../../src/render/contact';
import { deer } from '../fixtures/cast/deer';

const sk = buildSkeleton(deer);

describe('footprint', () => {
  it('is longer than wide for the deer, centred on the skeleton, 1.15 times its extents', () => {
    const fp = footprint(sk);
    expect(fp.hx).toBeGreaterThan(0);
    expect(fp.hz).toBeGreaterThan(fp.hx);
    expect(fp.hz).toBeCloseTo(1.15 * (sk.max.z - sk.min.z) / 2);
    expect(fp.cz).toBeCloseTo((sk.max.z + sk.min.z) / 2);
  });
});

describe('contactOpacity', () => {
  it('is 0.35 on the ground, 0 a body length up, 0 in water', () => {
    expect(contactOpacity(0, 1, false)).toBeCloseTo(0.35);
    expect(contactOpacity(1, 1, false)).toBe(0);
    expect(contactOpacity(3, 1, false)).toBe(0);
    expect(contactOpacity(0, 1, true)).toBe(0);
  });
  it('only fades as the animal rises', () => {
    let last = Infinity;
    for (let h = 0; h <= 1.2; h += 0.1) {
      const o = contactOpacity(h, 1, false);
      expect(o).toBeLessThanOrEqual(last);
      last = o;
    }
  });
});

describe('groundNormal', () => {
  it('is up on flat ground and leans away from a rise', () => {
    const n = new Vector3();
    groundNormal(() => 2, 3, 4, 0.5, n);
    expect(n.toArray()).toEqual([0, 1, 0]);
    groundNormal((x) => 0.5 * x, 0, 0, 0.5, n); // rises towards +x
    expect(n.x).toBeLessThan(0);
    expect(n.y).toBeGreaterThan(0);
    expect(n.length()).toBeCloseTo(1);
  });
});

describe('createContactShadows', () => {
  const fp = { hx: 0.4, hz: 0.8, cx: 0, cz: 0 };
  const up = new Vector3(0, 1, 0);

  it('writes the instance matrix (the quad centre lands at pos, scaled by the footprint) and the opacity', () => {
    const s = createContactShadows(4);
    s.set(2, new Vector3(3, 1, -2), up, 0, fp, 0.3);
    const m = s.mesh.getMatrixAt(2, new (s.mesh.matrix.constructor as new () => typeof s.mesh.matrix)());
    expect(new Vector3(0, 0, 0).applyMatrix4(m).toArray()).toEqual([3, 1, -2]);
    const edge = new Vector3(1, 0, 1).applyMatrix4(m);
    expect(edge.x - 3).toBeCloseTo(0.4);
    expect(edge.z + 2).toBeCloseTo(0.8);
    expect((s.mesh.geometry.getAttribute('opacity') as { array: Float32Array }).array[2]).toBeCloseTo(0.3);
    s.dispose();
  });

  it('turns with the yaw and tilts to the normal', () => {
    const s = createContactShadows(1);
    s.set(0, new Vector3(), up, Math.PI / 2, fp, 0.3); // facing +x: the long side lies along x
    const m = s.mesh.getMatrixAt(0, s.mesh.matrix.clone());
    const along = new Vector3(0, 0, 1).applyMatrix4(m);
    expect(along.x).toBeCloseTo(0.8);
    expect(along.z).toBeCloseTo(0, 5);
    const tilt = new Vector3(1, 1, 0).normalize();
    s.set(0, new Vector3(), tilt, 0, fp, 0.3);
    const up2 = new Vector3(0, 1, 0).transformDirection(s.mesh.getMatrixAt(0, s.mesh.matrix.clone()));
    expect(up2.distanceTo(tilt)).toBeLessThan(1e-6);
    s.dispose();
  });

  it('puts the footprint centre offset under the creature, turned by the yaw', () => {
    const g = { heightAt: () => 0 };
    const t = createContactShadows(1);
    castUnder(t, 0, { position: new Vector3(5, 0, 5), yaw: Math.PI / 2, altitude: 0, inWater: false, bodyLength: 1 }, g, { ...fp, cx: 0, cz: 1 });
    const c = new Vector3().applyMatrix4(t.mesh.getMatrixAt(0, t.mesh.matrix.clone()));
    expect(c.x).toBeCloseTo(6); // one metre ahead of it, facing +x
    expect(c.z).toBeCloseTo(5);
    t.dispose();
  });

  it('hides an instance (no opacity, no size)', () => {
    const s = createContactShadows(2);
    s.set(1, new Vector3(1, 0, 1), up, 0, fp, 0.3);
    s.hide(1);
    const m = s.mesh.getMatrixAt(1, s.mesh.matrix.clone());
    expect(new Vector3(1, 0, 1).applyMatrix4(m).length()).toBe(0);
    expect((s.mesh.geometry.getAttribute('opacity') as { array: Float32Array }).array[1]).toBe(0);
    s.dispose();
  });

  it('hides an instance already hidden without uploading anything', () => {
    const s = createContactShadows(2), op = s.mesh.geometry.getAttribute('opacity') as BufferAttribute;
    const versions = () => [s.mesh.instanceMatrix.version, op.version];
    const fresh = versions();
    s.hide(0); // hidden from the start
    expect(versions()).toEqual(fresh);
    s.set(0, new Vector3(1, 0, 1), up, 0, fp, 0.3);
    s.hide(0);
    const hidden = versions();
    expect(hidden).not.toEqual(fresh);
    s.hide(0); // and again
    expect(versions()).toEqual(hidden);
    s.dispose();
  });

  it('starts with every instance hidden and does not cull', () => {
    const s = createContactShadows(3);
    expect(Array.from((s.mesh.geometry.getAttribute('opacity') as { array: Float32Array }).array)).toEqual([0, 0, 0]);
    expect(s.mesh.frustumCulled).toBe(false);
    expect(s.mesh.castShadow || s.mesh.receiveShadow).toBe(false);
    s.dispose();
  });
});

describe('castUnder', () => {
  const ground = { heightAt: (x: number) => 0.1 * x };
  const rig = (over: object = {}) => ({ position: new Vector3(2, 0, 0), yaw: 0, altitude: 0, inWater: false, bodyLength: 1, ...over });
  const alpha = (s: ReturnType<typeof createContactShadows>) => (s.mesh.geometry.getAttribute('opacity') as { array: Float32Array }).array[0];

  it('shades an animal on the ground and says so', () => {
    const s = createContactShadows(1);
    expect(castUnder(s, 0, rig(), ground, { hx: 0.3, hz: 0.6, cx: 0, cz: 0 })).toBe(true);
    expect(alpha(s)).toBeCloseTo(0.35);
    s.dispose();
  });
  it('gives none in water or high in the air', () => {
    const s = createContactShadows(1);
    expect(castUnder(s, 0, rig({ inWater: true }), ground, { hx: 0.3, hz: 0.6, cx: 0, cz: 0 })).toBe(false);
    expect(alpha(s)).toBe(0);
    expect(castUnder(s, 0, rig({ altitude: 5 }), ground, { hx: 0.3, hz: 0.6, cx: 0, cz: 0 })).toBe(false);
    s.dispose();
  });
  it('fades by `fade` (an animal going down into the ground), and gives none at 0', () => {
    const s = createContactShadows(1), fp = { hx: 0.3, hz: 0.6, cx: 0, cz: 0 };
    expect(castUnder(s, 0, rig(), ground, fp, 0.5)).toBe(true);
    expect(alpha(s)).toBeCloseTo(0.35 * 0.5);
    expect(castUnder(s, 0, rig({ altitude: 0.5 }), ground, fp, 0.5)).toBe(true);
    expect(alpha(s)).toBeCloseTo(0.35 * 0.5 * 0.5);
    expect(castUnder(s, 0, rig(), ground, fp, 0)).toBe(false);
    expect(alpha(s)).toBe(0);
    s.dispose();
  });
});
