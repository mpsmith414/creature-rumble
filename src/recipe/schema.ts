import { z } from 'zod';

/**
 * The creature recipe: everything about a creature, as plain data.
 *
 * Creature space: metres, +z forward (towards the head), +y up, +x the creature's left.
 * Fighters (v4) stand upright: the torso grows along +y, +z is where the face looks, arms (`arm`, ending in a `hand`)
 * hang from the upper torso and legs reach the ground.
 * The schema has no numeric ranges on purpose (structured outputs ignore them);
 * ranges live in `LIMITS` and `normalizeRecipe` clamps to them.
 */

export const SCHEMA_VERSION = 4 as const;

export const ROLES = [
  'head', 'neck', 'torso', 'leg', 'foot', 'arm', 'hand', 'wing', 'tail', 'fin',
  'horn', 'antenna', 'ear', 'eye', 'mouth', 'other',
] as const;
export const COVERINGS = ['fur', 'scales', 'feathers', 'skin', 'shell', 'slime'] as const;
export const PATTERNS = ['stripes', 'spots', 'patches', 'rings', 'gradient'] as const;
export const FLAT_FACINGS = ['up', 'side', 'forward'] as const;
export const GAITS = ['walk', 'hop', 'slither', 'waddle', 'fly', 'swim', 'hover'] as const;
export const SOCIAL = ['solitary', 'pair', 'herd', 'pack', 'flock'] as const;
export const ACTIVITY = ['day', 'night', 'twilight'] as const;
export const HABITATS = ['ground', 'water', 'air', 'trees', 'burrow'] as const;
export const FEET = ['paws', 'hooves', 'talons', 'webbed', 'plain'] as const;
export const NOSES = ['pad', 'beak', 'bill', 'slits', 'none'] as const;
export const COATS = ['sleek', 'soft', 'shaggy', 'woolly', 'bristly', 'smooth', 'downy'] as const;
export type Coat = (typeof COATS)[number];
/** The coat words that fit each covering: fur takes the first five, feathers the last two, the rest take none. */
export const FUR_COATS: readonly Coat[] = ['sleek', 'soft', 'shaggy', 'woolly', 'bristly'];
export const FEATHER_COATS: readonly Coat[] = ['smooth', 'downy'];

/** Every signature move a fighter can have (spec §3.3). */
export const MOVES = ['punch', 'jab', 'kick', 'bump', 'headbutt', 'spin', 'divebomb'] as const;

/** How a creature fights and how the announcer brings it on (re-exported by src/fight/types). */
export const FightPlanSchema = z.object({
  move: z.enum(MOVES).describe('Signature move: punch (big fists), jab (tiny), kick (long legs), bump (big round body), headbutt (horns), spin (long tail), divebomb (wings)'),
  weapons: z.array(z.string()).describe('Ids of the parts it hits with, e.g. the hands for a punch'),
  weight: z.string().describe('A silly weigh-in, e.g. "a wobbly thirty pounds"'),
  intro: z.string().describe('The announcer’s one-line introduction'),
});

const Vec3Schema = z.object({ x: z.number(), y: z.number(), z: z.number() });

export const PartSchema = z.object({
  id: z.string().describe('Short unique id, e.g. "torso", "leg_front", "tail2"'),
  parent: z.string().nullable().describe('Id of the part this grows from; null only for the one root part (usually the torso)'),
  role: z.enum(ROLES),
  attach: z.number().describe('Where on the parent it starts: 0 = parent start, 1 = parent end'),
  offset: Vec3Schema.describe('Shift of the start point from that spot, metres (e.g. x = 0.12 puts a leg on the side of the body)'),
  dir: Vec3Schema.describe('Direction it grows in creature space (+z forward, +y up, +x the creature’s left)'),
  length: z.number().describe('Length in metres'),
  r0: z.number().describe('Thickness radius at the start, metres'),
  r1: z.number().describe('Thickness radius at the end, metres'),
  squash: z.number().describe('Cross-section roundness: 1 = round, 0.2 = flat like an ear, fin or wing'),
  flatFacing: z.enum(FLAT_FACINGS).describe('Which way the flat face points when squashed: "up" (wings, beaver tails), "side" (fish fins, a fish tail), "forward" (ears)'),
  pointed: z.boolean().describe('Ends in a sharp tip (horns, claws, beaks)'),
  mirror: z.boolean().describe('Also make a mirror copy on the other side (x flipped); its children come along'),
  region: z.string().describe('Id of the skin region covering this part'),
});

export const PatternSchema = z.object({
  kind: z.enum(PATTERNS),
  color: z.string().describe('#rrggbb'),
  scale: z.number().describe('Size of one stripe/spot/ring repeat, metres'),
  amount: z.number().describe('0..1 how much of the region the pattern covers'),
  along: z.boolean().describe('Stripes run along the body (true) or around it (false)'),
});

