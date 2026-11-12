/**
 * The fight-balance report: headless four-way bouts of random body kinds, against the spec's targets (§3.2). By default
 * it runs the balance tests' own samples: 20 bouts (seed 1) for fight length, 70 bouts (seed 2) for who wins.
 * Run: npx tsx tools/balance.ts
 *      npx tsx tools/balance.ts --bouts 40 --seed 3    one sample of your own, both tables
 *      npx tsx tools/balance.ts --seconds 300          a longer cap per bout (default 240)
 */
import { BODY_KINDS, fourWayReport, type FourWayReport } from '../src/fight/sim';
import { initPhysics } from '../src/physics/world';

const arg = (name: string): number | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v)) throw new Error(`--${name} needs a number`);
  return v;
};
const seconds = arg('seconds') ?? 240;
const s1 = (x: number) => x.toFixed(1).padStart(6);

function sample(bouts: number, seed: number): FourWayReport {
  console.log(`\n${bouts} four-way bouts (seed ${seed}, at most ${seconds} s each)`);
  console.log('  #  cast                          first out     end  quiet  winner');
  return fourWayReport(bouts, {
    seed, seconds,
    onBout: (i, cast, b) => console.log(
      `${String(i + 1).padStart(3)}  ${cast.join(' ').padEnd(28)}  ${s1(b.ringOuts[0]?.t ?? seconds)}  ${s1(b.end)}${b.timedOut ? '*' : ' '} ${s1(b.longestQuiet)}  ${b.winner ?? '-'}`,
    ),
  });
}

function lengths(r: FourWayReport): void {
  console.log(`\n(* = timed out with 2+ left, no winner: ${r.timedOut} of ${r.bouts.length})`);
  console.log(`median first ring-out  ${s1(r.medianFirstOut)} s   (target 40–70)`);
  console.log(`median end             ${s1(r.medianEnd)} s   (target 90–180)`);
  console.log(`longest quiet          ${r.maxQuiet.toFixed(2).padStart(6)} s   (target ≤ 4.5, while 2+ fight)`);
  console.log(`bouts with a quiet > 3 s  ${r.quietOver3} of ${r.bouts.length} (${((100 * r.quietOver3) / r.bouts.length).toFixed(0)}%; target ≤ 15%)`);
}

function wins(r: FourWayReport): void {
  console.log(`\n(timed out, no winner: ${r.timedOut} of ${r.bouts.length})`);
  console.log('kind    bouts  wins  win rate   (target ≤ 0.35 each, in ≥ 30 bouts; fair share 0.25)');
  for (const k of BODY_KINDS) {
    const s = r.kinds[k];
    console.log(`${k.padEnd(6)}  ${String(s.bouts).padStart(5)}  ${String(s.wins).padStart(4)}  ${s.winRate.toFixed(2).padStart(8)}`);
  }
}

await initPhysics();
const started = performance.now();
const bouts = arg('bouts'), seed = arg('seed');
if (bouts !== undefined || seed !== undefined) {
  const r = sample(bouts ?? 70, seed ?? 1);
  lengths(r);
  wins(r);
} else {
  lengths(sample(20, 1));
  wins(sample(70, 2));
}
console.log(`\n${((performance.now() - started) / 1000).toFixed(0)} s wall-clock`);
