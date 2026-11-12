import { networkInterfaces } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';
import { buildSkeleton } from '../src/builder/skeleton';
import { planFor } from '../src/fight/moves';
import { FightPlanSchema } from '../src/fight/types';
import type { RecipeEdit } from '../src/recipe/edits';
import { ensureFighter } from '../src/recipe/fighter';
import { normalizeRecipe, RecipeError } from '../src/recipe/normalize';
import type { Recipe } from '../src/recipe/schema';
import {
  LookAgainCheck, LookAgainRequestSchema, ReadCheck, ReadRequestSchema, TweakCheck, TweakRequestSchema,
  type LookAgainRequest, type LookAgainResult, type ReadResult, type TweakRequest, type TweakResult,
} from '../src/designer/types';
import { DailyCap, LIMITS } from './cap';
import { Declined, type DesignerModel } from './model';
import { isLoopback, lanHost, requestAddress } from './net';
import type { Relay } from './relay';
import { relayRoutes } from './relay-routes';
import { voiceRoutes, type Synth, type VoiceCache } from './voice';

const MAX_BODY = 12 * 1024 * 1024;

/** The connection's address under Node (undefined elsewhere, e.g. `app.request` in tests: refused as not local). */
export const nodeAddress = (c: Context): string | undefined => {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
};

/** Is this failure the service being unavailable (network, overload, no key) rather than bad output? */
function isResting(e: unknown): boolean {
  if (e instanceof Anthropic.APIConnectionError) return true;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return true;
  // a key that spans workspaces but no (or an unknown) workspace ID
  if (e instanceof Anthropic.APIError && /anthropic-workspace-id|Workspace .* not found/i.test(e.message)) return true;
  if (e instanceof Anthropic.RateLimitError) return true;
  if (e instanceof Anthropic.APIError && (e.status ?? 0) >= 500) return true;
  return e instanceof Error && /api key|apiKey|ANTHROPIC_API_KEY|credentials/i.test(e.message);
}

/** Is it resting because the API key was rejected or is missing (not a network or load problem)? */
function keyProblem(e: unknown): boolean {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return true;
  return !(e instanceof Anthropic.APIError) && e instanceof Error && /api key|apiKey|ANTHROPIC_API_KEY|credentials/i.test(e.message);
}

class Invalid extends Error {}

/**
 * Any recipe → a ready fighter: normalised, stood up with arms (`ensureFighter`), and with a fight plan — the model's
 * own when it names real parts, else the move its body suggests (`planFor`). Throws `RecipeError` like `normalizeRecipe`.
 */
function asFighter(raw: unknown): { recipe: Recipe; fixes: string[] } {
  const n = normalizeRecipe(raw);
  const f = ensureFighter(n.recipe);
  const recipe = f.recipe;
  const fixes = [...n.fixes, ...f.fixes];
  const fight = planFor(recipe, buildSkeleton(recipe));
  if (JSON.stringify(fight) !== JSON.stringify(recipe.fight)) {
    fixes.push(recipe.fight && recipe.fight.move === fight.move && recipe.fight.weapons.length ? 'fight plan words filled in' : `fight plan → ${fight.move} with ${fight.weapons.join(', ')} (from its body)`);
  }
  return { recipe: { ...recipe, fight }, fixes };
}

/** A usable fight plan from looking again or a tweak becomes one more edit (last, so it can name parts just added). */
function withFight(edits: RecipeEdit[], fight: unknown): RecipeEdit[] {
  const plan = FightPlanSchema.safeParse(fight);
  return plan.success ? [...edits, { op: 'set', path: 'fight', valueJson: JSON.stringify(plan.data) }] : edits;
}

/**
 * Ask the model, check its output against the schema and our own rules, and try once more
 * if it comes back malformed (the "repair attempt").
 */
async function twice<S extends z.ZodType, T>(call: () => Promise<unknown>, schema: S, check: (v: z.infer<S>) => T): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await call();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      last = parsed.error;
      continue;
    }
    try {
      return check(parsed.data);
    } catch (e) {
      if (!(e instanceof RecipeError || e instanceof Invalid)) throw e;
      last = e;
    }
  }
  throw new Invalid(String(last));
}

/** `opts.cap` limits how many creatures `/api/read` will read per day; without it reads are uncapped. `opts.relay` mounts
 * the phone relay's routes; `opts.host` is the address phones reach this PC at (default: its first LAN address; `server/index.ts` adds the `PHONE_HOST` override).
 * `opts.voice` mounts the narrator's voice (`/api/voice`). `opts.address` says where a request came from (default: the
 * Node socket): hosting the relay (`/api/relay/host*`) and setting the daily limit (`POST /api/cap`) are for the TV on
 * this PC only, so anyone else gets 403 (a phone on the Wi-Fi must not take over the TV's phones or push a fake ring). */
