import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhoneMsg } from '../../src/bring/protocol';
import { connect, storedSession } from '../../src/phone/client';

const maker = { name: 'Zig', badge: '🦊' };

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

class FakeES {
  static all: FakeES[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeES.all.push(this); }
  close() { this.closed = true; }
  emit(m: PhoneMsg) { this.onmessage?.({ data: JSON.stringify(m) }); }
  static get last() { return FakeES.all[FakeES.all.length - 1]; }
}
const ES = FakeES as unknown as typeof EventSource;

type Reply = { status?: number; json: unknown } | 'throw';
type Call = { url: string; body: unknown };
/** A fake server: `routes` maps a path to what it answers (status + json, or a network failure). */
function fakeFetch(routes: Record<string, () => Reply>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const r = routes[url.split('?')[0]]?.();
    if (r === 'throw' || !r) throw new TypeError('offline');
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.json } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

beforeEach(() => { FakeES.all = []; vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('connect: join', () => {
  it('joins, stores token, code and maker, opens the stream and reports its messages', async () => {
    const store = memoryStore();
    const { fn, calls } = fakeFetch({ '/api/relay/join': () => ({ json: { token: 'tok1' } }) });
    const got: PhoneMsg[] = [];
    const c = connect(store, (m) => got.push(m), () => undefined, fn, ES);
    expect(await c.join('abcd', maker)).toBe('ok');
    expect(calls[0]).toEqual({ url: '/api/relay/join', body: { code: 'ABCD', name: 'Zig', badge: '🦊' } });
    expect(JSON.parse(store.getItem('valley-phone')!)).toEqual({ token: 'tok1', code: 'ABCD', maker });
    expect(FakeES.last.url).toBe('/api/relay/phone/events?t=tok1');
    FakeES.last.emit({ type: 'resting' });
    expect(got).toEqual([{ type: 'resting' }]);
    c.close();
  });
  it('a bad code is badCode, stores nothing and opens no stream', async () => {
    const store = memoryStore();
    const { fn } = fakeFetch({ '/api/relay/join': () => ({ status: 404, json: { error: 'badCode' } }) });
    const c = connect(store, () => undefined, () => undefined, fn, ES);
    expect(await c.join('ZZZZ', maker)).toBe('badCode');
    expect(store.m.size).toBe(0);
    expect(FakeES.all).toHaveLength(0);
  });
  it('a refresh rejoins with the stored token, code and maker and opens the stream', async () => {
    const store = memoryStore();
    store.setItem('valley-phone', JSON.stringify({ token: 'tok1', code: 'ABCD', maker }));
    const { fn, calls } = fakeFetch({ '/api/relay/join': () => ({ json: { token: 'tok1' } }) });
    const c = connect(store, () => undefined, () => undefined, fn, ES);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]).toEqual({ url: '/api/relay/join', body: { code: 'ABCD', name: 'Zig', badge: '🦊', token: 'tok1' } });
    expect(FakeES.last.url).toBe('/api/relay/phone/events?t=tok1');
    c.close();
  });
  it('a rejoin the server refuses clears the token and asks for a rescan', async () => {
    const store = memoryStore();
    store.setItem('valley-phone', JSON.stringify({ token: 'old', code: 'ABCD', maker }));
    const { fn } = fakeFetch({ '/api/relay/join': () => ({ status: 404, json: { error: 'badCode' } }) });
    const onRescan = vi.fn();
    connect(store, () => undefined, onRescan, fn, ES);
    await vi.advanceTimersByTimeAsync(0);
    expect(onRescan).toHaveBeenCalledTimes(1);
    expect(store.getItem('valley-phone')).toBeNull();
    expect(FakeES.all).toHaveLength(0);
  });
  it('storedSession reads what was stored, or null', () => {
    const store = memoryStore();
    expect(storedSession(store)).toBeNull();
    store.setItem('valley-phone', 'not json');
    expect(storedSession(store)).toBeNull();
    store.setItem('valley-phone', JSON.stringify({ token: 't', code: 'ABCD', maker }));
    expect(storedSession(store)).toEqual({ token: 't', code: 'ABCD', maker });
  });
});

