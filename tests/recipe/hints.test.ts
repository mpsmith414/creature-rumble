import { describe, expect, it } from 'vitest';
import { inferBuild, inferCoat, inferFace } from '../../src/recipe/hints';
import { CAST } from '../fixtures/cast';
import { normalizeRecipe } from '../../src/recipe/normalize';
import { MAX_BONES, MAX_PARTS } from '../../src/recipe/schema';
import { quadruped, snake } from '../fixtures/recipes';

const byId = (id: string) => CAST.find((c) => c.recipe.id === id)!.recipe;

describe('hint inference', () => {
  it('gives fur animals paws and a pad nose, heavy fur plant-eaters hooves', () => {
    expect(inferBuild(byId('fox')).feet).toBe('paws');
    expect(inferFace(byId('fox')).nose).toBe('pad');
    expect(inferBuild(byId('deer')).feet).toBe('hooves');
  });
  it('gives a heavy fur hunter paws, not hooves', () => {
    const wolf = byId('wolf');
    expect(wolf.life.massKg).toBeGreaterThan(30);
    expect(inferBuild(wolf).feet).toBe('paws');
    // a designer-made big cat: heavy, furred, eats meat
    expect(inferBuild({ ...wolf, life: { ...wolf.life, massKg: 120 } }).feet).toBe('paws');
  });
  it('gives a big fur herbivore hooves and a small one paws', () => {
    const wolf = byId('wolf');
    const grazer = { ...wolf, mind: { ...wolf.mind, plants: ['grass'], preyMin: 0, preyMax: 0 } };
    expect(inferBuild(grazer).feet).toBe('hooves');
    expect(inferBuild({ ...grazer, life: { ...grazer.life, massKg: 20 } }).feet).toBe('paws');
  });
  it('gives water birds a bill and webbed feet, other birds a beak and talons', () => {
    expect(inferFace(byId('duck')).nose).toBe('bill');
    expect(inferBuild(byId('duck')).feet).toBe('webbed');
    expect(inferFace(byId('hawk')).nose).toBe('beak');
    expect(inferBuild(byId('hawk')).feet).toBe('talons');
  });
  it('gives fish no lids', () => {
    expect(inferFace(byId('trout')).lids).toBe(false);
  });
  it('gives a legless body plain feet', () => {
    expect(inferBuild(snake).feet).toBe('plain');
  });
});

describe('inferCoat', () => {
  const fur = (furLength: number, fluff: number) => inferCoat({ covering: 'fur', furLength, fluff });
  it('reads fur from its length and fluff', () => {
    expect(fur(0.006, 0.1)).toBe('sleek');
    expect(fur(0.012, 0.15)).toBe('soft');
    expect(fur(0.06, 0.2)).toBe('shaggy');
    expect(fur(0.03, 0.8)).toBe('woolly');
    expect(fur(0.08, 0.9)).toBe('shaggy');
  });
  it('makes feathers downy when fluffy, else smooth', () => {
    expect(inferCoat({ covering: 'feathers', furLength: 0.02, fluff: 0.6 })).toBe('downy');
    expect(inferCoat({ covering: 'feathers', furLength: 0.02, fluff: 0.2 })).toBe('smooth');
  });
  it('gives other coverings no coat', () => {
    for (const covering of ['scales', 'skin', 'shell', 'slime'] as const) expect(inferCoat({ covering, furLength: 0, fluff: 0 })).toBeNull();
  });
});

describe('v1 → v2 → v3 → v4 upgrade', () => {
  it('fills build and face from the body and reports it', () => {
    const v1 = structuredClone(byId('fox')) as Record<string, unknown>;
    delete v1.build; delete v1.face; v1.schemaVersion = 1;
    const { recipe, fixes } = normalizeRecipe(v1);
    expect(recipe.schemaVersion).toBe(4);
    expect(recipe.build.feet).toBe('paws');
    expect(fixes).toContain('build missing → inferred');
    expect(fixes).toContain('face missing → inferred');
  });
  it('upgrades a v2 recipe: infers each region coat and reports it', () => {
    const v2 = structuredClone(byId('fox')) as Record<string, unknown>;
    v2.schemaVersion = 2;
    for (const r of (v2.skin as { regions: Record<string, unknown>[] }).regions) delete r.coat;
    const { recipe, fixes } = normalizeRecipe(v2);
    expect(recipe.schemaVersion).toBe(4);
    // the fox's own coats are chosen by hand; a v2 recipe has none, so each is inferred
    expect(recipe.skin.regions).toEqual(byId('fox').skin.regions.map((r) => ({ ...r, coat: inferCoat(r) })));
    expect(fixes).toContain(`skin.regions[0].coat → ${recipe.skin.regions[0].coat}`);
    expect(recipe.skin.regions[0].coat).toBe(inferCoat(recipe.skin.regions[0]));
  });
  it('repairs a coat that does not fit its covering', () => {
    const raw = structuredClone(quadruped) as unknown as { skin: { regions: Record<string, unknown>[] } };
    raw.skin.regions = [
      { ...raw.skin.regions[0], covering: 'feathers', furLength: 0.02, fluff: 0.2, coat: 'woolly' },
      { ...raw.skin.regions[1], covering: 'scales', coat: 'soft' },
      { ...raw.skin.regions[0], id: 'mane', covering: 'fur', coat: 'downy' },
      { ...raw.skin.regions[0], id: 'odd', covering: 'fur', coat: 'fluffy' },
    ];
    const { recipe, fixes } = normalizeRecipe(raw);
    expect(recipe.skin.regions.map((r) => r.coat)).toEqual(['smooth', null, 'soft', 'soft']);
    expect(fixes).toContain('skin.regions[0].coat → smooth');
    expect(fixes).toContain('skin.regions[1].coat → null');
    expect(fixes).toContain('skin.regions[2].coat → soft');
  });
  it('keeps a coat that fits', () => {
    const raw = structuredClone(quadruped) as unknown as { skin: { regions: Record<string, unknown>[] } };
    raw.skin.regions[0].coat = 'shaggy';
    const { recipe, fixes } = normalizeRecipe(raw);
    expect(recipe.skin.regions[0].coat).toBe('shaggy');
    expect(fixes.filter((f) => f.includes('coat'))).toEqual([]);
  });
  it('keeps given hints and clamps numbers', () => {
    const raw = { ...structuredClone(quadruped), build: { muscle: 3, feet: 'hooves' }, face: { ...inferFace(quadruped), brow: -1 } };
    const { recipe } = normalizeRecipe(raw);
    expect(recipe.build).toEqual({ muscle: 1, feet: 'hooves' });
    expect(recipe.face.brow).toBe(0);
  });
  it('is idempotent on every native', () => {
    for (const { recipe } of CAST) expect(normalizeRecipe(recipe).recipe).toEqual(recipe);
  });
  it('leaves room for the jaw: the most bones a recipe can make is MAX_BONES - 1', () => {
    expect(1 + (MAX_PARTS - 1) * 2).toBeLessThanOrEqual(MAX_BONES - 1);
  });
});
