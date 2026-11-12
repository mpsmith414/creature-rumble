import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { createApp } from './app';
import { DailyCap } from './cap';
import { createClaudeModel } from './model';
import { phoneHost } from './net';
import { Relay } from './relay';
import { kokoroSynth, VoiceCache } from './voice';

/** The API both entry points serve (`server/index.ts` for dev, `server/home.ts` for home mode): the designer, the daily cap, the phone relay and the narrator's voice. */
export function makeServer(env: NodeJS.ProcessEnv): { app: Hono; model: string; workspaceId?: string; keyFound: boolean } {
  // Sonnet 5.5 by default; set DESIGNER_MODEL=claude-opus-5-5 for the stronger (pricier) eye.
  const model = env.DESIGNER_MODEL || 'claude-sonnet-5-5';
  // only needed for a key that works across workspaces (Console → Settings → Workspaces, the wrkspc_… ID)
  const workspaceId = env.ANTHROPIC_WORKSPACE_ID?.trim() || undefined;
  const relay = new Relay({ now: Date.now, id: () => randomUUID() });
  const app = createApp(createClaudeModel({ model, workspaceId }), { cap: new DailyCap({ file: 'data/daily.json' }), relay, host: () => phoneHost(env),
    // each announcer voice starts loading on first use, in the background: until it is ready /api/voice answers 503 `loading`
    voice: { synth: (voice) => kokoroSynth({ voice }), cache: new VoiceCache('data/voice') } });
  // the relay has no timers of its own: this finds a preview nobody has touched for two minutes
  setInterval(() => relay.tick(), 10000);
  return { app, model, workspaceId, keyFound: !!env.ANTHROPIC_API_KEY };
}
