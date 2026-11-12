import type { BodyData } from '../builder/build';
import { applyEdits } from '../recipe/edits';
import type { Recipe } from '../recipe/schema';
import type { DesignerApi } from './api';
import type { ImageIn, KidCards, ReadRequest, View } from './types';

export type ProgressStep =
  | { kind: 'reading' }
  | { kind: 'building' }
  | { kind: 'looking'; pass: number; render: ImageIn }
  | { kind: 'fixing'; pass: number; note: string }
  | { kind: 'done'; note: string };

export type PassRecord = { pass: number; render: ImageIn; verdict: 'matches' | 'edits'; note: string; edits: number };

export type DesignOutcome =
  | { status: 'ok'; recipe: Recipe; body: BodyData; cards: KidCards; checklist: string[]; view: View; history: PassRecord[] }
  | { status: 'noCreature' | 'declined'; message: string };

export type DesignDeps = {
  api: DesignerApi;
  build(recipe: Recipe): Promise<BodyData>;
  snapshot(body: BodyData, recipe: Recipe, view: View): Promise<ImageIn>;
};

/**
 * Drawing and/or words → a creature: read it, build it, then "look again" up to `passes` times,
 * comparing a picture of the build with the drawing and applying small fixes until it matches.
 * A fix that can't be built is dropped and the last good creature kept.
 */
export async function designCreature(input: ReadRequest, deps: DesignDeps, opts: { passes: number }, onProgress: (s: ProgressStep) => void): Promise<DesignOutcome> {
  onProgress({ kind: 'reading' });
  const read = await deps.api.read(input);
  if (read.status !== 'ok') return read;
  let recipe = read.recipe;
  onProgress({ kind: 'building' });
  let body = await deps.build(recipe);
  const history: PassRecord[] = [];
  let lastNote = 'Ta-da!';
  for (let pass = 1; pass <= opts.passes; pass++) {
    const render = await deps.snapshot(body, recipe, read.view);
    onProgress({ kind: 'looking', pass, render });
    const look = await deps.api.lookAgain({ ...input, render, recipe, checklist: read.checklist, pass });
    const edits = look.verdict === 'edits' ? look.edits : [];
    history.push({ pass, render, verdict: edits.length ? 'edits' : 'matches', note: look.note, edits: edits.length });
    lastNote = look.note || lastNote;
    if (!edits.length) break;
    onProgress({ kind: 'fixing', pass, note: look.note });
    const next = applyEdits(recipe, edits).recipe;
    try {
      onProgress({ kind: 'building' });
      body = await deps.build(next);
      recipe = next;
    } catch {
      break; // keep the last creature that built
    }
  }
  onProgress({ kind: 'done', note: lastNote });
  return { status: 'ok', recipe, body, cards: read.cards, checklist: read.checklist, view: read.view, history };
}

/** "Make it bigger": words → small edits → rebuilt creature with updated cards. */
export async function tweakCreature(recipe: Recipe, cards: KidCards, words: string, deps: Pick<DesignDeps, 'api' | 'build'>) {
  const res = await deps.api.tweak({ recipe, cards, words });
  if (res.status !== 'ok') return { status: 'declined' as const, message: res.message };
  const next = applyEdits(recipe, res.edits).recipe;
  const body = await deps.build(next);
  return { status: 'ok' as const, recipe: next, body, cards: res.cards, note: res.note };
}
