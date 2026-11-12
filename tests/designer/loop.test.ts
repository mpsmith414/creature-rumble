import { describe, expect, it } from 'vitest';
import { buildBody } from '../../src/builder/build';
import type { DesignerApi } from '../../src/designer/api';
import { levels } from '../../src/designer/image';
import { designCreature, tweakCreature, type ProgressStep } from '../../src/designer/loop';
import type { LookAgainResult } from '../../src/designer/types';
import type { Recipe } from '../../src/recipe/schema';
import { quadruped } from '../fixtures/recipes';

const cards = { name: 'Bob', eats: 'flowers', speed: 'slow', mood: 'shy', special: 'spots' };
const img = { base64: 'x', mediaType: 'image/png' as const };
const view = { angle: 'side' as const, facing: 'left' as const };
const body = buildBody(quadruped, [2]); // the loop never looks at the shape: one body serves every build

function deps(looks: LookAgainResult[], opts: { failBuildAt?: number } = {}) {
  let builds = 0;
  const api: DesignerApi = {
    read: async () => ({ status: 'ok', recipe: quadruped, checklist: ['4 legs'], view, cards, fixes: [] }),
    lookAgain: async () => looks.shift()!,
    tweak: async () => ({ status: 'ok', edits: [{ op: 'set', path: 'life.sizeM', valueJson: '2' }], cards: { ...cards, name: 'Big Bob' }, note: 'Bigger!' }),
  };
  return {
    api,
    builds: () => builds,
    build: async (r: Recipe) => {
      builds++;
      if (builds === opts.failBuildAt) throw new Error('cannot build');
      return { ...body, key: r.id };
    },
    snapshot: async () => img,
  };
}

const edit = (len: number): LookAgainResult => ({ status: 'ok', verdict: 'edits', edits: [{ op: 'set', path: 'parts.tail.length', valueJson: String(len) }], note: 'Longer tail' });
const matches: LookAgainResult = { status: 'ok', verdict: 'matches', edits: [], note: 'Looks just right!' };

describe('designCreature', () => {
  it('reads, builds, looks again, fixes, and stops when it matches', async () => {
    const steps: string[] = [];
    const d = deps([edit(0.5), matches]);
    const out = await designCreature({ image: img, words: '' }, d, { passes: 3 }, (s: ProgressStep) => steps.push(s.kind + ('pass' in s ? s.pass : '')));
    expect(steps).toEqual(['reading', 'building', 'looking1', 'fixing1', 'building', 'looking2', 'done']);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.recipe.parts.find((p) => p.id === 'tail')!.length).toBe(0.5);
    expect(out.history.map((h) => h.verdict)).toEqual(['edits', 'matches']);
  });

  it('stops after the allowed number of passes', async () => {
    const d = deps([edit(0.5), edit(0.6), edit(0.7), edit(0.8)]);
    const out = await designCreature({ image: img, words: '' }, d, { passes: 2 }, () => {});
    expect(out.status === 'ok' && out.history.length).toBe(2);
  });

  it('returns "no creature" without building anything', async () => {
    const d = deps([]);
    d.api.read = async () => ({ status: 'noCreature', message: 'No creature here!' });
    const out = await designCreature({ image: img, words: '' }, d, { passes: 3 }, () => {});
    expect(out).toEqual({ status: 'noCreature', message: 'No creature here!' });
    expect(d.builds()).toBe(0);
  });

  it('keeps the last good creature when a fix will not build', async () => {
    const d = deps([edit(0.5)], { failBuildAt: 2 });
    const out = await designCreature({ image: img, words: '' }, d, { passes: 3 }, () => {});
    expect(out.status === 'ok' && out.recipe.parts.find((p) => p.id === 'tail')!.length).toBe(quadruped.parts.find((p) => p.id === 'tail')!.length);
  });
});

describe('tweakCreature', () => {
  it('applies the edits and returns new cards', async () => {
    const d = deps([]);
    const out = await tweakCreature(quadruped, cards, 'make it bigger', d);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.recipe.life.sizeM).toBe(2);
    expect(out.cards.name).toBe('Big Bob');
  });
});

describe('levels', () => {
  const px = (vals: number[]) => new Uint8ClampedArray(vals.flatMap((v) => [v, v, v, 255]));

  it('stretches a dull image to the full range', () => {
    const dull = px(Array.from({ length: 400 }, (_, i) => 100 + (i % 51)));
    const out = levels(dull);
    let min = 255, max = 0;
    for (let i = 0; i < out.length; i += 4) (min = Math.min(min, out[i])), (max = Math.max(max, out[i]));
    expect(min).toBeLessThan(10);
    expect(max).toBeGreaterThan(245);
  });

  it('leaves a full-range image alone', () => {
    const full = px(Array.from({ length: 256 }, (_, i) => i));
    expect(levels(full)).toEqual(full);
  });
});
