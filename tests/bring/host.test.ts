import { beforeEach, describe, expect, it } from 'vitest';
import { HostClient, type HostInfo } from '../../src/bring/host';
import type { HostMsg } from '../../src/bring/protocol';

class FakeES {
  static all: FakeES[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeES.all.push(this); }
  close() { this.closed = true; }
  emit(m: HostMsg) { this.onmessage?.({ data: JSON.stringify(m) }); }
  static get last() { return FakeES.all[FakeES.all.length - 1]; }
}
const ES = FakeES as unknown as typeof EventSource;

type Call = { url: string; body: unknown };
/** A fake server: registering gives h1, h2, ... (or fails while `down`); sends answer `sendStatus`; the status route says `state`. */
function fakeServer() {
  const calls: Call[] = [];
  const s = { down: false, sendStatus: 200, state: 'current', registered: 0, calls };
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (s.down) throw new TypeError('offline');
    if (url === '/api/relay/host') {
      const n = ++s.registered;
      return { ok: true, status: 200, json: async () => ({ hostId: `h${n}`, code: 'ABCD', url: 'http://192.168.1.5:5180/phone.html?c=ABCD', qrSvg: '<svg/>' }) } as Response;
    }
    if (url.startsWith('/api/relay/host/status')) return { ok: true, status: 200, json: async () => ({ state: s.state }) } as Response;
    return { ok: s.sendStatus < 400, status: s.sendStatus, json: async () => ({ ok: true }) } as Response;
  }) as unknown as typeof fetch;
  return Object.assign(s, { fn });
}

/** A sleep that records its waits and resolves on the next tick (so a retry loop cannot starve the test of the event loop). */
const sleeps = () => {
  const waits: number[] = [];
  return { waits, fn: (ms: number) => new Promise<void>((r) => { waits.push(ms); setTimeout(r, 0); }) };
};
const setup = () => {
  const server = fakeServer(), sleep = sleeps();
  const msgs: HostMsg[] = [], status: [string, HostInfo | undefined][] = [], fresh: (boolean | undefined)[] = [];
  const client = new HostClient(
    { onMsg: (m) => msgs.push(m), onStatus: (s, info, f) => (status.push([s, info]), fresh.push(f)) },
    { fetch: server.fn, EventSource: ES, port: 5180, sleep: sleep.fn },
  );
  return { server, sleep, msgs, status, fresh, client };
};
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Wait (a few ticks) for the background retry loop to reach a state. */
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

beforeEach(() => { FakeES.all = []; });

