/**
 * Copies the valley's cast recipes (tests/fixtures/cast) to src/fixtures/cast/<id>.json for the `?dev=cast` page: src may
 * not import tests (ruling R3). tests/recipe/cast-copy.test.ts fails when the copy is stale.
 * Run: npx tsx tools/cast-fixtures.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { CAST } from '../tests/fixtures/cast';

const DIR = 'src/fixtures/cast';
mkdirSync(DIR, { recursive: true });
for (const { recipe } of CAST) {
  writeFileSync(`${DIR}/${recipe.id}.json`, `${JSON.stringify(recipe, null, 2)}\n`);
  console.log(`${DIR}/${recipe.id}.json`);
}