describe('connect: reconnect', () => {
  async function joined() {
    const store = memoryStore();
    let join: () => Reply = () => ({ json: { token: 'tok1' } });
    const { fn, calls } = fakeFetch({ '/api/relay/join': () => join() });
    const onRescan = vi.fn();
    const c = connect(store, () => undefined, onRescan, fn, ES);
    await c.join('ABCD', maker);
    return { store, c, calls, onRescan, setJoin: (j: () => Reply) => { join = j; } };
  }
  it('reopens the stream with back-off 1, 2, 4, 8, 8 seconds', async () => {
    const { c } = await joined();
    FakeES.last.onerror?.();
    expect(FakeES.all[0].closed).toBe(true);
    for (const wait of [1000, 2000, 4000, 8000, 8000]) {
      const before = FakeES.all.length;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(FakeES.all.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeES.all.length).toBe(before + 1);
      FakeES.last.onerror?.(); // lost again before any message arrived
    }
    c.close();
  });
  it('a failed rejoin (server still down) keeps trying with the same back-off', async () => {
    const { c, setJoin } = await joined();
    setJoin(() => 'throw');
    FakeES.last.onerror?.();
    const n = FakeES.all.length;
    await vi.advanceTimersByTimeAsync(1000); // rejoin attempt 1 fails
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeES.all.length).toBe(n);
    setJoin(() => ({ json: { token: 'tok1' } }));
    await vi.advanceTimersByTimeAsync(1); // attempt 2 at 3 s succeeds
    expect(FakeES.all.length).toBe(n + 1);
    c.close();
  });
  it('a message resets the back-off to 1 second', async () => {
    const { c } = await joined();
    FakeES.last.onerror?.();
    await vi.advanceTimersByTimeAsync(1000);
    FakeES.last.onerror?.();
    await vi.advanceTimersByTimeAsync(2000);
    FakeES.last.emit({ type: 'resting' });
    const n = FakeES.all.length;
    FakeES.last.onerror?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeES.all.length).toBe(n + 1);
    c.close();
  });
  it('rejoins before reopening; a refused rejoin (server restarted) clears the token and asks for a rescan', async () => {
    const { c, store, calls, onRescan, setJoin } = await joined();
    setJoin(() => ({ status: 404, json: { error: 'badCode' } }));
    FakeES.last.onerror?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.at(-1)).toEqual({ url: '/api/relay/join', body: { code: 'ABCD', name: 'Zig', badge: '🦊', token: 'tok1' } });
    expect(onRescan).toHaveBeenCalledTimes(1);
    expect(store.getItem('valley-phone')).toBeNull();
    const n = FakeES.all.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(FakeES.all.length).toBe(n);
    c.close();
  });
  it('a rejoin that hands back a new token stores it and streams with it', async () => {
    const { c, store, setJoin } = await joined();
    setJoin(() => ({ json: { token: 'tok2' } }));
    FakeES.last.onerror?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeES.last.url).toBe('/api/relay/phone/events?t=tok2');
    expect(JSON.parse(store.getItem('valley-phone')!).token).toBe('tok2');
    c.close();
  });
  it('reconnect (screen back on, Wi-Fi back) rejoins now and reopens the stream, even with no error seen', async () => {
    const { c, calls } = await joined();
    const old = FakeES.last;
    const n = FakeES.all.length;
    c.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toEqual({ url: '/api/relay/join', body: { code: 'ABCD', name: 'Zig', badge: '🦊', token: 'tok1' } });
    expect(old.closed).toBe(true);
    expect(FakeES.all.length).toBe(n + 1);
    expect(FakeES.last.closed).toBe(false);
    c.close();
  });
  it('reconnect cancels a pending back-off retry (one stream, not two)', async () => {
    const { c } = await joined();
    FakeES.last.onerror?.();
    for (let i = 0; i < 3; i++) { FakeES.last.onerror?.(); await vi.advanceTimersByTimeAsync(8000); }
    const n = FakeES.all.length;
    FakeES.last.onerror?.(); // a retry is now waiting
    c.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeES.all.length).toBe(n + 1);
    await vi.advanceTimersByTimeAsync(20000);
    expect(FakeES.all.length).toBe(n + 1);
    c.close();
  });
  it('reconnect before joining or after close does nothing', async () => {
    const { fn, calls } = fakeFetch({ '/api/relay/join': () => ({ json: { token: 'tok1' } }) });
    const c = connect(memoryStore(), () => undefined, () => undefined, fn, ES);
    c.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(0);
    await c.join('ABCD', maker);
    c.close();
    c.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
  });
  it('close stops the stream and any pending reconnect', async () => {
    const { c } = await joined();
    FakeES.last.onerror?.();
    c.close();
    const n = FakeES.all.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(FakeES.all.length).toBe(n);
  });
});