describe('HostClient', () => {
  it('registers with the page port, reports hosting with the card info and opens the stream at once', async () => {
    const { server, status, client } = setup();
    await client.start();
    expect(server.calls[0]).toEqual({ url: '/api/relay/host', body: { port: 5180 } });
    expect(status).toEqual([['hosting', { code: 'ABCD', url: 'http://192.168.1.5:5180/phone.html?c=ABCD', qrSvg: '<svg/>' }]]);
    expect(FakeES.last.url).toBe('/api/relay/host/events?h=h1');
    client.stop();
  });

  it('forwards the relay messages and ignores a garbled one', async () => {
    const { msgs, client } = setup();
    await client.start();
    FakeES.last.emit({ type: 'joined', token: 't1', maker: { name: 'Zig', badge: '🦊' } });
    FakeES.last.onmessage!({ data: '{not json' });
    FakeES.last.emit({ type: 'line', line: [] });
    expect(msgs.map((m) => m.type)).toEqual(['joined', 'line']);
    client.stop();
  });

  it('re-registers after a stream error, waiting 1, 2, 4 ... up to 30 s while the server stays away', async () => {
    const { server, sleep, status, client } = setup();
    await client.start();
    server.down = true; // the server is restarting: every register attempt fails
    FakeES.last.onerror!();
    await until(() => sleep.waits.length >= 8);
    expect(sleep.waits.slice(0, 8)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(status[1][0]).toBe('reconnecting');
    client.stop();
  });

  it('a dropped stream reattaches with its own host id (no new registration); the wait starts over after a message', async () => {
    const { server, sleep, status, fresh, client } = setup();
    await client.start();
    FakeES.last.onerror!();
    await until(() => FakeES.all.length === 2);
    expect(fresh).toEqual([true, undefined, false]); // the same relay: whoever is busy carries on
    expect(sleep.waits).toEqual([1000]);
    expect(FakeES.all[0].closed).toBe(true);
    expect(FakeES.last.url).toBe('/api/relay/host/events?h=h1');
    expect(server.calls.map((c) => c.url)).toEqual(['/api/relay/host', '/api/relay/host/status?h=h1']);
    expect(server.registered).toBe(1);
    expect(status.map(([s]) => s)).toEqual(['hosting', 'reconnecting', 'hosting']);
    expect(status[2][1]).toEqual(status[0][1]); // the card's address is still the same
    FakeES.last.emit({ type: 'hello', code: 'ABCD', url: 'u' }); // the stream works: the next failure waits 1 s again
    FakeES.last.onerror!();
    await until(() => FakeES.all.length === 3);
    expect(sleep.waits).toEqual([1000, 1000]);
    client.stop();
  });

  it('after a server restart (the relay says unknown) it registers afresh and opens the new stream', async () => {
    const { server, status, fresh, client } = setup();
    await client.start();
    server.state = 'unknown';
    FakeES.last.onerror!();
    await until(() => FakeES.all.length === 2);
    expect(server.registered).toBe(2);
    expect(fresh).toEqual([true, undefined, true]); // a new relay: it knows nothing of the phone on stage
    expect(FakeES.last.url).toBe('/api/relay/host/events?h=h2');
    expect(status.map(([s]) => s)).toEqual(['hosting', 'reconnecting', 'hosting']);
    client.stop();
  });

  it('a replaced page whose stream drops does not register again: it reports replaced and stays quiet', async () => {
    const { server, status, client } = setup();
    await client.start();
    server.state = 'replaced';
    FakeES.last.onerror!(); // dropped before the `replaced` message arrived
    await until(() => status.some(([s]) => s === 'replaced'));
    await tick();
    await tick();
    expect(server.registered).toBe(1);
    expect(FakeES.all).toHaveLength(1);
    expect(server.calls.filter((c) => c.url === '/api/relay/host')).toHaveLength(1);
  });

  it('reclaim() registers afresh after replaced (Add a creature in the menu)', async () => {
    const { server, status, client } = setup();
    await client.start();
    FakeES.last.emit({ type: 'replaced' });
    expect(status.map(([s]) => s)).toEqual(['hosting', 'replaced']);
    await client.reclaim();
    expect(server.registered).toBe(2);
    expect(FakeES.last.url).toBe('/api/relay/host/events?h=h2');
    expect(status.map(([s]) => s)).toEqual(['hosting', 'replaced', 'hosting']);
    client.stop();
  });

  it('keeps probing (with the same back-off) while the relay cannot be reached, then reattaches', async () => {
    const { server, sleep, client } = setup();
    await client.start();
    server.down = true;
    FakeES.last.onerror!();
    await until(() => sleep.waits.length >= 3);
    server.down = false;
    await until(() => FakeES.all.length === 2);
    expect(FakeES.last.url).toBe('/api/relay/host/events?h=h1');
    expect(server.registered).toBe(1);
    client.stop();
  });

  it('a first registration that fails is retried the same way', async () => {
    const { server, sleep, client } = setup();
    server.down = true;
    await client.start();
    expect(FakeES.all).toHaveLength(0);
    await until(() => sleep.waits.length >= 2);
    server.down = false;
    await until(() => FakeES.all.length === 1);
    expect(sleep.waits.slice(0, 2)).toEqual([1000, 2000]);
    client.stop();
  });

  it('stops for good on replaced: reports it, closes the stream and never registers again', async () => {
    const { server, status, msgs, client } = setup();
    await client.start();
    FakeES.last.emit({ type: 'replaced' });
    FakeES.last.onerror!(); // the closing stream may error afterwards
    await tick();
    await tick();
    expect(status.map(([s]) => s)).toEqual(['hosting', 'replaced']);
    expect(msgs).toEqual([]); // `replaced` is a status, not a message for the workshop
    expect(FakeES.last.closed).toBe(true);
    expect(server.registered).toBe(1);
  });

  it('stop() during a back-off cancels the re-register', async () => {
    const { server, client } = setup();
    await client.start();
    FakeES.last.onerror!();
    client.stop();
    await tick();
    await tick();
    expect(server.registered).toBe(1);
  });

  it('sends to the phone on stage: POST with the host id and the token', async () => {
    const { server, client } = setup();
    await client.start();
    expect(await client.send('t1', { type: 'released' })).toBe(true);
    expect(server.calls.at(-1)).toEqual({ url: '/api/relay/host/send?h=h1', body: { token: 't1', type: 'released' } });
    server.sendStatus = 404;
    expect(await client.send('t1', { type: 'kept' })).toBe(false);
    server.down = true;
    expect(await client.send('t1', { type: 'kept' })).toBe(false);
    client.stop();
  });

  it('cannot send before it is registered', async () => {
    const { client } = setup();
    expect(await client.send('t1', { type: 'released' })).toBe(false);
  });
});

describe('HostClient: the ring and phone commands (Task 16)', () => {
  const fighter = (id: string, crowns = 0) => ({ id, name: id, maker: 'Zig', crowns, thumb: null });

  it('sendRing posts the phase, how many fight and the roster (no token), capped at 60 with champions first', async () => {
    const { server, client } = setup();
    expect(await client.sendRing('open', 1, [fighter('a')])).toBe(false); // not registered yet
    await client.start();
    const roster = Array.from({ length: 70 }, (_, i) => fighter(`r${i}`, i === 65 ? 1 : 0));
    expect(await client.sendRing('crowned', 3, roster)).toBe(true);
    const call = server.calls.at(-1)!;
    expect(call.url).toBe('/api/relay/host/send?h=h1');
    const body = call.body as { type: string; phase: string; fighting: number; roster: { id: string }[] };
    expect([body.type, body.phase, body.fighting]).toEqual(['ring', 'crowned', 3]);
    expect(body.roster).toHaveLength(60);
    expect(body.roster[0].id).toBe('r65');
    expect('token' in body).toBe(false);
    client.stop();
  });

  it('sendRing checks each entry: a bad thumb is dropped, an entry that cannot be sent is left out, the rest still go', async () => {
    const { server, client } = setup();
    await client.start();
    const good = { ...fighter('ok'), thumb: 'data:image/jpeg;base64,AAAA' };
    const bigThumb = { ...fighter('big'), thumb: `data:image/jpeg;base64,${'A'.repeat(20_000)}` };
    const badId = fighter('x'.repeat(65));
    expect(await client.sendRing('open', 1, [good, bigThumb, badId])).toBe(true);
    const body = server.calls.at(-1)!.body as { roster: unknown[] };
    expect(body.roster).toEqual([good, { ...fighter('big'), thumb: null }]);
    client.stop();
  });

  it('after a fresh registration it sends the last ring again (a restarted relay forgot it)', async () => {
    const { server, client } = setup();
    await client.start();
    await client.sendRing('open', 2, [fighter('a')]);
    server.state = 'unknown';
    FakeES.last.onerror!();
    await until(() => server.registered === 2 && server.calls.filter((c) => (c.body as { type?: string } | undefined)?.type === 'ring').length === 2);
    expect(server.calls.at(-1)).toEqual({ url: '/api/relay/host/send?h=h2', body: { type: 'ring', phase: 'open', fighting: 2, roster: [fighter('a')] } });
    client.stop();
  });

  it('onCommand hears phone commands (they do not go to onMsg); the returned function stops it', async () => {
    const { msgs, client } = setup();
    await client.start();
    const got: [string, unknown][] = [];
    const off = client.onCommand((token, command) => got.push([token, command]));
    FakeES.last.emit({ type: 'command', token: 't1', command: { kind: 'crown' } });
    FakeES.last.emit({ type: 'command', token: 't2', command: { kind: 'sendBack', id: 'r9' } });
    expect(got).toEqual([['t1', { kind: 'crown' }], ['t2', { kind: 'sendBack', id: 'r9' }]]);
    expect(msgs.some((m) => m.type === 'command')).toBe(false);
    off();
    FakeES.last.emit({ type: 'command', token: 't1', command: { kind: 'again' } });
    expect(got).toHaveLength(2);
    client.stop();
  });
});
