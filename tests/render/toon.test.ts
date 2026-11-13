import { describe, expect, it, test } from 'vitest';
import { packRegions } from '../../src/skin/patterns';
import { Mesh } from 'three/webgpu';
import { createToonMaterial, GLOW_KEY, setGlow, TOON_BANDS, toonBand, toonGradient } from '../../src/render/toon';
import { loadFixture } from '../fixtures/fighters';

describe('toonBand', () => {
  test('toon bands are hard steps', () => {
    expect(toonBand(0.2)).toBe(0.35);
    expect(toonBand(0.5)).toBe(0.7);
    expect(toonBand(0.9)).toBe(1);
  });

  it('covers the whole range with exactly three shades, darkest facing away', () => {
    expect(TOON_BANDS).toEqual([0.35, 0.7, 1]);
    expect(toonBand(0)).toBe(0.35);
    expect(toonBand(1)).toBe(1);
    expect(toonBand(-0.5)).toBe(0.35);
    expect(toonBand(1.5)).toBe(1);
    const seen = new Set<number>();
    for (let u = 0; u <= 1; u += 0.01) seen.add(toonBand(u));
    expect([...seen]).toEqual([0.35, 0.7, 1]);
  });
});

describe('the toon gradient the shader reads', () => {
  it('is the same three shades, one texel each, unfiltered (so the GPU steps exactly as toonBand)', () => {
    const t = toonGradient();
    expect(t.image.width).toBe(3);
    expect([...(t.image.data as Uint8Array)]).toEqual([89, 179, 255]); // 0.35, 0.7, 1
    expect(t.minFilter).toBe(t.magFilter);
    expect(t.magFilter).toBe(1003); // NearestFilter
    expect(toonGradient()).toBe(t); // one for every fighter
  });
});

describe('createToonMaterial', () => {
  const r = loadFixture('fists');
  const pack = packRegions(r, r.skin.regions.map((x) => x.id));

  it('paints the region colours, lit in hard bands, with a rim and no relief', () => {
    const m = createToonMaterial(pack);
    expect((m as unknown as { isMeshToonNodeMaterial?: boolean }).isMeshToonNodeMaterial).toBe(true);
    expect(m.gradientMap).toBe(toonGradient());
    expect(m.colorNode).not.toBeNull();
    expect(m.emissiveNode).not.toBeNull(); // the rim
    expect(m.normalNode).toBeNull(); // no bump relief
    expect(m.aoNode).toBeNull(); // no cavity darkening
  });
});

describe("a special's glow", () => {
  it('is a level kept on the object, clamped to 0 … 1, so the material never changes', () => {
    const r = loadFixture('fists');
    const m = createToonMaterial(packRegions(r, r.skin.regions.map((x) => x.id)));
    const mesh = new Mesh(undefined, m);
    const before = m.emissiveNode;
    const version = m.version;
    setGlow(mesh, 0.6);
    expect(mesh.userData[GLOW_KEY]).toBe(0.6);
    setGlow(mesh, 3);
    expect(mesh.userData[GLOW_KEY]).toBe(1);
    setGlow(mesh, -1);
    expect(mesh.userData[GLOW_KEY]).toBe(0);
    setGlow(mesh, Number.NaN);
    expect(mesh.userData[GLOW_KEY]).toBe(0);
    expect(m.emissiveNode).toBe(before);
    expect(m.version).toBe(version); // no recompile
  });
});
