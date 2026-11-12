import { describe, expect, it } from 'vitest';
import { buildBody } from '../../src/builder/build';
import { thinAxis } from '../../src/builder/sdf';
import { buildSkeleton, type BoneDef } from '../../src/builder/skeleton';
import { ensureFighter } from '../../src/recipe/fighter';
import type { Recipe } from '../../src/recipe/schema';
import { fox } from '../fixtures/cast/fox';
import { trout } from '../fixtures/cast/trout';
import { KINDS, loadFixture } from '../fixtures/fighters';
import { hexapod, snake } from '../fixtures/recipes';

const snakeRecipe = (): Recipe => structuredClone(snake);
const rootDir = (r: Recipe) => r.parts.find((p) => p.parent === null)!.dir;
/** A bone's lowest surface point as the builder shapes it: end balls, squashed along the thin axis. */
const lowest = (b: BoneDef) => {
  const t = thinAxis(b), k = Math.sqrt(1 - (1 - b.squash ** 2) * t.y ** 2);
  return Math.min(b.start.y - b.r0 * k, b.end.y - b.r1 * k);
};

describe('ensureFighter', () => {
  it('ensureFighter adds arms and stance to a legless recipe', () => {
    const { recipe, fixes } = ensureFighter(snakeRecipe());
    expect(recipe.parts.filter((p) => p.role === 'arm')).toHaveLength(1); // mirrored → two bones
    expect(buildSkeleton(recipe).bones.filter((b) => b.role === 'hand')).toHaveLength(2);
    expect(rootDir(recipe).y).toBeGreaterThan(0.7);
    expect(fixes.length).toBeGreaterThan(0);
  });

  it('hangs the arms from the upper body, clear of the ground', () => {
    const sk = buildSkeleton(ensureFighter(snakeRecipe()).recipe);
    const height = sk.max.y - sk.min.y;
    for (const b of sk.bones.filter((x) => x.role === 'arm' || x.role === 'hand')) {
      expect(Math.min(b.start.y - b.r0, b.end.y - b.r1)).toBeGreaterThan(0.4 * height);
    }
  });

  it('stands a stood-up quadruped on its lowest point, not sunk below the floor', () => {
    const sk = buildSkeleton(ensureFighter(structuredClone(fox)).recipe);
    const low = Math.min(...sk.bones.map(lowest));
    expect(low).toBeGreaterThanOrEqual(-0.01);
    expect(low).toBeLessThanOrEqual(0.01);
  });

  it.each([['fox', () => structuredClone(fox)], ['snake', snakeRecipe]] as const)('turns a stood-up %s head back to face forward (+z)', (_, make) => {
    const { recipe } = ensureFighter(make());
    expect(rootDir(recipe).y).toBeGreaterThan(0.7); // the body still stands
    const sk = buildSkeleton(recipe);
    for (const b of sk.bones.filter((x) => x.role === 'head' || (x.role === 'mouth' && !x.jaw))) {
      const d = { y: b.end.y - b.start.y, z: b.end.z - b.start.z };
      expect(d.z).toBeGreaterThan(Math.abs(d.y));
    }
    // the eyes ride along: in front of the head's start, not above or behind it
    const head = sk.bones.find((x) => x.role === 'head')!;
    for (const e of sk.bones.filter((x) => x.role === 'eye')) expect(e.start.z).toBeGreaterThan(head.start.z);
  });

  it("sizes a stood-up snake's arms from its whole torso chain", () => {
    const { recipe } = ensureFighter(snakeRecipe());
    const arm = recipe.parts.find((p) => p.role === 'arm')!;
    expect(arm.length).toBeGreaterThanOrEqual(0.25); // 0.35 × the 1.4 m body chain, not × its 0.2 m top segment
  });

  it.each([['hexapod', () => structuredClone(hexapod)], ['fox', () => structuredClone(fox)], ['snake', snakeRecipe]] as const)(
    'a stood-up %s still stands on its legs (or tail), with any converted arms well above them', (_, make) => {
      const input = make();
      const hadLegs = input.parts.some((p) => p.role === 'leg' || p.role === 'foot');
      const sk = buildSkeleton(ensureFighter(input).recipe);
      const height = sk.max.y - sk.min.y;
      // the body itself may rest on the floor (a short-legged hexapod, a legless snake's coil is its tail end): what matters is that no arm, hand or head is lower than the legs/tail
      const lowBone = sk.bones.filter((b) => !hadLegs || b.role !== 'torso').reduce((a, b) => (lowest(b) < lowest(a) ? b : a));
      expect(hadLegs ? ['leg', 'foot'] : ['torso', 'tail']).toContain(lowBone.role);
      const legs = sk.bones.filter((b) => b.role === 'leg' || b.role === 'foot');
      const arms = sk.bones.filter((b) => b.role === 'arm' || b.role === 'hand');
      if (legs.length && arms.length) {
        expect(Math.min(...arms.map(lowest))).toBeGreaterThanOrEqual(Math.min(...legs.map(lowest)) + 0.1 * height);
      }
    });

  it('leaves a fighter that already stands and has arms alone', () => {
    const r = loadFixture('fists');
    const { recipe, fixes } = ensureFighter(r);
    expect(fixes).toEqual([]);
    expect(recipe).toEqual(r);
  });
});

