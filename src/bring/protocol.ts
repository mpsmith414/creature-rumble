import { z } from 'zod';
import { ImageInSchema, KidCardsSchema, type KidCards } from '../designer/types';

/** The phone relay's messages, shared by the server, the TV and the phone page (no DOM, no node imports). */

/** The sticker a kid picks on the phone; 12 of them, so friends in the line look different. */
export const BADGES = ['🦊', '🐻', '🐸', '🐰', '🦉', '🐢', '🦄', '🐙', '🦖', '🐝', '🐧', '🐳'] as const;
/** The 4-letter join code uses no I, L or O (they look like 1 and 0). */
export const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
/** The daily creature limit's choices and its default (the server counts, the TV's menu offers the same four). */
export const LIMITS = [5, 10, 20, 50] as const;
export const DEFAULT_LIMIT = 10;

export const DesignInputSchema = z.object({ image: ImageInSchema.nullable(), words: z.string().max(500) });
export type DesignInput = z.infer<typeof DesignInputSchema>;
export type Maker = { name: string; badge: string };

export const StepMsgSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reading') }),
  z.object({ kind: z.literal('building') }),
  z.object({ kind: z.literal('looking'), pass: z.number() }),
  z.object({ kind: z.literal('fixing'), pass: z.number(), note: z.string() }),
]);
export type StepMsg = z.infer<typeof StepMsgSchema>;

// ---- the ring: what a phone may ask of the TV, and what the TV tells every phone ----

/** A roster id is short (`r` + time + random); the relay refuses anything longer before it reaches the TV. */
export const ROSTER_ID_MAX = 64;
/** What a phone may ask of the ring (POST /api/phone/command). The TV decides what it does (a crown with nobody
 * fighting does nothing). Strict: an unknown kind or an extra field is refused. */
export const PhoneCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('crown') }),
  z.strictObject({ kind: z.literal('again') }),
  z.strictObject({ kind: z.literal('sendBack'), id: z.string().min(1).max(ROSTER_ID_MAX) }),
]);
export type PhoneCommand = z.infer<typeof PhoneCommandSchema>;

/** The roster's own thumbs are JPEG data URLs under 20 000 characters (`MAX_THUMB_CHARS` in the roster). */
const THUMB_MAX = 20_000;
/** One roster creature as phones see it (the roster's `RosterSummary`). */
export const RingEntrySchema = z.object({
  id: z.string().min(1).max(ROSTER_ID_MAX),
  name: z.string().max(200),
  maker: z.string().max(200),
  crowns: z.number().int().min(0),
  thumb: z.string().max(THUMB_MAX).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]*$/).nullable(),
});
export type RingEntry = z.infer<typeof RingEntrySchema>;
export type RingPhase = 'open' | 'crowned';
/** The ring as every phone sees it: the match phase, how many are fighting, and the roster to send back in. */
export type Ring = { phase: RingPhase; fighting: number; roster: RingEntry[] };

/** A roster creature fit to send to the phones: as it is, or with no thumb when only its thumb is wrong (too big, not a
 * JPEG), or null when it cannot be sent at all (so one bad entry never spoils the whole ring). */
export function ringEntry(e: unknown): RingEntry | null {
  const ok = RingEntrySchema.safeParse(e);
  if (ok.success) return ok.data;
  const bare = RingEntrySchema.safeParse({ ...(e as object), thumb: null });
  return bare.success ? bare.data : null;
}

/** The ring a TV page that has just registered shows the phones: nobody fighting, no roster (Crown and the old roster
 * buttons go until the TV says more). */
export const EMPTY_RING: Ring = { phase: 'open', fighting: 0, roster: [] };

/** Phones get at most this many roster creatures (each thumb is up to 20 kB, and every phone gets every ring). */
export const RING_ROSTER_MAX = 60;
/** The roster for the phones: champions first, then everyone else, each newest first as given (the roster lists newest
 * first), at most `RING_ROSTER_MAX`. */
export function ringRoster<E extends { crowns: number }>(roster: readonly E[]): E[] {
  return [...roster.filter((e) => e.crowns > 0), ...roster.filter((e) => !(e.crowns > 0))].slice(0, RING_ROSTER_MAX);
}

export type PhoneSnapshot = {
  phase: 'idle' | 'waiting' | 'making' | 'preview' | 'released' | 'kept' | 'resting';
  place?: number; cards?: KidCards; tweaksLeft?: number;
};

/** To a phone (SSE `data:` JSON). */
export type PhoneMsg =
  | { type: 'hello'; state: PhoneSnapshot } // first message on every stream: where this phone is
  | { type: 'line'; place: number; ahead: Maker[] } // place 0 = on stage
  | { type: 'step'; step: StepMsg }
  | { type: 'preview'; cards: KidCards; tweaksLeft: number }
  | { type: 'tweaked'; cards: KidCards; note: string; tweaksLeft: number }
  | { type: 'released' } | { type: 'kept' }
  | { type: 'failed'; message: string; retry: boolean }
  | { type: 'resting' } | { type: 'noHost' }
  | ({ type: 'ring' } & Ring); // to every phone: the match phase and the roster changed (also after each hello)

/** To the TV host (SSE). */
export type HostMsg =
  | { type: 'hello'; code: string; url: string }
  | { type: 'joined'; token: string; maker: Maker } | { type: 'left'; token: string }
  | { type: 'line'; line: { token: string; maker: Maker }[] }
  | { type: 'turn'; token: string; maker: Maker; input: DesignInput }
  | { type: 'tweak'; token: string; words: string } | { type: 'release'; token: string } | { type: 'cancel'; token: string }
  | { type: 'command'; token: string; command: PhoneCommand } // a phone asks the ring for something
  | { type: 'replaced' };

/** From the TV host about the phone on stage (POST /api/relay/host/send; the route adds the token). The relay fills
 * `tweaksLeft` itself. */
export const StageSendSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('step'), step: StepMsgSchema }),
  z.object({ type: z.literal('preview'), cards: KidCardsSchema }),
  z.object({ type: z.literal('tweaked'), cards: KidCardsSchema, note: z.string() }),
  z.object({ type: z.literal('released') }),
  z.object({ type: z.literal('kept') }),
  z.object({ type: z.literal('failed'), message: z.string(), retry: z.boolean() }),
]);
export type StageSend = z.infer<typeof StageSendSchema>;
/** From the TV host to every phone (the same route, no token): sent on every match phase change and roster change. The
 * relay caps the roster with `ringRoster`, so the schema allows a longer one. */
export const RingSendSchema = z.object({
  type: z.literal('ring'),
  phase: z.enum(['open', 'crowned']),
  fighting: z.number().int().min(0).max(1000),
  roster: z.array(RingEntrySchema).max(5000),
});
export type RingSend = z.infer<typeof RingSendSchema>;
export const HostSendSchema = z.discriminatedUnion('type', [...StageSendSchema.options, RingSendSchema]);
export type HostSend = z.infer<typeof HostSendSchema>;
