import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, DesignerInvalid, DesignerResting } from '../../src/designer/api';

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const words = { image: null, words: 'a spotty snail' };

/** What a call throws (or null when it answers). */
async function thrown(): Promise<unknown> {
  try {
    await api.read(words);
    return null;
  } catch (e) {
    return e;
  }
}

describe('the designer client says why the designer is resting', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a rejected API key', async () => {
    vi.stubGlobal('fetch', answer(503, { error: 'resting', reason: 'key' }));
    const e = await thrown();
    expect(e).toBeInstanceOf(DesignerResting);
    expect((e as DesignerResting).reason).toBe('key');
  });

  it("today's limit, a busy or unreachable designer", async () => {
    vi.stubGlobal('fetch', answer(429, { error: 'resting' }));
    expect(((await thrown()) as DesignerResting).reason).toBe('limit');
    vi.stubGlobal('fetch', answer(503, { error: 'resting' }));
    expect(((await thrown()) as DesignerResting).reason).toBe('busy');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed to fetch'); }));
    expect(((await thrown()) as DesignerResting).reason).toBe('network');
  });

  it('a muddled answer is still DesignerInvalid', async () => {
    vi.stubGlobal('fetch', answer(422, { error: 'invalid' }));
    expect(await thrown()).toBeInstanceOf(DesignerInvalid);
  });
});
