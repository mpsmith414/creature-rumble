import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  LookAgainWire, ReadWire, TweakWire,
  type ImageIn, type LookAgainRequest, type ReadRequest, type TweakRequest,
} from '../src/designer/types';
import { READ_INSTRUCTION, SYSTEM_PROMPT, lookAgainInstruction, tweakInstruction } from './prompts';

/** Raw model output for each request; the app validates and normalises it. */
export interface DesignerModel {
  readonly model: string;
  read(r: ReadRequest): Promise<unknown>;
  lookAgain(r: LookAgainRequest): Promise<unknown>;
  tweak(r: TweakRequest): Promise<unknown>;
}

export class Declined extends Error {}

type Effort = 'low' | 'medium' | 'high';
type Block = Anthropic.Beta.BetaContentBlockParam;

const image = (img: ImageIn): Block => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
const text = (t: string): Block => ({ type: 'text', text: t });

/** The answer format for each request, written into the instructions (stable text, so it caches). */
const formatBlock = (schema: z.ZodType) =>
  `Reply with exactly one JSON object and nothing else (no prose, no code fences). It must match this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}`;
const FORMATS = { read: formatBlock(ReadWire), lookAgain: formatBlock(LookAgainWire), tweak: formatBlock(TweakWire) };

/** Pull the JSON object out of a reply (tolerating stray code fences or a sentence around it). */
export function extractJson(reply: string): unknown {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * The designer backed by Claude: vision in, JSON out. The recipe schema is too large for
 * constrained decoding, so the schema goes in the instructions and the app checks every answer
 * (validate, normalise, one retry). Server-side refusal fallbacks (`fallbacks: 'default'`) retry
 * a declined request on a fallback model within the same call.
 */
export function createClaudeModel(opts: { model: string; effort?: Effort; client?: Anthropic; workspaceId?: string }): DesignerModel {
  // a key that works across several workspaces must say which one every request runs in
  const client = opts.client ?? new Anthropic(opts.workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': opts.workspaceId } } : {});
  const effort = opts.effort ?? 'medium';

  async function ask(kind: keyof typeof FORMATS, content: Block[]): Promise<unknown> {
    const response = await client.beta.messages
      .stream({
        model: opts.model,
        max_tokens: 32000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort },
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: FORMATS[kind], cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content }],
      }, { timeout: 90_000, maxRetries: 1 })
      .finalMessage();
    if (response.stop_reason === 'refusal') throw new Declined('refused');
    const reply = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return extractJson(reply);
  }

  return {
    model: opts.model,
    read(r) {
      const content: Block[] = [];
      if (r.image) content.push(text('This is the drawing:'), image(r.image));
      if (r.words.trim()) content.push(text(`The child says: "${r.words.trim()}"`));
      content.push(text(READ_INSTRUCTION));
      return ask('read', content);
    },
    lookAgain(r) {
      const content: Block[] = [];
      if (r.image) content.push(text('The original drawing:'), image(r.image));
      if (r.words.trim()) content.push(text(`The child said: "${r.words.trim()}"`));
      content.push(text('What I built:'), image(r.render));
      content.push(text(`The current recipe: ${JSON.stringify(r.recipe)}`));
      content.push(text(lookAgainInstruction(r.pass, r.checklist)));
      return ask('lookAgain', content);
    },
    tweak(r) {
      return ask('tweak', [
        text(`The current recipe: ${JSON.stringify(r.recipe)}`),
        text(`The current cards: ${JSON.stringify(r.cards)}`),
        text(tweakInstruction(r.words)),
      ]);
    },
  };
}
