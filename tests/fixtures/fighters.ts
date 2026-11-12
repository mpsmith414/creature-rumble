import blob from '../../src/fixtures/fighters/blob.json';
import fists from '../../src/fixtures/fighters/fists.json';
import horns from '../../src/fixtures/fighters/horns.json';
import legs from '../../src/fixtures/fighters/legs.json';
import tail from '../../src/fixtures/fighters/tail.json';
import tiny from '../../src/fixtures/fighters/tiny.json';
import wings from '../../src/fixtures/fighters/wings.json';
import type { Move } from '../../src/fight/types';
import type { Recipe } from '../../src/recipe/schema';

/** The seven fighter fixtures (one per kind of body in the spec's moves table) and the move each is built for. */
export const KINDS = ['fists', 'legs', 'tiny', 'blob', 'wings', 'tail', 'horns'] as const;
export type Kind = (typeof KINDS)[number];

export const EXPECTED_MOVE: Record<Kind, Move> = {
  fists: 'punch', legs: 'kick', tiny: 'jab', blob: 'bump', wings: 'divebomb', tail: 'spin', horns: 'headbutt',
};

const RAW: Record<Kind, unknown> = { fists, legs, tiny, blob, wings, tail, horns };

/** A fresh copy of a fighter fixture, as stored (JSON imports widen enums to strings, hence the cast). */
export const loadFixture = (k: string): Recipe => structuredClone(RAW[k as Kind]) as Recipe;

/** The recipe without its fight plan, so the heuristic has to choose. */
export const stripFight = (r: Recipe): Recipe => ({ ...r, fight: null });
