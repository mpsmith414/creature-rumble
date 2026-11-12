import type { Build, Recipe } from '../../recipe/schema';
import { v3, type Vec3 } from '../../util/vec';
import type { Skeleton } from '../skeleton';
import { bodyFeatures, slimLowerLegs } from './body';
import { faceFeatures, mouthFrame, type MouthFrame } from './face';
import { footFeatures } from './feet';
import type { Feature } from './shapes';

/** How fine the body is meshed: features smaller than about two cells are skipped. */
export type Detail = { cell: number };

/** The anatomy layer: extra shapes blended into the bones' SDF, and a radius scale per bone. */
export type Anatomy = { features: Feature[]; slim: Float32Array /* per bone radius scale */; feet?: Build['feet'] /* how feet blend into the leg (hooves are tighter) */; mouth: MouthFrame | null /* where the mouth opens (the jaw hangs on it) */ };

/** Anatomy for a skeleton from its recipe's build and face hints (and its diet: the mouth's length). Pure and deterministic. */
export function anatomy(sk: Skeleton, recipe: Pick<Recipe, 'build' | 'face' | 'skin' | 'mind'>, detail: Detail): Anatomy {
  const mouth = mouthFrame(sk, recipe, detail);
  return {
    features: [...bodyFeatures(sk, recipe.build, detail), ...footFeatures(sk, recipe.build, detail), ...faceFeatures(sk, recipe, detail, mouth)],
    slim: slimLowerLegs(sk, recipe.build), feet: recipe.build.feet, mouth,
  };
}

/** The body's bounds: the skeleton's, grown to hold every add feature's reach box (a haunch can stick out past the bones). */
export function anatomyBounds(sk: Skeleton, anat: Anatomy): { min: Vec3; max: Vec3 } {
  const min = v3(sk.min.x, sk.min.y, sk.min.z), max = v3(sk.max.x, sk.max.y, sk.max.z);
  for (const f of anat.features) {
    if (f.op !== 'add') continue;
    min.x = Math.min(min.x, f.min.x); min.y = Math.min(min.y, f.min.y); min.z = Math.min(min.z, f.min.z);
    max.x = Math.max(max.x, f.max.x); max.y = Math.max(max.y, f.max.y); max.z = Math.max(max.z, f.max.z);
  }
  return { min, max };
}
