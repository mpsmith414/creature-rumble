import { inferBuild, inferCoat, inferFace } from '../../src/recipe/hints';
import { DEFAULT_RECIPE, defaultFlatFacing } from '../../src/recipe/normalize';
import type { Part, Recipe, Region, Role } from '../../src/recipe/schema';

type V = [number, number, number];
type Opts = Partial<Pick<Part, 'squash' | 'pointed' | 'mirror' | 'region' | 'flatFacing'>> & { offset?: V };

/** Compact part maker for tests: P(id, parent, role, attach, dir, length, r0, r1, opts). */
export function P(id: string, parent: string | null, role: Role, attach: number, dir: V, length: number, r0: number, r1: number, o: Opts = {}): Part {
  const [ox, oy, oz] = o.offset ?? [0, 0, 0];
  const l = Math.hypot(...dir);
  return {
    id, parent, role, attach,
    offset: { x: ox, y: oy, z: oz },
    dir: { x: dir[0] / l, y: dir[1] / l, z: dir[2] / l },
    length, r0, r1,
    squash: o.squash ?? 1,
    flatFacing: o.flatFacing ?? defaultFlatFacing(role),
    pointed: o.pointed ?? false,
    mirror: o.mirror ?? false,
    region: o.region ?? 'body',
  };
}

export function makeRecipe(id: string, parts: Part[], extra: Partial<Recipe> = {}): Recipe {
  const r = structuredClone({ ...DEFAULT_RECIPE, id, name: id, parts, ...extra });
  return { build: inferBuild(r), face: inferFace(r), ...r } as Recipe;
}

const coated = (r: Omit<Region, 'coat'>): Region => ({ ...r, coat: inferCoat(r) });

const furRegions: Region[] = [
  coated({ id: 'body', covering: 'fur', color: '#9a6b3f', belly: '#e8d8b8', furLength: 0.02, fluff: 0.3, pattern: null }),
  coated({ id: 'tail', covering: 'scales', color: '#4a6a3a', belly: null, furLength: 0, fluff: 0, pattern: { kind: 'spots', color: '#223322', scale: 0.04, amount: 0.5, along: false } }),
];

export const quadruped = makeRecipe('quadruped', [
  P('torso', null, 'torso', 0, [0, 0, 1], 0.6, 0.14, 0.15),
  P('neck', 'torso', 'neck', 1, [0, 0.8, 0.6], 0.22, 0.09, 0.07, { offset: [0, 0.05, 0] }),
  P('head', 'neck', 'head', 1, [0, -0.1, 1], 0.22, 0.08, 0.045),
  P('ear', 'head', 'ear', 0.25, [0.4, 1, -0.3], 0.09, 0.03, 0.015, { squash: 0.2, mirror: true, offset: [0.04, 0.05, 0] }),
  P('eye', 'head', 'eye', 0.55, [1, 0.2, 0.4], 0.015, 0.018, 0.018, { mirror: true, offset: [0.045, 0.03, 0] }),
  P('leg_f', 'torso', 'leg', 0.9, [0.05, -1, 0], 0.24, 0.055, 0.04, { mirror: true, offset: [0.09, -0.06, 0] }),
  P('shin_f', 'leg_f', 'leg', 1, [0, -1, -0.08], 0.22, 0.035, 0.028),
  P('foot_f', 'shin_f', 'foot', 1, [0, -0.2, 1], 0.06, 0.028, 0.025),
  P('leg_b', 'torso', 'leg', 0.08, [0.05, -1, -0.15], 0.26, 0.07, 0.045, { mirror: true, offset: [0.09, -0.05, 0] }),
  P('shin_b', 'leg_b', 'leg', 1, [0, -1, 0.12], 0.24, 0.035, 0.028),
  P('foot_b', 'shin_b', 'foot', 1, [0, -0.2, 1], 0.06, 0.028, 0.025),
  P('tail', 'torso', 'tail', 0, [0, 0.3, -1], 0.35, 0.05, 0.015, { offset: [0, 0.06, 0], region: 'tail' }),
], { skin: { regions: furRegions, eyes: { color: '#c08a20', pupil: 'slit', size: 0.9 } } });

export const snake = makeRecipe('snake', [
  P('body0', null, 'torso', 0, [0, 0, 1], 0.2, 0.035, 0.045),
  ...Array.from({ length: 6 }, (_, i) =>
    P(`body${i + 1}`, `body${i}`, 'torso', 1, [i % 2 ? 0.25 : -0.25, 0, 1], 0.2, 0.045, 0.045)),
  P('head', 'body6', 'head', 1, [0, 0, 1], 0.1, 0.045, 0.03),
], { motion: { gait: 'slither', bounce: 0, sway: 0.8, stance: 'low' } });

