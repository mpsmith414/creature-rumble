import { describe, expect, it } from 'vitest';
import { buildBody } from '../../src/builder/build';
import { lodGeometry, restStarts } from '../../src/render/creature';
import { eyePlaces } from '../../src/skin/eyes';
import { fox } from '../fixtures/cast/fox';
import { quadruped } from '../fixtures/recipes';

// two coarse levels of detail are enough
const body = buildBody(quadruped, [2, 2]);
const foxBody = buildBody(fox, [0]); // the fox at full detail: its face, jaw and eyes

describe('the fighter geometry', () => {
  it('has exactly 8 vertex attributes (the WebGPU limit), the last the feature marks', () => {
    const g = lodGeometry(body.lods[0], body);
    expect(Object.keys(g.attributes).sort()).toEqual(['bodyPos', 'feature', 'normal', 'partInfo', 'position', 'skinIndex', 'skinWeight', 'tangent']);
    expect(g.attributes.restNormal).toBeUndefined(); // the shader reads the rest normal from `normal`
    expect(g.attributes.tangent.itemSize).toBe(4);
  });

  it('leaves the cavity out when asked (the toon fighters), keeping 7', () => {
    expect(Object.keys(lodGeometry(body.lods[0], body, [], false).attributes)).toHaveLength(7);
  });
});

describe('the belly flag (partInfo.w)', () => {
  it('fades out round the eyes (a socket ceiling faces down, and took the belly colour) but stays on the throat', () => {
    const g = lodGeometry(foxBody.lods[0], foxBody, eyePlaces(foxBody, fox.skin.eyes.size));
    const info = g.attributes.partInfo.array as Float32Array, P = foxBody.lods[0].positions, N = foxBody.lods[0].normals;
    const eyes = eyePlaces(foxBody, fox.skin.eyes.size);
    expect(eyes).toHaveLength(2);
    let near = 0, throat = 0;
    for (let v = 0; v < P.length / 3; v++) {
      const d = Math.min(...eyes.map((e) => Math.hypot(P[v * 3] - e.centre.x, P[v * 3 + 1] - e.centre.y, P[v * 3 + 2] - e.centre.z) / e.r));
      if (d < 1.3) {
        near++;
        expect(info[v * 4 + 3]).toBe(0);
      }
      if (d > 3 && N[v * 3 + 1] < -0.75 && info[v * 4 + 3] === 1) throat++;
    }
    expect(near).toBeGreaterThan(20);
    expect(throat).toBeGreaterThan(100);
  });
});

describe('restStarts', () => {
  it('raises the jaw bone by jawLift along the mouth up, leaving every other bone at its start', () => {
    const m = foxBody.mouth!, jd = foxBody.skeleton.jaw, rest = restStarts(foxBody);
    expect(jd).toBeGreaterThanOrEqual(0);
    foxBody.skeleton.bones.forEach((d, i) => {
      const want = i === jd
        ? { x: d.start.x + m.up.x * foxBody.jawLift, y: d.start.y + m.up.y * foxBody.jawLift, z: d.start.z + m.up.z * foxBody.jawLift }
        : d.start;
      expect(rest[i].x).toBeCloseTo(want.x, 9); expect(rest[i].y).toBeCloseTo(want.y, 9); expect(rest[i].z).toBeCloseTo(want.z, 9);
    });
  });
});
