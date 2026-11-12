import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceClient } from '../../src/announcer/voice';

/** A context that "decodes" any bytes into a buffer as long as the first byte, and lets tests end or watch playing sources. */
const fakeContext = () => {
  const sources: { buffer: { duration: number }; started: number[]; stopped: number; onended: (() => void) | null }[] = [];
  const ctx = {
    currentTime: 0,
    decodeAudioData: async (b: ArrayBuffer) => ({ duration: new Uint8Array(b)[0] }),
    createBufferSource() {
      const s = { buffer: { duration: 0 }, started: [] as number[], stopped: 0, onended: null as (() => void) | null, connect() {}, disconnect() {}, start(_w: number, off: number) { s.started.push(off); }, stop() { s.stopped++; } };
      sources.push(s);
      return s;
    },
  };
  return { ctx: ctx as unknown as BaseAudioContext & { currentTime: number }, sources };
};
const ok = (n = 3) => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([n]).buffer, json: async () => ({ ok: true, ready: true }) }) as unknown as Response;
const bad = (status: number) => ({ ok: false, status, json: async () => ({ error: 'loading' }) }) as unknown as Response;
const flush = () => new Promise((r) => setTimeout(r, 0));
const make = (f: typeof fetch, extra: { timeoutMs?: number } = {}) => {
  const c = fakeContext();
  return { ...c, v: new VoiceClient({ fetch: f, ctx: c.ctx, out: {} as AudioNode, ...extra }) };
};

afterEach(() => vi.useRealTimers());

describe('VoiceClient', () => {
  it('is available only when GET /api/voice answers ok', async () => {
    const yes = make(vi.fn(async () => ok()) as never);
    await yes.v.check();
    expect(yes.v.available).toBe('yes');
    for (const f of [async () => bad(404), async () => { throw new Error('offline'); }]) {
      const no = make(vi.fn(f) as never);
      expect(no.v.available).toBe('unknown');
      await no.v.check();
      expect(no.v.available).toBe('no');
    }
  });

  it('checks again after a failure, with a growing wait capped at 30 s, until the server answers', async () => {
    vi.useFakeTimers();
    let up = false;
    const f = vi.fn(async () => { if (!up) throw new Error('offline'); return ok(); });
    const { v } = make(f as never);
    await v.check();
    expect(v.available).toBe('no');
    await vi.advanceTimersByTimeAsync(2000);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(30000); // never waits longer than 30 s
    const calls = f.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(9);
    up = true;
    await vi.advanceTimersByTimeAsync(30000);
    expect(v.available).toBe('yes');
    await vi.advanceTimersByTimeAsync(120000);
    expect(f.mock.calls.length).toBe(calls + 1); // and stops asking
  });

  it('speaks a line that was prefetched, for the decoded duration', async () => {
    const { v, sources } = make(vi.fn(async () => ok(4)) as never);
    v.prefetch('hello');
    await flush();
    const end = vi.fn();
    expect(v.play('hello', end)).toEqual({ spoken: true, seconds: 4 });
    expect(sources).toHaveLength(1);
    sources[0].onended!();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('is words only when the audio is not ready, and never starts that line later', async () => {
    const { v, sources } = make(vi.fn(async () => ok()) as never);
    v.prefetch('late');
    const end = vi.fn();
    expect(v.play('late', end)).toEqual({ spoken: false, seconds: 0 });
    await flush();
    expect(sources).toHaveLength(0);
    expect(end).not.toHaveBeenCalled();
  });

  it('treats a 503 or a 500 as words only, and the next line still tries', async () => {
    const replies = [bad(503), bad(500), ok(2)];
    const { v } = make(vi.fn(async () => replies.shift()!) as never);
    v.prefetch('a');
    v.prefetch('b');
    v.prefetch('c');
    await flush();
    expect(v.play('a', () => {}).spoken).toBe(false);
    expect(v.play('b', () => {}).spoken).toBe(false);
    expect(v.play('c', () => {}).spoken).toBe(true);
  });

  it('gives up on a request that never answers after the timeout (8 s by default)', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const f = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => ((aborted = true), rej(new Error('abort')))))) as never;
    const { v } = make(f);
    v.prefetch('slow');
    await vi.advanceTimersByTimeAsync(7900);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(aborted).toBe(true);
    expect(v.play('slow', () => {}).spoken).toBe(false);
    v.prefetch('slow'); // not stuck: it tries again
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('stops a playing line and calls onEnd exactly once', async () => {
    const { v, sources } = make(vi.fn(async () => ok()) as never);
    v.prefetch('x');
    await flush();
    const end = vi.fn();
    v.play('x', end);
    v.stop();
    sources[0].onended?.();
    v.stop();
    expect(end).toHaveBeenCalledTimes(1);
    expect(sources[0].stopped).toBe(1);
  });

  it('pauses where it is and carries on from there', async () => {
    const { v, ctx, sources } = make(vi.fn(async () => ok(10)) as never);
    v.prefetch('x');
    await flush();
    const end = vi.fn();
    v.play('x', end);
    ctx.currentTime = 4;
    v.pause(true);
    ctx.currentTime = 30;
    v.pause(false);
    expect(sources).toHaveLength(2);
    expect(sources[1].started).toEqual([4]);
    sources[1].onended!();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('says nothing without a sound context', async () => {
    const f = vi.fn(async () => ok());
    const v = new VoiceClient({ fetch: f as never, ctx: null, out: null });
    v.prefetch('x');
    await flush();
    expect(f).not.toHaveBeenCalled();
    expect(v.play('x', () => {})).toEqual({ spoken: false, seconds: 0 });
  });

  it('keeps only the 64 most recently used lines', async () => {
    const { v } = make(vi.fn(async () => ok()) as never);
    for (let i = 0; i < 65; i++) v.prefetch(`line ${i}`);
    await flush();
    expect(v.play('line 0', () => {}).spoken).toBe(false);
    expect(v.play('line 64', () => {}).spoken).toBe(true);
  });
});

describe('VoiceClient and the announcer voice', () => {
  it('asks for the announcer voice and pace explicitly', async () => {
    const f = vi.fn(async () => ok());
    const { v } = make(f as never);
    v.prefetch('hi');
    await flush();
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ text: 'hi', voice: 'am_michael', speed: 1.12 });
  });

  it('reports a line as ready only once decoded', async () => {
    const { v } = make(vi.fn(async () => ok()) as never);
    v.prefetch('x');
    expect(v.isReady('x')).toBe(false);
    await flush();
    expect(v.isReady('x')).toBe(true);
  });

  it('retries a 503 loading with backoff, then the line can speak', async () => {
    vi.useFakeTimers();
    const replies = [bad(503), bad(503), ok(2)];
    const f = vi.fn(async () => replies.shift()!);
    const { v } = make(f as never);
    v.prefetch('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(v.play('late', () => {}).spoken).toBe(false);
    await vi.advanceTimersByTimeAsync(1900);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200); // first wait: 2 s
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3700);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200); // second wait: 4 s
    expect(f).toHaveBeenCalledTimes(3);
    expect(v.isReady('late')).toBe(true);
  });

  it('gives up after the last wait, and does not retry other failures', async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => bad(503));
    const { v } = make(f as never);
    v.prefetch('never');
    await vi.advanceTimersByTimeAsync(60000);
    expect(f).toHaveBeenCalledTimes(5);
    const g = vi.fn(async () => bad(500));
    const w = make(g as never);
    w.v.prefetch('broken');
    await vi.advanceTimersByTimeAsync(60000);
    expect(g).toHaveBeenCalledTimes(1);
  });
});