describe('ensureFighter stands a long creature up without squashing it (it keeps its shape)', () => {
  const part = (r: Recipe, id: string) => r.parts.find((p) => p.id === id)!;
  const dotDir = (a: Recipe['parts'][number]['dir'], b: Recipe['parts'][number]['dir']) => a.x * b.x + a.y * b.y + a.z * b.z;
  const stood = () => ensureFighter(structuredClone(fox));

  it('only the torso rears up: the neck keeps its direction as drawn', () => {
    const { recipe } = stood();
    expect(rootDir(recipe).y).toBeGreaterThan(0.99);
    expect(dotDir(part(recipe, 'neck').dir, part(fox, 'neck').dir)).toBeGreaterThan(0.99);
  });

  it('keeps the tail reaching back behind it, not hanging down to stand on', () => {
    const { recipe } = stood();
    for (const id of ['tail1', 'tail2', 'tail3']) {
      const d = part(recipe, id).dir;
      expect(d.z).toBeLessThan(0);
      expect(-d.z).toBeGreaterThan(Math.abs(d.y));
      expect(dotDir(d, part(fox, id).dir)).toBeGreaterThan(0.99);
    }
  });

  it('stands on its back legs: they reach down, and its lowest point is a hind foot', () => {
    const { recipe } = stood();
    for (const id of ['thigh', 'shin', 'meta']) expect(part(recipe, id).role).toBe('leg');
    expect(part(recipe, 'paw_h').role).toBe('foot');
    expect(dotDir(part(recipe, 'shin').dir, part(fox, 'shin').dir)).toBeGreaterThan(0.99);
    const sk = buildSkeleton(recipe);
    const low = sk.bones.reduce((a, b) => (lowest(b) < lowest(a) ? b : a));
    expect(['thigh', 'shin', 'meta', 'paw_h']).toContain(low.partId);
  });

  it('its front legs become its two arms with fists (no stubby arms added)', () => {
    const { recipe, fixes } = stood();
    expect(part(recipe, 'arm').role).toBe('arm');
    expect(part(recipe, 'fore').role).toBe('arm');
    expect(part(recipe, 'paw_f').role).toBe('hand');
    expect(recipe.parts.filter((p) => p.role === 'arm').map((p) => p.id).sort()).toEqual(['arm', 'fore']);
    expect(fixes.some((f) => /front legs .*arms/.test(f))).toBe(true);
    const sk = buildSkeleton(recipe);
    expect(sk.bones.filter((b) => b.role === 'hand')).toHaveLength(2);
    // the arms hang from the upper body, out at its sides
    const height = sk.max.y - sk.min.y;
    for (const b of sk.bones.filter((x) => x.partId === 'arm')) {
      expect(b.start.y).toBeGreaterThan(0.5 * height + sk.min.y);
      expect(Math.abs(b.end.x)).toBeGreaterThan(Math.abs(b.start.x));
    }
  });

  it('is not a tall stack: the tail and neck still reach back and forward', () => {
    const sk = buildSkeleton(stood().recipe);
    expect(sk.max.z - sk.min.z).toBeGreaterThan(0.6 * (sk.max.y - sk.min.y));
  });

  it('a six-legged creature stands on its back pair, the other four legs become arms', () => {
    const { recipe } = ensureFighter(structuredClone(hexapod));
    expect(part(recipe, 'leg0').role).toBe('leg');
    expect(part(recipe, 'shin0').role).toBe('leg');
    for (const id of ['leg1', 'shin1', 'leg2', 'shin2']) expect(part(recipe, id).role).toBe('arm');
    const sk = buildSkeleton(recipe);
    expect(sk.bones.filter((b) => b.role === 'hand')).toHaveLength(4);
    expect(sk.bones.filter((b) => b.role === 'arm').length).toBeGreaterThanOrEqual(4);
  });

  it('a creature with no legs (a fish) still stands on its tail, as the spec says', () => {
    const { recipe } = ensureFighter(structuredClone(trout));
    expect(rootDir(recipe).y).toBeGreaterThan(0.99);
    expect(part(recipe, 'tail').dir.y).toBeLessThan(-0.7);
  });
});

describe('fighter fixtures', () => {
  it('every fixture builds a body', () => {
    for (const k of KINDS) expect(buildBody(loadFixture(k), [0]).lods[0].positions.length).toBeGreaterThan(0);
  }, 60_000); // seven bodies sampled finely: about a second each, more when every test file runs at once

  it.each(KINDS)('fixture %s already stands upright with arms', (k) => {
    expect(ensureFighter(loadFixture(k)).fixes).toEqual([]);
  });
});
