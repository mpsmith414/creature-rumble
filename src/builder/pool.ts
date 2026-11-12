import type { BodyData } from './build';

/**
 * The worker to give the next request to: the one with the fewest pending, ties to the lowest index.
 * A dead worker counts as Infinity; -1 when none is left.
 */
export function pickWorker(pending: readonly number[]): number {
  let best = -1;
  for (let i = 0; i < pending.length; i++) if (pending[i] < Infinity && (best < 0 || pending[i] < pending[best])) best = i;
  return best;
}

/** Every typed array buffer in a body's LODs, each once (a repeated buffer in a transfer list is an error). */
export function transferables(body: BodyData): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const lod of body.lods) for (const v of Object.values(lod)) if (ArrayBuffer.isView(v)) out.add(v.buffer as ArrayBuffer);
  return [...out];
}
