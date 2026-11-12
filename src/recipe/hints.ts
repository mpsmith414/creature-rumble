import type { Build, Coat, Covering, Face, Recipe, Region } from './schema';

/** What the hint rules read: the body, skin and character, not the hints themselves. */
export type HintInput = Pick<Recipe, 'parts' | 'skin' | 'motion' | 'mind' | 'life'>;

/** The covering of the head's region (the first `head` part), else of the first part. */
export function headCovering(r: HintInput): Covering {
  const part = r.parts.find((p) => p.role === 'head') ?? r.parts[0];
  return (r.skin.regions.find((g) => g.id === part.region) ?? r.skin.regions[0]).covering;
}

const MUSCLE: Record<Covering, number> = { fur: 0.6, feathers: 0.5, skin: 0.3, scales: 0.3, slime: 0.15, shell: 0.15 };

/** Guess the build hints from the body, for recipes that came without them. */
export function inferBuild(r: HintInput): Build {
  const cov = headCovering(r);
  const water = r.mind.habitat.includes('water');
  const hasFeet = r.parts.some((p) => p.role === 'foot');
  const hasLegs = r.parts.some((p) => p.role === 'leg');
  const torso = Math.max(0, ...r.parts.filter((p) => p.role === 'torso').map((p) => Math.max(p.r0, p.r1)));
  const squat = r.motion.gait === 'hop' && torso > 0.25 * r.life.sizeM;
  const muscle = Math.min(1, Math.max(0, MUSCLE[cov] - (squat ? 0.2 : 0)));
  const feet: Build['feet'] = !hasFeet ? 'plain'
    : cov === 'feathers' ? (water ? 'webbed' : 'talons')
    : cov === 'fur' ? (hasLegs && r.life.massKg > 30 && r.mind.preyMax === 0 ? 'hooves' : 'paws') // big plant-eaters only
    : (cov === 'slime' || cov === 'skin') && water ? 'webbed'
    : 'plain';
  return { muscle, feet };
}

/** Guess the face hints from the body, for recipes that came without them. */
export function inferFace(r: HintInput): Face {
  const cov = headCovering(r);
  const water = r.mind.habitat.includes('water');
  const nose: Face['nose'] = cov === 'feathers' ? (water ? 'bill' : 'beak')
    : cov === 'fur' ? 'pad'
    : cov === 'shell' ? 'none'
    : 'slits';
  const fish = r.motion.gait === 'swim' && r.mind.habitat.length === 1 && r.mind.habitat[0] === 'water';
  return { nose, noseColor: null, lids: !fish, earInner: null, brow: nose === 'beak' ? 0.5 : 0.3 };
}

/** Guess a region's coat word from its covering, fur length and fluff, for regions that came without one. */
export function inferCoat(r: Pick<Region, 'covering' | 'furLength' | 'fluff'>): Coat | null {
  if (r.covering === 'feathers') return r.fluff >= 0.5 ? 'downy' : 'smooth';
  if (r.covering !== 'fur') return null;
  if (r.fluff >= 0.75 && r.furLength < 0.05) return 'woolly';
  if (r.furLength >= 0.05 || r.fluff >= 0.75) return 'shaggy';
  return r.furLength < 0.008 && r.fluff < 0.3 ? 'sleek' : 'soft';
}
