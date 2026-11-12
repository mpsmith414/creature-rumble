/// <reference lib="webworker" />
import type { Recipe } from '../recipe/schema';
import { buildBody, type BodyData } from './build';
import { bodyCacheKey, loadBody, saveBody } from './cache';
import { transferables } from './pool';

export type BuildRequest = { id: number; recipe: Recipe };
/** `ms`: the time to read or build the body; `cached`: it came from the saved-bodies cache. */
export type BuildResponse = { id: number; body?: BodyData; ms?: number; cached?: boolean; error?: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async ({ data }: MessageEvent<BuildRequest>) => {
  try {
    const t0 = performance.now();
    const key = bodyCacheKey(data.recipe), hit = await loadBody(key);
    const t1 = performance.now(); // a build is timed from its own start, not from the cache look-up (or other requests) before it
    const body = hit ?? buildBody(data.recipe);
    const ms = performance.now() - (hit ? t0 : t1);
    if (!hit) await saveBody(key, body); // before the transfer below empties the buffers
    scope.postMessage({ id: data.id, body, ms, cached: !!hit } satisfies BuildResponse, transferables(body));
  } catch (e) {
    scope.postMessage({ id: data.id, error: e instanceof Error ? e.message : String(e) } satisfies BuildResponse);
  }
};
