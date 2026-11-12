import { z } from 'zod';
import { normalizeRecipe } from './normalize';
import { PartSchema, type Part, type Recipe } from './schema';

/** Small, targeted changes to a recipe (from "look again" passes and tweaks). */
export const RecipeEditSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('set'),
    path: z.string().describe('Dot path; parts and skin regions by id, e.g. "parts.tail.length", "skin.regions.body.pattern.scale", "motion.bounce"'),
    valueJson: z.string().describe('The new value as JSON, e.g. "0.6", "\\"#ff8800\\"", "true"'),
  }),
  z.object({ op: z.literal('addPart'), part: PartSchema }),
  z.object({ op: z.literal('removePart'), id: z.string() }),
]);
export type RecipeEdit = z.infer<typeof RecipeEditSchema>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;

/** Resolve the container and key a dot path points at; arrays of {id} are addressed by id. */
function locate(root: Obj, path: string): { holder: Obj; key: string } | string {
  const segs = path.split('.').filter(Boolean);
  if (segs.length === 0) return 'empty path';
  let cur: unknown = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (Array.isArray(cur)) {
      cur = cur.find((it) => isObj(it) && it.id === s);
      if (cur === undefined) return `no item "${s}" in ${segs.slice(0, i).join('.')}`;
    } else if (isObj(cur) && s in cur) {
      cur = cur[s];
    } else {
      return `unknown path segment "${s}"`;
    }
  }
  const key = segs[segs.length - 1];
  if (!isObj(cur) || Array.isArray(cur)) return `"${path}" does not point at a field`;
  if (!(key in cur)) return `unknown field "${key}"`;
  return { holder: cur, key };
}

export function applyEdits(recipe: Recipe, edits: RecipeEdit[]): { recipe: Recipe; applied: number; skipped: string[] } {
  const r = structuredClone(recipe) as Recipe;
  const skipped: string[] = [];
  let applied = 0;
  for (const e of edits) {
    if (e.op === 'set') {
      let value: unknown;
      try {
        value = JSON.parse(e.valueJson);
      } catch {
        skipped.push(`set ${e.path}: value is not JSON`);
        continue;
      }
      const at = locate(r as unknown as Obj, e.path);
      if (typeof at === 'string') {
        skipped.push(`set ${e.path}: ${at}`);
        continue;
      }
      at.holder[at.key] = value;
      applied++;
    } else if (e.op === 'addPart') {
      if (r.parts.some((p) => p.id === e.part.id)) {
        skipped.push(`addPart ${e.part.id}: id already used`);
        continue;
      }
      r.parts.push(structuredClone(e.part) as Part);
      applied++;
    } else {
      const target = r.parts.find((p) => p.id === e.id);
      if (!target) {
        skipped.push(`removePart ${e.id}: no such part`);
        continue;
      }
      if (target.parent === null) {
        skipped.push(`removePart ${e.id}: the root part stays`);
        continue;
      }
      const gone = new Set([e.id]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const p of r.parts) if (p.parent && gone.has(p.parent) && !gone.has(p.id)) (gone.add(p.id), (grew = true));
      }
      r.parts = r.parts.filter((p) => !gone.has(p.id));
      applied++;
    }
  }
  return { recipe: normalizeRecipe(r).recipe, applied, skipped };
}
