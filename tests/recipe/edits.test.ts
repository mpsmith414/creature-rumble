import { describe, expect, it } from 'vitest';
import { applyEdits } from '../../src/recipe/edits';
import { P, quadruped } from '../fixtures/recipes';

describe('applyEdits', () => {
  it('sets a part field by id and nothing else', () => {
    const { recipe, applied } = applyEdits(quadruped, [{ op: 'set', path: 'parts.tail.length', valueJson: '0.6' }]);
    expect(applied).toBe(1);
    expect(recipe.parts.find((p) => p.id === 'tail')!.length).toBe(0.6);
    expect({ ...recipe, parts: recipe.parts.filter((p) => p.id !== 'tail') })
      .toEqual({ ...quadruped, parts: quadruped.parts.filter((p) => p.id !== 'tail') });
  });

  it('sets nested region fields', () => {
    const { recipe } = applyEdits(quadruped, [{ op: 'set', path: 'skin.regions.tail.pattern.scale', valueJson: '0.1' }]);
    expect(recipe.skin.regions.find((r) => r.id === 'tail')!.pattern!.scale).toBe(0.1);
  });

  it('clamps through normalise', () => {
    expect(applyEdits(quadruped, [{ op: 'set', path: 'motion.bounce', valueJson: '2' }]).recipe.motion.bounce).toBe(1);
  });

  it('adds and removes parts (with descendants)', () => {
    const horn = P('horn', 'head', 'horn', 0.3, [0, 1, 0.2], 0.08, 0.015, 0.002, { pointed: true });
    const added = applyEdits(quadruped, [{ op: 'addPart', part: horn }]);
    expect(added.recipe.parts.some((p) => p.id === 'horn')).toBe(true);
    const removed = applyEdits(quadruped, [{ op: 'removePart', id: 'neck' }]).recipe.parts.map((p) => p.id);
    expect(removed).not.toContain('neck');
    expect(removed).not.toContain('head');
    expect(removed).not.toContain('ear');
  });

  it('skips bad edits with a reason', () => {
    const { applied, skipped } = applyEdits(quadruped, [
      { op: 'removePart', id: 'torso' },
      { op: 'set', path: 'parts.wing.length', valueJson: '1' },
      { op: 'set', path: 'motion.bounce', valueJson: 'lots' },
      { op: 'set', path: 'motion.nope', valueJson: '1' },
      { op: 'addPart', part: P('tail', 'torso', 'tail', 0, [0, 0, -1], 0.1, 0.02, 0.01) },
      { op: 'set', path: 'life.sizeM', valueJson: '0.8' },
    ]);
    expect(applied).toBe(1);
    expect(skipped).toHaveLength(5);
  });

  it('never mutates the input', () => {
    const before = structuredClone(quadruped);
    applyEdits(quadruped, [{ op: 'set', path: 'parts.tail.length', valueJson: '0.6' }, { op: 'removePart', id: 'neck' }]);
    expect(quadruped).toEqual(before);
  });
});
