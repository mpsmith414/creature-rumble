import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAST } from '../fixtures/cast';

/**
 * The `?dev=cast` page shows the valley's cast as fighters. Its recipes live in tests/ (the builder's tests hold the
 * body builder to them) and src may not import tests (ruling R3), so the page reads a copy in src/fixtures/cast/.
 * Remake it with `npx tsx tools/cast-fixtures.ts` whenever the cast changes.
 */
describe('the dev copy of the valley cast', () => {
  const DIR = 'src/fixtures/cast';
  it('has one JSON recipe per cast member, equal to the cast in tests/fixtures/cast', () => {
    expect(readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()).toEqual(CAST.map((c) => `${c.recipe.id}.json`).sort());
    for (const { recipe } of CAST) expect(JSON.parse(readFileSync(`${DIR}/${recipe.id}.json`, 'utf8')), recipe.id).toEqual(recipe);
  });
});
