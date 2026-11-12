import { z } from 'zod';
import { RecipeEditSchema } from '../recipe/edits';
import { FightPlanSchema, RecipeSchema } from '../recipe/schema';

/** Shared by the browser and the designer service. */

export const KidCardsSchema = z.object({
  name: z.string().describe('A fun, short name for the creature'),
  eats: z.string().describe('What it eats, a few words plus one emoji'),
  speed: z.string().describe('How fast it moves, a few words plus one emoji'),
  mood: z.string().describe('Its personality, a few words plus one emoji'),
  special: z.string().describe('Its most special thing, one short phrase'),
});
export type KidCards = z.infer<typeof KidCardsSchema>;

export const ImageInSchema = z.object({ base64: z.string(), mediaType: z.enum(['image/jpeg', 'image/png']) });
export type ImageIn = z.infer<typeof ImageInSchema>;

export const ViewSchema = z.object({
  angle: z.enum(['side', 'front', 'threeQuarter', 'top']).describe('Which way the drawing shows the creature'),
  facing: z.enum(['left', 'right', 'toward']).describe('Which way its head points in the picture'),
});
export type View = z.infer<typeof ViewSchema>;

// ---- requests ----
export const ReadRequestSchema = z.object({ image: ImageInSchema.nullable(), words: z.string().max(2000) });
export type ReadRequest = z.infer<typeof ReadRequestSchema>;

export const LookAgainRequestSchema = z.object({
  image: ImageInSchema.nullable(),
  words: z.string().max(2000),
  render: ImageInSchema,
  recipe: z.unknown(),
  checklist: z.array(z.string()),
  pass: z.number().int().min(1).max(5),
});
export type LookAgainRequest = Omit<z.infer<typeof LookAgainRequestSchema>, 'recipe'> & { recipe: z.infer<typeof RecipeSchema> };

export const TweakRequestSchema = z.object({ recipe: z.unknown(), cards: KidCardsSchema, words: z.string().min(1).max(500) });
export type TweakRequest = Omit<z.infer<typeof TweakRequestSchema>, 'recipe'> & { recipe: z.infer<typeof RecipeSchema> };

// ---- what the model writes (structured output) ----
/** The recipe as the model writes it; normalising afterwards clamps and repairs it, and the server makes it a fighter
 * (`ensureFighter`) and fills a missing, null or unusable `fight` from its body (`planFor`). */
export const WireRecipeSchema = RecipeSchema.extend({ schemaVersion: z.number() });

/** A changed fight plan from looking again or a tweak; the server hands it back as a `set fight` edit. */
const FightChange = FightPlanSchema.nullable().describe('The whole new fight plan when your edits change how it fights (e.g. new fists, a new tail); null to keep it as it is');

export const ReadWire = z.object({
  status: z.enum(['ok', 'noCreature', 'declined']).describe('"noCreature" if there is no creature to make (blank page, a photo of a person); "declined" for unkind or unsafe requests'),
  message: z.string().describe('For noCreature/declined: one friendly sentence for a child. Otherwise empty.'),
  recipe: WireRecipeSchema.nullable(),
  checklist: z.array(z.string()).describe('Short, countable facts about what you see, e.g. "6 legs", "3 horns", "pink spots on the back"'),
  view: ViewSchema,
  cards: KidCardsSchema,
});
export const LookAgainWire = z.object({
  verdict: z.enum(['matches', 'edits']),
  edits: z.array(RecipeEditSchema).describe('A few precise edits, most important first; empty when it matches'),
  note: z.string().describe('One short, friendly sentence about what you fixed (or that it looks right), for a child'),
  fight: FightChange,
});
export const TweakWire = z.object({
  status: z.enum(['ok', 'declined']),
  message: z.string(),
  edits: z.array(RecipeEditSchema),
  cards: KidCardsSchema.describe('The cards, updated if the change affects them'),
  note: z.string().describe('One short, friendly sentence saying what changed'),
  fight: FightChange,
});

// ---- what the app accepts (lenient: normalising repairs recipes and parts afterwards) ----
const LooseEdit = z.union([
  z.object({ op: z.literal('set'), path: z.string(), valueJson: z.string() }),
  z.object({ op: z.literal('addPart'), part: z.object({ id: z.string() }).passthrough() }),
  z.object({ op: z.literal('removePart'), id: z.string() }),
]);
export const ReadCheck = ReadWire.extend({ recipe: z.object({ parts: z.array(z.unknown()) }).passthrough().nullable() });
// a missing or unusable fight change just leaves the plan as it is
export const LookAgainCheck = LookAgainWire.extend({ edits: z.array(LooseEdit), fight: z.unknown().optional() });
export const TweakCheck = TweakWire.extend({ edits: z.array(LooseEdit), fight: z.unknown().optional() });

// ---- responses ----
export type ReadResult =
  | { status: 'ok'; recipe: z.infer<typeof RecipeSchema>; checklist: string[]; view: View; cards: KidCards; fixes: string[] }
  | { status: 'noCreature' | 'declined'; message: string };
/** A fight change comes back folded into `edits` (as `set fight`), so results carry no `fight` of their own. */
export type LookAgainResult = Omit<z.infer<typeof LookAgainWire>, 'fight'> & { status: 'ok' };
export type TweakResult = { status: 'ok'; edits: z.infer<typeof RecipeEditSchema>[]; cards: KidCards; note: string } | { status: 'declined'; message: string };