describe('connect: actions', () => {
  async function ready(routes: Record<string, () => Reply>) {
    const store = memoryStore();
    const { fn, calls } = fakeFetch({ '/api/relay/join': () => ({ json: { token: 'tok1' } }), ...routes });
    const onRescan = vi.fn();
    const c = connect(store, () => undefined, onRescan, fn, ES);
    await c.join('ABCD', maker);
    return { c, store, calls, onRescan };
  }
  it('submit, tweak, release and cancel post to their routes with the token and return the result', async () => {
    const { c, calls } = await ready({
      '/api/relay/phone/submit': () => ({ json: { result: 'queued' } }),
      '/api/relay/phone/tweak': () => ({ json: { result: 'sent' } }),
      '/api/relay/phone/release': () => ({ json: { result: 'sent' } }),
      '/api/relay/phone/cancel': () => ({ json: { result: 'ok' } }),
    });
    const input = { image: null, words: 'a fox' };
    expect(await c.submit(input)).toBe('queued');
    expect(await c.tweak('bluer')).toBe('sent');
    expect(await c.release()).toBe('sent');
    expect(await c.cancel()).toBe('ok');
    expect(calls.slice(1)).toEqual([
      { url: '/api/relay/phone/submit?t=tok1', body: input },
      { url: '/api/relay/phone/tweak?t=tok1', body: { words: 'bluer' } },
      { url: '/api/relay/phone/release?t=tok1', body: undefined },
      { url: '/api/relay/phone/cancel?t=tok1', body: undefined },
    ]);
    c.close();
  });
  it('an unknown token (404) on an action clears it and asks for a rescan', async () => {
    const { c, store, onRescan } = await ready({ '/api/relay/phone/release': () => ({ status: 404, json: { error: 'unknown' } }) });
    expect(await c.release()).toBe('unknown');
    expect(onRescan).toHaveBeenCalledTimes(1);
    expect(store.getItem('valley-phone')).toBeNull();
    expect(FakeES.last.closed).toBe(true);
  });
  it('a network failure on an action says offline and changes nothing', async () => {
    const { c, store, onRescan } = await ready({ '/api/relay/phone/submit': () => 'throw' });
    expect(await c.submit({ image: null, words: 'x' })).toBe('offline');
    expect(onRescan).not.toHaveBeenCalled();
    expect(store.getItem('valley-phone')).not.toBeNull();
    c.close();
  });
  it('an action before joining is unknown', async () => {
    const { fn } = fakeFetch({});
    const c = connect(memoryStore(), () => undefined, () => undefined, fn, ES);
    expect(await c.release()).toBe('unknown');
  });
});

describe('connect: ring commands (Task 16)', () => {
  async function ready(routes: Record<string, () => Reply>) {
    const store = memoryStore();
    const { fn, calls } = fakeFetch({ '/api/relay/join': () => ({ json: { token: 'tok1' } }), ...routes });
    const onRescan = vi.fn();
    const c = connect(store, () => undefined, onRescan, fn, ES);
    await c.join('ABCD', maker);
    return { c, store, calls, onRescan };
  }
  it('posts the command with the token in the body and returns the result', async () => {
    const { c, calls } = await ready({ '/api/phone/command': () => ({ json: { result: 'sent' } }) });
    expect(await c.command({ kind: 'sendBack', id: 'r1' })).toBe('sent');
    expect(calls.at(-1)).toEqual({ url: '/api/phone/command', body: { token: 'tok1', command: { kind: 'sendBack', id: 'r1' } } });
    c.close();
  });
  it('401 (the TV does not know this phone) clears it and asks for a rescan', async () => {
    const { c, store, onRescan } = await ready({ '/api/phone/command': () => ({ status: 401, json: { error: 'unknown' } }) });
    expect(await c.command({ kind: 'crown' })).toBe('unknown');
    expect(onRescan).toHaveBeenCalledTimes(1);
    expect(store.getItem('valley-phone')).toBeNull();
  });
  it('429 is slow, a network failure offline, and before joining it is unknown', async () => {
    const { c } = await ready({ '/api/phone/command': () => ({ status: 429, json: { error: 'slow' } }) });
    expect(await c.command({ kind: 'again' })).toBe('slow');
    c.close();
    const off = await ready({ '/api/phone/command': () => 'throw' });
    expect(await off.c.command({ kind: 'again' })).toBe('offline');
    off.c.close();
    const { fn } = fakeFetch({});
    expect(await connect(memoryStore(), () => undefined, () => undefined, fn, ES).command({ kind: 'crown' })).toBe('unknown');
  });
});
