import { describe, expect, it } from 'vitest';
import { RecipeSchema } from '../../src/recipe/schema';
import { KINDS, loadFixture } from '../fixtures/fighters';

/** The seven fighter fixtures must not look samey in the dev views: a palette and markings of their own each. */
describe('fighter fixture skins', () => {
  const all = KINDS.map((k) => ({ k, r: loadFixture(k) }));
  const regions = (k: (typeof KINDS)[number]) => loadFixture(k).skin.regions;

  it('every fixture is still a valid recipe', () => {
    for (const { k, r } of all) expect(RecipeSchema.safeParse(r).success, k).toBe(true);
  });

  it('no two fixtures share a palette, or even a main colour', () => {
    const palette = (k: (typeof KINDS)[number]) =>
      JSON.stringify(regions(k).flatMap((g) => [g.color, g.belly, g.pattern?.color ?? null]).sort());
    expect(new Set(KINDS.map(palette)).size).toBe(KINDS.length);
    expect(new Set(KINDS.map((k) => regions(k)[0].color.toLowerCase())).size).toBe(KINDS.length);
  });

  it('at least five wear a pattern, of at least three kinds, in a colour that is not their own', () => {
    const patterned = all.flatMap(({ r }) => r.skin.regions.filter((g) => g.pattern).map((g) => ({ g, kind: g.pattern!.kind })));
    expect(new Set(all.filter(({ r }) => r.skin.regions.some((g) => g.pattern)).map(({ k }) => k)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(patterned.map((p) => p.kind)).size).toBeGreaterThanOrEqual(3);
    for (const { g } of patterned) {
      expect(g.pattern!.color.toLowerCase()).not.toBe(g.color.toLowerCase());
      expect(g.pattern!.amount).toBeGreaterThan(0.15);
    }
  });

  it('every one has a belly colour and no fur', () => {
    for (const k of KINDS) {
      expect(regions(k)[0].belly, k).not.toBeNull();
      for (const g of regions(k)) expect([g.furLength, g.fluff], k).toEqual([0, 0]);
    }
  });
});
