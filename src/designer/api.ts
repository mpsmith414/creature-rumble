import type { KidCards, LookAgainRequest, LookAgainResult, ReadRequest, ReadResult, TweakRequest, TweakResult } from './types';

/** Why the designer rests: its API key was rejected, today's limit is reached, it is busy or down, or unreachable. */
export type RestingReason = 'key' | 'limit' | 'busy' | 'network';

/** The designer can't be reached right now (offline, busy, no key). */
export class DesignerResting extends Error {
  constructor(message: string, readonly reason: RestingReason = 'busy') {
    super(message);
  }
}
/** The designer's answer couldn't be used, even after a retry. */
export class DesignerInvalid extends Error {}

async function call<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new DesignerResting('network', 'network');
  }
  if (res.status === 422) throw new DesignerInvalid('invalid');
  if (!res.ok) {
    const said = (await res.json().catch(() => null)) as { reason?: unknown } | null;
    throw new DesignerResting(String(res.status), said?.reason === 'key' ? 'key' : res.status === 429 ? 'limit' : 'busy');
  }
  return (await res.json()) as T;
}

export type DesignerApi = {
  read(r: ReadRequest): Promise<ReadResult>;
  lookAgain(r: LookAgainRequest): Promise<LookAgainResult>;
  tweak(r: TweakRequest): Promise<TweakResult>;
};

export const api: DesignerApi = {
  read: (r) => call('/api/read', r),
  lookAgain: (r) => call('/api/look-again', r),
  tweak: (r) => call('/api/tweak', r),
};

export async function designerModel(): Promise<string | null> {
  try {
    const h = (await (await fetch('/api/health')).json()) as { model?: string };
    return h.model ?? null;
  } catch {
    return null;
  }
}

export type { KidCards };
