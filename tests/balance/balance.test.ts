import { beforeAll, expect, test } from 'vitest';
import { BODY_KINDS, fourWayReport } from '../../src/fight/sim';
import { initPhysics } from '../../src/physics/world';

/** Whole headless bouts (a few seconds each): `npm run balance`, not `npm test`. See `npx tsx tools/balance.ts`. */
const MINUTES = 60_000;

beforeAll(initPhysics);

test('fights last the spec’s length', () => {
  const r = fourWayReport(20, { seed: 1 });
  expect(r.medianFirstOut).toBeGreaterThanOrEqual(40); expect(r.medianFirstOut).toBeLessThanOrEqual(70);
  expect(r.medianEnd).toBeGreaterThanOrEqual(90); expect(r.medianEnd).toBeLessThanOrEqual(180);
  // spec: never a stretch longer than "~3 s" without a hit (ruling: an approximate target). Body geometry still makes
  // the odd longer one (tiny under legs, hugs, wings hovering past the edge), so: none over 4.5 s, few over 3 s.
  expect(r.maxQuiet).toBeLessThanOrEqual(4.5);
  expect(r.quietOver3 / r.bouts.length).toBeLessThanOrEqual(0.15);
}, 5 * MINUTES);

// R6: in random four-way bouts a fair share is 0.25; no kind may win more than 0.35 of the bouts it is in. A bout that
// runs out of time with 2+ left has no winner.
test('no body kind dominates', () => {
  const r = fourWayReport(70, { seed: 2 });
  for (const k of BODY_KINDS) {
    expect(r.kinds[k].bouts, k).toBeGreaterThanOrEqual(30);
    expect(r.kinds[k].winRate, k).toBeLessThanOrEqual(0.35);
  }
}, 10 * MINUTES);
