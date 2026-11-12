import { describe, expect, it } from 'vitest';
import { FEATHER_LENGTH, inferRole, normalizeRecipe, RecipeError } from '../../src/recipe/normalize';
import { MAX_BONES, MAX_PARTS, SCHEMA_VERSION, type Recipe, type Role } from '../../src/recipe/schema';
import { P, makeRecipe, quadruped } from '../fixtures/recipes';

const clone = <T>(v: T): T => structuredClone(v);

describe('normalizeRecipe', () => {
  it('passes a clean recipe through unchanged', () => {
    const { recipe, fixes } = normalizeRecipe(clone(quadruped));
    expect(fixes).toEqual([]);
    expect(recipe).toEqual(quadruped);
  });

  it('clamps numbers with a fix', () => {
    const r = clone(quadruped);
    r.parts[1].length = 99;
    const { recipe, fixes } = normalizeRecipe(r);
    expect(recipe.parts[1].length).toBe(6);
    expect(fixes.some((f) => f.includes('length'))).toBe(true);
  });

  it('turns a zero direction forward', () => {
    const r = clone(quadruped);
    r.parts[2].dir = { x: 0, y: 0, z: 0 };
    expect(normalizeRecipe(r).recipe.parts[2].dir).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('keeps one root and re-attaches unknown parents', () => {
    const r = makeRecipe('t', [
      P('a', null, 'torso', 0, [0, 0, 1], 0.3, 0.1, 0.1),
      P('b', null, 'head', 1, [0, 0, 1], 0.1, 0.05, 0.05),
      P('c', 'nope', 'tail', 0, [0, 0, -1], 0.1, 0.03, 0.01),
    ]);
    const { recipe } = normalizeRecipe(r);
    expect(recipe.parts.filter((p) => p.parent === null).map((p) => p.id)).toEqual(['a']);
    expect(recipe.parts.find((p) => p.id === 'b')!.parent).toBe('a');
    expect(recipe.parts.find((p) => p.id === 'c')!.parent).toBe('a');
  });

  it('breaks cycles', () => {
    const r = makeRecipe('t', [
      P('root', null, 'torso', 0, [0, 0, 1], 0.3, 0.1, 0.1),
      P('a', 'b', 'leg', 1, [0, -1, 0], 0.1, 0.03, 0.03),
      P('b', 'a', 'leg', 1, [0, -1, 0], 0.1, 0.03, 0.03),
    ]);
    const { recipe, fixes } = normalizeRecipe(r);
    expect(fixes.some((f) => f.startsWith('cycle'))).toBe(true);
    // every part reaches the root, parents come first
    const seen = new Set<string>();
    for (const p of recipe.parts) {
      if (p.parent !== null) expect(seen.has(p.parent)).toBe(true);
      seen.add(p.id);
    }
  });

  it('renames duplicate ids', () => {
    const r = makeRecipe('t', [
      P('a', null, 'torso', 0, [0, 0, 1], 0.3, 0.1, 0.1),
      P('x', 'a', 'leg', 1, [0, -1, 0], 0.1, 0.03, 0.03),
      P('x', 'a', 'leg', 0, [0, -1, 0], 0.1, 0.03, 0.03),
    ]);
    expect(normalizeRecipe(r).recipe.parts.map((p) => p.id)).toEqual(['a', 'x', 'x_2']);
  });

  it('caps the part count', () => {
    const parts = [P('root', null, 'torso', 0, [0, 0, 1], 0.3, 0.1, 0.1),
      ...Array.from({ length: 59 }, (_, i) => P(`p${i}`, 'root', 'other', 0.5, [0, 1, 0], 0.05, 0.01, 0.01))];
    expect(normalizeRecipe(makeRecipe('t', parts)).recipe.parts).toHaveLength(MAX_PARTS);
  });

  it('caps bones after mirroring', () => {
    const parts = [P('root', null, 'torso', 0, [0, 0, 1], 0.3, 0.1, 0.1),
      ...Array.from({ length: 40 }, (_, i) => P(`p${i}`, 'root', 'leg', 0.5, [1, -1, 0], 0.05, 0.01, 0.01, { mirror: true }))];
    const { recipe } = normalizeRecipe(makeRecipe('t', parts));
    const bones = recipe.parts.reduce((n, p) => n + (p.mirror ? 2 : 1), 0);
    expect(bones).toBeLessThanOrEqual(MAX_BONES);
    expect(recipe.parts.length).toBeGreaterThan(40); // nothing cut: 1 + 2×40 = 81 bones fit
  });

  it('cuts bones when mirrors overflow', () => {
    const parts = [P('root', null, 'torso', 0, [0, 0, 1], 0.3, 0.1, 0.1),
      ...Array.from({ length: 47 }, (_, i) => P(`p${i}`, 'root', 'leg', 0.5, [1, -1, 0], 0.05, 0.01, 0.01, { mirror: true }))];
    const { recipe } = normalizeRecipe(makeRecipe('t', parts));
    expect(recipe.parts.reduce((n, p) => n + (p.mirror ? 2 : 1), 0)).toBeLessThanOrEqual(MAX_BONES);
  });

  it('keeps a bone free for the jaw the builder adds (the root counts once, however it is marked)', () => {
    const parts = [P('root', null, 'torso', 0, [0, 0, 1], 0.3, 0.1, 0.1, { mirror: true }),
      ...Array.from({ length: MAX_PARTS - 1 }, (_, i) => P(`p${i}`, 'root', 'leg', 0.5, [1, -1, 0], 0.05, 0.01, 0.01, { mirror: true }))];
    const { recipe } = normalizeRecipe(makeRecipe('t', parts));
    expect(recipe.parts).toHaveLength(MAX_PARTS); // 1 + 2 × 47 = 95 bones: nothing cut
  });

  it('fixes region references and bad colours', () => {
    const r = clone(quadruped);
    r.parts[0].region = 'missing';
    r.skin.regions[0].color = 'orange';
    const { recipe } = normalizeRecipe(r);
    expect(recipe.parts[0].region).toBe('body');
    expect(recipe.skin.regions[0].color).toBe('#8a7a66');
  });

  it('gives feathers without a length a default one, and reports it', () => {
    const r = clone(quadruped) as unknown as { skin: { regions: Record<string, unknown>[] } };
    const base = r.skin.regions[0];
    r.skin.regions = [
      { ...base, id: 'zero', covering: 'feathers', furLength: 0, fluff: 0.1, coat: 'smooth' },
      { ...base, id: 'none', covering: 'feathers', furLength: undefined, fluff: 0.8, coat: 'downy' },
      { ...base, id: 'given', covering: 'feathers', furLength: 0.03, coat: 'smooth' },
      { ...base, id: 'scaly', covering: 'scales', furLength: 0, coat: null },
      { ...base, id: 'bare', covering: 'skin', furLength: 0, coat: null },
    ];
    const { recipe, fixes } = normalizeRecipe(r);
    expect(recipe.skin.regions.map((x) => x.furLength)).toEqual([FEATHER_LENGTH, FEATHER_LENGTH, 0.03, 0, 0]);
    expect(FEATHER_LENGTH).toBe(0.02);
    expect(fixes).toContain('region zero furLength 0 → 0.02 (feathers need a length)');
    expect(fixes).toContain('region none furLength missing → 0.02');
    expect(fixes.filter((f) => /region (given|scaly|bare) furLength/.test(f))).toEqual([]);
  });

  it('fills missing sections from defaults', () => {
    const { recipe, fixes } = normalizeRecipe({ parts: [{ id: 'blob', role: 'torso', length: 0.1, r0: 0.2, r1: 0.2 }] });
    expect(recipe.parts[0].parent).toBeNull();
    expect(recipe.skin.regions[0].id).toBe('body');
    expect(fixes.length).toBeGreaterThan(0);
  });

  it('rejects no input and no parts', () => {
    expect(() => normalizeRecipe(null)).toThrow(RecipeError);
    expect(() => normalizeRecipe({ parts: [] })).toThrow(RecipeError);
  });
});

describe('inferRole', () => {
  it('guesses a missing role from the part id', async () => {
    const { inferRole } = await import('../../src/recipe/normalize');
    expect(inferRole('leg2_low')).toBe('leg');
    expect(inferRole('leg1_foot')).toBe('foot');
    expect(inferRole('ear1')).toBe('ear');
    expect(inferRole('eye_left')).toBe('eye');
    expect(inferRole('nose')).toBe('mouth');
    expect(inferRole('chest')).toBe('torso');
    expect(inferRole('sparkle')).toBe('other');
  });

  it('fills a missing role with a fix note', () => {
    const r = clone(quadruped) as unknown as { parts: Record<string, unknown>[] };
    delete r.parts[6].role; // shin_f
    const { recipe, fixes } = normalizeRecipe(r);
    expect(recipe.parts[6].role).toBe('leg');
    expect(fixes.some((f) => f.includes('role missing'))).toBe(true);
  });
});

describe('fighter parts and the fight plan', () => {
  const base = makeRecipe('fighter', [P('torso', null, 'torso', 0, [0, 1, 0], 0.4, 0.15, 0.13)]);
  type Extra = { id: string; role: Role; parent?: string };
  const withPart = (r: Recipe, ...extra: Extra[]): Recipe => ({
    ...clone(r),
    parts: [...r.parts, ...extra.map((e) => P(e.id, e.parent ?? 'torso', e.role, 0.85, [0.4, -1, 0], 0.15, 0.04, 0.035, { mirror: !e.parent }))],
  });

  it('arm and hand roles survive normalisation', () => {
    const { recipe } = normalizeRecipe(withPart(base, { id: 'arm_left', role: 'arm' }, { id: 'fist', role: 'hand', parent: 'arm_left' }));
    expect(recipe.parts.find((p) => p.id === 'arm_left')!.role).toBe('arm');
    expect(recipe.parts.find((p) => p.id === 'fist')!.role).toBe('hand');
    expect(inferRole('big_fist')).toBe('hand');
  });

  it('infers arms and hands from part ids (no longer legs)', () => {
    expect(inferRole('arm_left')).toBe('arm');
    expect(inferRole('forearm')).toBe('arm');
    expect(inferRole('hand_r')).toBe('hand');
    expect(inferRole('paw-hand')).toBe('hand');
    expect(inferRole('claw-hand')).toBe('hand');
    expect(inferRole('front_paw')).toBe('foot');
  });

  it('fight weapons that name no part are dropped', () => {
    const r = withPart(base, { id: 'arm', role: 'arm' }, { id: 'fist', role: 'hand', parent: 'arm' });
    r.fight = { move: 'punch', weapons: ['fist', 'ghost'], weight: 'a wobbly thirty pounds', intro: 'Here it comes!' };
    const { recipe, fixes } = normalizeRecipe(r);
    expect(recipe.fight).toEqual({ ...r.fight, weapons: ['fist'] });
    expect(fixes.some((f) => f.includes('ghost'))).toBe(true);
  });

  it('keeps a clean fight plan without fixes', () => {
    const r = withPart(base, { id: 'arm', role: 'arm' }, { id: 'fist', role: 'hand', parent: 'arm' });
    r.fight = { move: 'jab', weapons: ['fist'], weight: 'one teeny tiny pound', intro: 'Tiny!' };
    const { recipe, fixes } = normalizeRecipe(r);
    expect(fixes).toEqual([]);
    expect(recipe).toEqual(r);
  });

  it('drops an unreadable fight plan', () => {
    const r = clone(base) as unknown as Record<string, unknown>;
    r.fight = { move: 'tickle', weapons: ['torso'], weight: 'x', intro: 'y' };
    const { recipe, fixes } = normalizeRecipe(r);
    expect(recipe.fight).toBeNull();
    expect(fixes.some((f) => f.startsWith('fight'))).toBe(true);
  });

  it('upgrades a v3 recipe to v4 with no fight plan', () => {
    const v3 = clone(quadruped) as unknown as Record<string, unknown>;
    delete v3.fight;
    v3.schemaVersion = 3;
    const { recipe, fixes } = normalizeRecipe(v3);
    expect(recipe.schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(4);
    expect(recipe.fight).toBeNull();
    expect(fixes).toEqual([]);
  });
});