export const hexapod = makeRecipe('hexapod', [
  P('torso', null, 'torso', 0, [0, 0, 1], 0.3, 0.06, 0.06),
  ...[0.2, 0.5, 0.8].flatMap((a, i) => [
    P(`leg${i}`, 'torso', 'leg', a, [1, 0.3, 0], 0.12, 0.02, 0.015, { mirror: true, offset: [0.04, 0, 0] }),
    P(`shin${i}`, `leg${i}`, 'leg', 1, [0.4, -1, 0], 0.12, 0.015, 0.008),
  ]),
  P('head', 'torso', 'head', 1, [0, 0, 1], 0.06, 0.05, 0.04),
]);

export const blob = makeRecipe('blob', [P('torso', null, 'torso', 0, [0, 0, 1], 0.05, 0.2, 0.2)]);

export const biped = makeRecipe('biped', [
  P('torso', null, 'torso', 0, [0, 1, 0.1], 0.4, 0.13, 0.11),
  P('head', 'torso', 'head', 1, [0, 1, 0.2], 0.18, 0.09, 0.08),
  P('leg', 'torso', 'leg', 0, [0, -1, 0], 0.25, 0.06, 0.045, { mirror: true, offset: [0.08, 0, 0] }),
  P('shin', 'leg', 'leg', 1, [0, -1, 0], 0.25, 0.04, 0.03),
  P('foot', 'shin', 'foot', 1, [0, -0.1, 1], 0.09, 0.03, 0.025),
]);

export const bird = makeRecipe('bird', [
  P('torso', null, 'torso', 0, [0, 0.2, 1], 0.22, 0.07, 0.08),
  P('neck', 'torso', 'neck', 1, [0, 1, 0.3], 0.07, 0.045, 0.04),
  P('head', 'neck', 'head', 1, [0, 0, 1], 0.07, 0.045, 0.03),
  P('beak', 'head', 'mouth', 1, [0, -0.2, 1], 0.04, 0.015, 0.002, { pointed: true }),
  P('wing', 'torso', 'wing', 0.7, [1, 0.1, -0.3], 0.16, 0.05, 0.04, { squash: 0.15, mirror: true, offset: [0.06, 0.03, 0] }),
  P('wing2', 'wing', 'wing', 1, [1, 0, -0.4], 0.18, 0.04, 0.02, { squash: 0.12 }),
  P('leg', 'torso', 'leg', 0.4, [0, -1, 0.1], 0.08, 0.02, 0.012, { mirror: true, offset: [0.03, -0.05, 0] }),
  P('shin', 'leg', 'leg', 1, [0, -1, -0.1], 0.07, 0.01, 0.008),
  P('foot', 'shin', 'foot', 1, [0, -0.1, 1], 0.04, 0.008, 0.006),
  P('tail', 'torso', 'tail', 0, [0, 0.1, -1], 0.12, 0.04, 0.03, { squash: 0.2 }),
], { motion: { gait: 'fly', bounce: 0.2, sway: 0.3, stance: 'normal' } });

/** A kid's standing creature: upright body and head (its face looks along +z, its crown is the head bone's end), eyes, ears. */
export const upright = makeRecipe('upright', [
  P('torso', null, 'torso', 0, [0, 1, 0.05], 0.34, 0.15, 0.09),
  P('head', 'torso', 'head', 1, [0, 1, 0.05], 0.16, 0.105, 0.1),
  P('eye', 'head', 'eye', 0.9, [0.45, 0.1, 1], 0.02, 0.022, 0.022, { mirror: true, offset: [0.035, 0, 0.07] }),
  P('ear', 'head', 'ear', 0.9, [0.45, 1, -0.15], 0.09, 0.035, 0.015, { squash: 0.25, mirror: true, offset: [0.05, 0.02, -0.01] }),
  P('leg', 'torso', 'leg', 0, [0, -1, 0], 0.22, 0.06, 0.045, { mirror: true, offset: [0.08, 0, 0] }),
  P('shin', 'leg', 'leg', 1, [0, -1, 0], 0.2, 0.04, 0.03),
  P('foot', 'shin', 'foot', 1, [0, -0.1, 1], 0.09, 0.03, 0.025),
], { skin: { regions: furRegions.slice(0, 1), eyes: { color: '#5a3a20', pupil: 'round', size: 1 } } });
