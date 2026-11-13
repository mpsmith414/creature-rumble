import { beforeAll, expect, test } from 'vitest';
import { BODY_KINDS, HIGH_LAUNCH, fourWayReport, type FourWayReport } from '../../src/fight/sim';
import { initPhysics } from '../../src/physics/world';

/** Whole headless bouts (minutes in all): `npm run balance`, not `npm test`. See `npx tsx tools/balance.ts`. */
const MINUTES = 60_000;

/**
 * Before big fights (2026-11-12) a landed normal hit lifted its target's torso to a median 0.97 m above the ring top
 * (seed 1 sample; 0.98 for seed 2), and 12% of hits reached 1.5 m. The design asks for twice that height.
 */
const BEFORE_PEAK = 0.97;

beforeAll(initPhysics);

let lengths: FourWayReport | null = null;
const lengthSample = () => (lengths ??= fourWayReport(20, { seed: 1 }));

test('fights last the spec’s length', () => {
  const r = lengthSample();
  expect(r.medianFirstOut).toBeGreaterThanOrEqual(40); expect(r.medianFirstOut).toBeLessThanOrEqual(70);
  expect(r.medianEnd).toBeGreaterThanOrEqual(90); expect(r.medianEnd).toBeLessThanOrEqual(180);
  // spec: never a stretch longer than "~3 s" without a hit (ruling: an approximate target). Body geometry still makes
  // the odd longer one (tiny under legs, hugs, wings hovering past the edge), so: none over 4.5 s, few over 3 s.
  expect(r.maxQuiet).toBeLessThanOrEqual(4.5);
  expect(r.quietOver3 / r.bouts.length).toBeLessThanOrEqual(0.15);
}, 5 * MINUTES);

// Big fights: hits pop fighters high, and everyone unleashes specials.
test('fighters fly: big pop-ups and specials', () => {
  const r = lengthSample();
  expect(r.medianPeak, 'median peak torso height of a landed normal hit').toBeGreaterThanOrEqual(2 * BEFORE_PEAK);
  expect(r.highShare, `share of landed normal hits peaking at ${HIGH_LAUNCH} m or more`).toBeGreaterThanOrEqual(0.25);
  expect(r.specialsPer45, 'specials each fighter performs per 45 s of fighting').toBeGreaterThanOrEqual(1);
}, 5 * MINUTES);

// R6: in random four-way bouts a fair share is 0.25; no kind may win more than 0.35 of the bouts it is in. A bout that
// runs out of time with 2+ left has no winner. Ruling (big fights, 2026-11-12): pooled over three seeds (210 bouts,
// ~120 per kind). One 70-bout seed gave each kind ~35 bouts, where a fair 0.25 kind tops 0.35 by chance alone often
// enough (sd ~0.07) that the check failed on noise and invited tuning to the seed.
test('no body kind dominates', () => {
  const pooled: Record<string, { bouts: number; wins: number }> = {};
  for (const k of BODY_KINDS) pooled[k] = { bouts: 0, wins: 0 };
  for (const seed of [2, 3, 4]) {
    const r = fourWayReport(70, { seed });
    for (const k of BODY_KINDS) { pooled[k].bouts += r.kinds[k].bouts; pooled[k].wins += r.kinds[k].wins; }
  }
  const rates = BODY_KINDS.map((k) => `${k} ${pooled[k].wins}/${pooled[k].bouts}`).join(', ');
  for (const k of BODY_KINDS) {
    expect(pooled[k].bouts, k).toBeGreaterThanOrEqual(90);
    expect(pooled[k].wins / pooled[k].bouts, `${k} (${rates})`).toBeLessThanOrEqual(0.35);
  }
  console.log(`R6 pooled win rates: ${rates}`);
}, 20 * MINUTES);
