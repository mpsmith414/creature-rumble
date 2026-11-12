import { describe, expect, it, test } from 'vitest';
import { buildSkeleton } from '../../src/builder/skeleton';
import { chooseMove, planFor } from '../../src/fight/moves';
import { RecipeSchema } from '../../src/recipe/schema';
import { EXPECTED_MOVE, KINDS, loadFixture, stripFight } from '../fixtures/fighters';

describe('fighter fixtures', () => {
  test.each(KINDS)('fixture %s is valid and keeps its move', (k) => {
    const r = loadFixture(k);
    expect(RecipeSchema.safeParse(r).success).toBe(true);
    expect(r.fight?.move).toBe(EXPECTED_MOVE[k]); // authored move
    expect(chooseMove(buildSkeleton(stripFight(r)))).toBe(EXPECTED_MOVE[k]); // heuristic agrees with the authored move
  });
});

describe('planFor', () => {
  it("uses the recipe's own fight plan when it has one", () => {
    const r = loadFixture('legs');
    expect(planFor(r, buildSkeleton(r))).toEqual(r.fight);
  });

  it('falls back to the heuristic and default words without one', () => {
    const r = stripFight(loadFixture('fists'));
    r.name = 'Bonk';
    r.life.massKg = 50;
    const plan = planFor(r, buildSkeleton(r));
    expect(plan.move).toBe('punch');
    expect(plan.weapons.length).toBeGreaterThan(0);
    for (const w of plan.weapons) expect(r.parts.find((p) => p.id === w)?.role).toBe('hand');
    expect(plan.weight).toBe('a hefty fifty pounds');
    expect(plan.intro).toBe("From the bedroom of {maker}! Weighing in at a hefty fifty pounds! It's... BONK!");
  });

  it('falls back when the plan names no weapons', () => {
    const r = loadFixture('legs');
    r.fight = { ...r.fight!, move: 'spin', weapons: [] };
    const plan = planFor(r, buildSkeleton(r));
    expect(plan.move).toBe('kick');
    for (const w of plan.weapons) expect(r.parts.find((p) => p.id === w)?.role).toBe('foot');
  });

  it('fills blank words in an authored plan', () => {
    const r = loadFixture('tiny');
    r.fight = { ...r.fight!, weight: '', intro: ' ' };
    const plan = planFor(r, buildSkeleton(r));
    expect(plan.move).toBe('jab');
    expect(plan.weight).toBe('one teeny tiny pound');
    expect(plan.intro).toContain(r.name.toUpperCase());
  });

  it('weighs by mass', () => {
    const r = stripFight(loadFixture('blob'));
    const weight = (kg: number) => planFor({ ...r, life: { ...r.life, massKg: kg } }, buildSkeleton(r)).weight;
    expect(weight(1)).toBe('one teeny tiny pound');
    expect(weight(10)).toBe('a wobbly thirty pounds');
    expect(weight(100)).toBe('a hefty fifty pounds');
    expect(weight(500)).toBe('a HUMONGOUS ton');
  });

  it('gives each move its weapon', () => {
    const sk = (k: string) => buildSkeleton(stripFight(loadFixture(k)));
    const roles = (k: string) => {
      const r = stripFight(loadFixture(k));
      return planFor(r, sk(k)).weapons.map((w) => r.parts.find((p) => p.id === w)!.role);
    };
    expect(new Set(roles('tiny'))).toEqual(new Set(['hand']));
    expect(new Set(roles('legs'))).toEqual(new Set(['foot']));
    expect(roles('horns')).toEqual(['head']);
    expect(roles('wings')).toEqual(['head']);
    expect(roles('blob')).toEqual(['torso']);
    expect(roles('tail')).toEqual(['tail']);
    // the spin's weapon is the tail's tip: no tail part grows from it
    const t = stripFight(loadFixture('tail'));
    const tip = planFor(t, sk('tail')).weapons[0];
    expect(t.parts.some((p) => p.parent === tip && p.role === 'tail')).toBe(false);
  });
});