export const RegionSchema = z.object({
  id: z.string(),
  covering: z.enum(COVERINGS),
  color: z.string().describe('#rrggbb base colour'),
  belly: z.string().nullable().describe('#rrggbb lighter underside colour, or null'),
  furLength: z.number().describe('Fur/feather length in metres (0 when not furry)'),
  fluff: z.number().describe('0..1 how fluffy and unruly'),
  coat: z.enum(COATS).nullable().describe('Hair or feather kind: fur sleek|soft|shaggy|woolly|bristly, feathers smooth|downy; null otherwise'),
  pattern: PatternSchema.nullable(),
});

export const BuildSchema = z.object({
  muscle: z.number().describe('0..1 how defined the body is: 0 soft and smooth (frog, baby, slug), 1 lean and sculpted (deer, wolf)'),
  feet: z.enum(FEET).describe('Shape of foot parts: paws (toe pads), hooves, talons (bird toes), webbed, plain'),
});

export const FaceSchema = z.object({
  nose: z.enum(NOSES).describe('pad (wet dog/cat/rabbit nose), beak (hooked), bill (duck), slits (reptile, frog, fish nostrils), none'),
  noseColor: z.string().nullable().describe('#rrggbb nose colour, or null for a darkened head colour'),
  lids: z.boolean().describe('Has eyelids (false for fish)'),
  earInner: z.string().nullable().describe('#rrggbb colour inside the ears, or null for a lightened ear colour'),
  brow: z.number().describe('0..1 how heavy the brow ridge over the eyes is'),
});

export const RecipeSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string(),
  name: z.string(),
  seed: z.number(),
  source: z.object({
    kind: z.enum(['native', 'drawing', 'words', 'both']),
    description: z.string(),
  }),
  parts: z.array(PartSchema),
  skin: z.object({
    regions: z.array(RegionSchema),
    eyes: z.object({
      color: z.string(),
      pupil: z.enum(['round', 'slit', 'bar', 'none']),
      size: z.number().describe('0..1 eye size relative to the eye part'),
    }),
  }),
  build: BuildSchema,
  face: FaceSchema,
  motion: z.object({
    gait: z.enum(GAITS),
    bounce: z.number(),
    sway: z.number(),
    stance: z.enum(['low', 'normal', 'upright']),
  }),
  life: z.object({
    sizeM: z.number().describe('Overall length in metres'),
    massKg: z.number(),
    topSpeed: z.number().describe('m/s'),
    stamina: z.number(),
    lifespanDays: z.number(),
    maturityDays: z.number(),
    litterMin: z.number(),
    litterMax: z.number(),
    juvenileHead: z.number().describe('Baby head size multiplier, e.g. 1.3'),
    juvenileFluff: z.number(),
  }),
  mind: z.object({
    plants: z.array(z.string()),
    preyMin: z.number().describe('Smallest prey length in metres (0 if none)'),
    preyMax: z.number().describe('Largest prey length in metres (0 if none)'),
    scavenger: z.boolean(),
    boldness: z.number(),
    jumpiness: z.number(),
    social: z.enum(SOCIAL),
    activity: z.enum(ACTIVITY),
    habitat: z.array(z.enum(HABITATS)),
    senses: z.object({
      fov: z.number().describe('Field of view in degrees'),
      acuity: z.number(),
      night: z.number(),
      smell: z.number(),
      hearing: z.number(),
      colour: z.enum(['muted', 'normal', 'vivid']),
    }),
  }),
  inheritance: z.array(z.object({ path: z.string(), spread: z.number() })),
  fight: FightPlanSchema.nullable().describe('How it fights; null to let its body decide'),
});

export type Role = (typeof ROLES)[number];
export type Covering = (typeof COVERINGS)[number];
export type PatternKind = (typeof PATTERNS)[number];
export type Gait = (typeof GAITS)[number];
export type FlatFacing = (typeof FLAT_FACINGS)[number];
export type Feet = (typeof FEET)[number];
export type Nose = (typeof NOSES)[number];
export type Build = z.infer<typeof BuildSchema>;
export type Face = z.infer<typeof FaceSchema>;
export type Part = z.infer<typeof PartSchema>;
export type Pattern = z.infer<typeof PatternSchema>;
export type Region = z.infer<typeof RegionSchema>;
export type Recipe = z.infer<typeof RecipeSchema>;
export type FightPlan = z.infer<typeof FightPlanSchema>;

export const MAX_PARTS = 48;
export const MAX_BONES = 96;
export const MAX_REGIONS = 8;

type Range = readonly [number, number];
/** Sensible limits for every number in a recipe. */
export const LIMITS = {
  attach: [0, 1],
  length: [0.005, 6],
  radius: [0.002, 2],
  squash: [0.1, 1],
  furLength: [0, 0.15],
  unit: [0, 1],
  patScale: [0.005, 2],
  eyeSize: [0.2, 1],
  muscle: [0, 1],
  brow: [0, 1],
  sizeM: [0.02, 8],
  massKg: [0.001, 5000],
  topSpeed: [0.05, 25],
  lifespanDays: [5, 20000],
  maturityDays: [1, 5000],
  litter: [1, 12],
  juvenileHead: [1, 2],
  prey: [0, 8],
  fov: [30, 340],
  spread: [0, 0.3],
  seed: [0, 2 ** 31 - 1],
} as const satisfies Record<string, Range>;

export const DEFAULT_COLOR = '#8a7a66';