export function createApp(model: DesignerModel, opts?: {
  cap?: DailyCap; relay?: Relay; host?: () => string; heartbeatMs?: number; voice?: { synth: Synth | ((voice: string) => Synth); cache: VoiceCache };
  address?: (c: Context) => string | undefined;
}): Hono {
  const cap = opts?.cap;
  const app = new Hono();
  app.use('/api/*', bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: 'too big' }, 413) }));
  const address = opts?.address ?? nodeAddress;
  const localOnly: MiddlewareHandler = async (c, next) => {
    if (!isLoopback(requestAddress(address(c), c.req.header('x-forwarded-for')))) return c.json({ error: 'forbidden' }, 403);
    await next();
  };
  app.use('/api/relay/host', localOnly);
  app.use('/api/relay/host/*', localOnly);

  app.get('/api/health', (c) => c.json({ ok: true, model: model.model }));

  const handle = async (c: Context, work: () => Promise<unknown>) => {
    try {
      return c.json(await work());
    } catch (e) {
      if (e instanceof Declined) return c.json({ status: 'declined', message: 'Let’s make a different creature!' });
      if (e instanceof Invalid) return c.json({ error: 'invalid' }, 422);
      if (isResting(e)) {
        // say why in the server's terminal (a wrong key or missing workspace ID shows up here)
        console.warn(`designer resting: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
        // a rejected (or missing) key, said plainly so the dev pages can tell the owner; the key itself is never sent
        return keyProblem(e) ? c.json({ error: 'resting', reason: 'key' }, 503) : c.json({ error: 'resting' }, 503);
      }
      console.error(e);
      return c.json({ error: 'resting' }, 503);
    }
  };

  app.post('/api/read', localOnly, async (c) => {
    const req = ReadRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!req.success || (!req.data.image && !req.data.words.trim())) return c.json({ error: 'bad request' }, 400);
    // a read that then fails still cost a call, so it counts
    if (cap && !cap.take()) return c.json({ error: 'resting' }, 429);
    return handle(c, () =>
      twice(() => model.read(req.data), ReadCheck, (w): ReadResult => {
        if (w.status !== 'ok') return { status: w.status, message: w.message || 'Let’s try another drawing!' };
        if (!w.recipe) throw new Invalid('no recipe');
        const { recipe, fixes } = asFighter(w.recipe);
        return { status: 'ok', recipe, checklist: w.checklist, view: w.view, cards: w.cards, fixes };
      }),
    );
  });

  if (cap) {
    app.get('/api/cap', (c) => c.json(cap.state()));
    app.post('/api/cap', localOnly, async (c) => {
      const body = (await c.req.json().catch(() => null)) as { limit?: unknown } | null;
      const limit = body?.limit;
      if (!(LIMITS as readonly unknown[]).includes(limit)) return c.json({ error: 'bad request' }, 400);
      return c.json(cap.setLimit(limit as number));
    });
  }

  if (opts?.relay) relayRoutes(app, opts.relay, cap ?? new DailyCap({}), { host: opts.host ?? (() => lanHost(networkInterfaces())), heartbeatMs: opts.heartbeatMs });

  if (opts?.voice) voiceRoutes(app, opts.voice.synth, opts.voice.cache, localOnly);

  app.post('/api/look-again', localOnly, async (c) => {
    const req = LookAgainRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!req.success) return c.json({ error: 'bad request' }, 400);
    let recipe;
    try {
      recipe = asFighter(req.data.recipe).recipe;
    } catch {
      return c.json({ error: 'bad request' }, 400);
    }
    const r: LookAgainRequest = { ...req.data, recipe };
    return handle(c, () =>
      twice(() => model.lookAgain(r), LookAgainCheck, ({ fight, ...w }): LookAgainResult => ({ status: 'ok', ...w, edits: withFight(w.edits as RecipeEdit[], fight) })));
  });

  app.post('/api/tweak', localOnly, async (c) => {
    const req = TweakRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!req.success) return c.json({ error: 'bad request' }, 400);
    let recipe;
    try {
      recipe = asFighter(req.data.recipe).recipe;
    } catch {
      return c.json({ error: 'bad request' }, 400);
    }
    const r: TweakRequest = { ...req.data, recipe };
    return handle(c, () =>
      twice(() => model.tweak(r), TweakCheck, (w): TweakResult =>
        w.status === 'declined'
          ? { status: 'declined', message: w.message || 'Let’s try a different change!' }
          : { status: 'ok', edits: withFight(w.edits as RecipeEdit[], w.fight), cards: w.cards, note: w.note }),
    );
  });

  return app;
}
