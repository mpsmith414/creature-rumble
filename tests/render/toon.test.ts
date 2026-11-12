import { describe, expect, it, test } from 'vitest';
import { packRegions } from '../../src/skin/patterns';
import { createToonMaterial, TOON_BANDS, toonBand, toonGradient } from '../../src/render/toon';
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
