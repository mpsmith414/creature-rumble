import type { MOVES } from '../recipe/schema';

/**
 * The fight plan's shape. It is part of the recipe, so it is defined with the recipe in src/recipe/schema.ts (the
 * body cache key hashes src/recipe, and recipe code may only import what that key covers); fight code imports it from here.
 */
export { FightPlanSchema, MOVES, type FightPlan } from '../recipe/schema';
export type Move = (typeof MOVES)[number];
