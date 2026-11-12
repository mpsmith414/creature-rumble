import { describe, expect, it } from 'vitest';
import { createApp } from '../../server/app';
import { DailyCap } from '../../server/cap';
import { lanHost, phoneHost, phoneUrl } from '../../server/net';
import { Relay } from '../../server/relay';
import { BADGES, type HostMsg, type PhoneMsg } from '../../src/bring/protocol';

const cards = { name: 'Bob', eats: 'flowers 🌸', speed: 'slow 🐌', mood: 'shy 🙈', special: 'six legs' };
const model = { model: 'fake', read: async () => ({}), lookAgain: async () => ({}), tweak: async () => ({}) };

function setup(opts: { cap?: DailyCap; heartbeatMs?: number; now?: () => number } = {}) {
  let n = 0;
  const relay = new Relay({ now: opts.now ?? (() => 0), id: () => `id${++n}`, code: 'ABCD' });
  const cap = opts.cap ?? new DailyCap({});
  /** Where the next requests come from (the TV on this PC by default). */
  const from = { address: '127.0.0.1' as string | undefined };
  const app = createApp(model, { cap, relay, host: () => '192.168.1.20', heartbeatMs: opts.heartbeatMs, address: () => from.address });
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { app, relay, cap, post, from };
}

/** Reads an SSE response as it streams: `until` resolves with the first `data:` message that passes the test. */
function reader(res: Response) {
  const r = res.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  let done = false;
  const parse = () => text.split('\n\n').flatMap((b) => {
    const line = b.split('\n').find((l) => l.startsWith('data: '));
    return line ? [JSON.parse(line.slice(6))] : [];
  });
  const more = async () => {
    const { value, done: d } = await r.read();
    if (d) done = true; else text += dec.decode(value);
  };
  return {
    async until<M>(test: (m: M) => boolean): Promise<M> {
      for (;;) {
        const hit = (parse() as M[]).find(test);
        if (hit) return hit;
        if (done) throw new Error(`stream ended before the message came; got ${text}`);
        await more();
      }
    },
    async untilText(s: string) { while (!text.includes(s)) { if (done) throw new Error(`ended; got ${text}`); await more(); } return text; },
    all: () => parse() as HostMsg[],
    cancel: () => r.cancel(),
  };
}

async function register(s: ReturnType<typeof setup>) {
  const res = await s.post('/api/relay/host', { port: 5180 });
  expect(res.status).toBe(200);
  const host = await res.json();
  const events = reader(await s.app.request(`/api/relay/host/events?h=${host.hostId}`));
  return { host, events };
}

async function joinPhone(s: ReturnType<typeof setup>, name = 'Doodle') {
  const res = await s.post('/api/relay/join', { code: 'abcd', name, badge: BADGES[2] });
  expect(res.status).toBe(200);
  const { token } = await res.json();
  const events = reader(await s.app.request(`/api/relay/phone/events?t=${token}`));
  return { token, events };
}

/** Aborts are noticed a moment after a cancel, so wait for the relay to show it. */
async function until(test: () => boolean) {
  for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(test()).toBe(true);
}

describe('relay routes', () => {
  it('registers a host with a join link and a QR code, and streams its hello', async () => {
    const s = setup();
    const { host, events } = await register(s);
    expect(host.code).toBe('ABCD');
    expect(host.url).toBe('http://192.168.1.20:5180/phone.html?c=ABCD');
    expect(host.qrSvg.startsWith('<svg')).toBe(true);
    expect(await events.until<HostMsg>((m) => m.type === 'hello')).toEqual({ type: 'hello', code: 'ABCD', url: host.url });
    await events.cancel();
  });

  it('carries a submit from the phone to the host as a turn', async () => {
    const s = setup();
    const { events: hostEvents } = await register(s);
    const { token, events: phoneEvents } = await joinPhone(s);
    const sub = await s.post(`/api/relay/phone/submit?t=${token}`, { image: null, words: 'a fuzzy frog' });
    expect(await sub.json()).toEqual({ result: 'queued' });
    const turn = await hostEvents.until<HostMsg>((m) => m.type === 'turn');
    expect(turn).toEqual({ type: 'turn', token, maker: { name: 'Doodle', badge: BADGES[2] }, input: { image: null, words: 'a fuzzy frog' } });
    expect(await phoneEvents.until<PhoneMsg>((m) => m.type === 'hello')).toEqual({ type: 'hello', state: { phase: 'idle' } });
    await Promise.all([hostEvents.cancel(), phoneEvents.cancel()]);
  });

  it('carries a host preview to the phone, and a tweak, release, cancel and leave back', async () => {
    const s = setup();
    const { host, events: hostEvents } = await register(s);
    const { token, events: phoneEvents } = await joinPhone(s);
    await s.post(`/api/relay/phone/submit?t=${token}`, { image: null, words: 'a frog' });
    await hostEvents.until<HostMsg>((m) => m.type === 'turn');
    const sent = await s.post(`/api/relay/host/send?h=${host.hostId}`, { token, type: 'preview', cards });
    expect(await sent.json()).toEqual({ ok: true });
    expect(await phoneEvents.until<PhoneMsg>((m) => m.type === 'preview')).toEqual({ type: 'preview', cards, tweaksLeft: 5 });

    expect(await (await s.post(`/api/relay/phone/tweak?t=${token}`, { words: 'bluer' })).json()).toEqual({ result: 'sent' });
    expect(await hostEvents.until<HostMsg>((m) => m.type === 'tweak')).toEqual({ type: 'tweak', token, words: 'bluer' });
    expect(await (await s.post(`/api/relay/phone/release?t=${token}`)).json()).toEqual({ result: 'sent' });
    await hostEvents.until<HostMsg>((m) => m.type === 'release');
    expect(await (await s.post(`/api/relay/phone/cancel?t=${token}`)).json()).toEqual({ result: 'ok' });
    await hostEvents.until<HostMsg>((m) => m.type === 'cancel');
    expect(await (await s.post(`/api/relay/phone/leave?t=${token}`)).json()).toEqual({ result: 'ok' });
    await hostEvents.until<HostMsg>((m) => m.type === 'left');
    await Promise.all([hostEvents.cancel(), phoneEvents.cancel()]);
  });

  it('delivers a turn made after the host registered but before its stream opened', async () => {
    const s = setup();
    const host = await (await s.post('/api/relay/host', { port: 5180 })).json();
    const { token } = await (await s.post('/api/relay/join', { code: 'ABCD', name: 'Doodle', badge: BADGES[0] })).json();
    await s.post(`/api/relay/phone/submit?t=${token}`, { image: null, words: 'a frog' });
    const events = reader(await s.app.request(`/api/relay/host/events?h=${host.hostId}`));
    expect((await events.until<HostMsg>((m) => m.type === 'turn')).type).toBe('turn');
    await events.cancel();
  });

  it('trims a name to 12 characters and falls back to the first badge', async () => {
    const s = setup();
    const { events } = await register(s);
    await s.post('/api/relay/join', { code: 'ABCD', name: '  Bartholomew the Great ', badge: 'nope' });
    const joined = await events.until<Extract<HostMsg, { type: 'joined' }>>((m) => m.type === 'joined');
    expect(joined.maker).toEqual({ name: 'Bartholomew ', badge: BADGES[0] });
    await events.cancel();
  });

  it('answers a bad code, an unknown token and an unknown host with 404', async () => {
    const s = setup();
    await register(s);
    const bad = await s.post('/api/relay/join', { code: 'ZZZZ', name: 'Doodle', badge: BADGES[0] });
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual({ error: 'badCode' });
    const stream = await s.app.request('/api/relay/phone/events?t=nobody');
    expect(stream.status).toBe(404);
    expect(await stream.json()).toEqual({ error: 'unknown' });
    const sub = await s.post('/api/relay/phone/submit?t=nobody', { image: null, words: 'x' });
    expect(sub.status).toBe(404);
    expect(await sub.json()).toEqual({ error: 'unknown' });
    const noHost = await s.app.request('/api/relay/host/events?h=nobody');
    expect(noHost.status).toBe(404);
    expect(await noHost.json()).toEqual({ error: 'unknown' });
    expect((await s.post('/api/relay/host/send?h=nobody', { token: 't', type: 'released' })).status).toBe(404);
  });

  it('answers a replaced host id with 404 and tells the first host', async () => {
    const s = setup();
    const first = await register(s);
    const second = await (await s.post('/api/relay/host', { port: 5180 })).json();
    await first.events.until<HostMsg>((m) => m.type === 'replaced');
    const gone = await s.app.request(`/api/relay/host/events?h=${first.host.hostId}`);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'replaced' }); // not 'unknown': that one means the relay restarted
    expect(second.hostId).not.toBe(first.host.hostId);
    await first.events.cancel();
  });

  it('says whether a host id is current, replaced or unknown', async () => {
    const s = setup();
    const first = await register(s);
    const state = async (h: string) => (await (await s.app.request(`/api/relay/host/status?h=${h}`)).json()).state;
    expect(await state(first.host.hostId)).toBe('current');
    const second = await (await s.post('/api/relay/host', { port: 5180 })).json();
    expect(await state(first.host.hostId)).toBe('replaced');
    expect(await state(second.hostId)).toBe('current');
    expect(await state('before-the-restart')).toBe('unknown');
    await first.events.cancel();
  });

  it('a dropped host stream reattaches with its own id and nobody is told they were replaced', async () => {
    const s = setup();
    const { host, events } = await register(s);
    await events.cancel();
    await new Promise((r) => setTimeout(r, 10));
    const again = reader(await s.app.request(`/api/relay/host/events?h=${host.hostId}`));
    expect((await again.until<HostMsg>((m) => m.type === 'hello')).type).toBe('hello');
    expect(s.relay.hostState(host.hostId)).toBe('current');
    await again.cancel();
  });

  it('tells a reloaded valley about phones that joined earlier, once each', async () => {
    const s = setup();
    const { events: before } = await register(s);
    await joinPhone(s, 'Doodle');
    await joinPhone(s, 'Bo');
    await before.cancel();
    const { events } = await register(s); // the valley page was reloaded
    await joinPhone(s, 'Cy'); // heard live, after the two announced ones
    await events.until<HostMsg>((m) => m.type === 'joined' && m.maker.name === 'Cy');
    expect(events.all().flatMap((m) => (m.type === 'joined' ? [m.maker.name] : []))).toEqual(['Doodle', 'Bo', 'Cy']);
    await events.cancel();
  });

  it('rejects bodies that do not fit with 400', async () => {
    const s = setup();
    const { host } = await register(s);
    expect((await s.post('/api/relay/host', { port: 'x' })).status).toBe(400);
    expect((await s.post('/api/relay/join', { code: 'ABCD' })).status).toBe(400);
    const { token } = await (await s.post('/api/relay/join', { code: 'ABCD', name: 'Doodle', badge: BADGES[0] })).json();
    expect((await s.post(`/api/relay/phone/submit?t=${token}`, { words: 5 })).status).toBe(400);
    expect((await s.post(`/api/relay/phone/tweak?t=${token}`, {})).status).toBe(400);
    expect((await s.post(`/api/relay/host/send?h=${host.hostId}`, { token, type: 'bogus' })).status).toBe(400);
  });

  it('tells a phone to rest when the daily cap is used up', async () => {
    const cap = new DailyCap({});
    cap.setLimit(5);
    for (let i = 0; i < 5; i++) cap.take();
    const s = setup({ cap });
    await register(s);
    const { token, events } = await joinPhone(s);
    expect(await (await s.post(`/api/relay/phone/submit?t=${token}`, { image: null, words: 'a frog' })).json()).toEqual({ result: 'resting' });
    expect(await events.until<PhoneMsg>((m) => m.type === 'resting')).toEqual({ type: 'resting' });
    await events.cancel();
  });

  it('a phone whose page closed is away after three quiet minutes: the valley hears left, and joined when it comes back', async () => {
    let t = 0;
    const s = setup({ now: () => t });
    const { events } = await register(s);
    const phone = await joinPhone(s);
    await phone.events.until<PhoneMsg>((m) => m.type === 'hello');
    await events.until<HostMsg>((m) => m.type === 'joined');
    await phone.events.cancel(); // the tab closes
    // the abort reaches the relay a moment later (the close counts as activity): from then, three minutes and a tick
    let left: HostMsg | null = null;
    void events.until<HostMsg>((m) => m.type === 'left').then((m) => (left = m));
    await until(() => {
      t += 180001;
      s.relay.tick();
      return left !== null;
    });
    expect(left).toEqual({ type: 'left', token: phone.token });
    const back = await s.post('/api/relay/join', { code: 'ABCD', name: 'Doodle', badge: BADGES[2], token: phone.token });
    expect(await back.json()).toEqual({ token: phone.token }); // its place in the relay was never lost
    const joined = () => events.all().filter((x) => x.type === 'joined');
    await events.until<HostMsg>(() => joined().length === 2); // the first join, and this one
    expect(joined().at(-1)).toEqual({ type: 'joined', token: phone.token, maker: { name: 'Doodle', badge: BADGES[2] } });
    await events.cancel();
  });

  it('sends a ping comment on the heartbeat, and a closed stream lets a phone reattach', async () => {
    const s = setup({ heartbeatMs: 20 });
    await register(s);
    const { token, events } = await joinPhone(s);
    expect(await events.untilText(': ping')).toContain(': ping');
    await events.cancel();
    const again = reader(await s.app.request(`/api/relay/phone/events?t=${token}`));
    expect(await again.until<PhoneMsg>((m) => m.type === 'hello')).toEqual({ type: 'hello', state: { phase: 'idle' } });
    await again.cancel();
  });

  it('detaches the host when its stream closes, but not when an older stream closes late', async () => {
    const s = setup();
    const { host, events } = await register(s);
    expect(s.relay.hasHost()).toBe(true);
    await events.cancel();
    await until(() => !s.relay.hasHost());
    const { token, events: phoneEvents } = await joinPhone(s);
    expect(await phoneEvents.until<PhoneMsg>((m) => m.type === 'noHost')).toEqual({ type: 'noHost' });
    await phoneEvents.cancel();
    expect(token).toBeTruthy();

    // a reconnect before the old connection aborts: closing the old one must leave the new one attached
    const first = reader(await s.app.request(`/api/relay/host/events?h=${host.hostId}`));
    await first.until<HostMsg>((m) => m.type === 'hello');
    const second = reader(await s.app.request(`/api/relay/host/events?h=${host.hostId}`));
    await second.until<HostMsg>((m) => m.type === 'hello');
    await first.cancel();
    await new Promise((r) => setTimeout(r, 50));
    expect(s.relay.hasHost()).toBe(true);
    await second.cancel();
    await until(() => !s.relay.hasHost());
  });

  it('keeps a phone attached when an older stream of it closes late', async () => {
    const s = setup();
    await register(s);
    const { token, events: first } = await joinPhone(s);
    const second = reader(await s.app.request(`/api/relay/phone/events?t=${token}`));
    await second.until<PhoneMsg>((m) => m.type === 'hello');
    await first.cancel();
    await new Promise((r) => setTimeout(r, 50));
    await s.post(`/api/relay/phone/submit?t=${token}`, { image: null, words: 'a frog' });
    expect(await second.until<PhoneMsg>((m) => m.type === 'line')).toEqual({ type: 'line', place: 0, ahead: [] });
    await second.cancel();
  });
});

describe('relay routes: phone commands and the ring (Task 16)', () => {
  const command = (s: ReturnType<typeof setup>, body: unknown) => s.post('/api/phone/command', body);
  const fighter = { id: 'r1', name: 'Zib', maker: 'Doodle', crowns: 1, thumb: 'data:image/jpeg;base64,AAAA' };

  it('a phone command with a known token reaches the host stream', async () => {
    const s = setup();
    const { events: hostEvents } = await register(s);
    const { token, events: phoneEvents } = await joinPhone(s);
    const res = await command(s, { token, command: { kind: 'sendBack', id: 'r1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'sent' });
    expect(await hostEvents.until<HostMsg>((m) => m.type === 'command')).toEqual({ type: 'command', token, command: { kind: 'sendBack', id: 'r1' } });
    await Promise.all([hostEvents.cancel(), phoneEvents.cancel()]);
  });

  it('an unknown token gets 401 and nothing reaches the host', async () => {
    const s = setup();
    const { events: hostEvents } = await register(s);
    const res = await command(s, { token: 'nope', command: { kind: 'crown' } });
    expect(res.status).toBe(401);
    expect(hostEvents.all().some((m) => m.type === 'command')).toBe(false);
    await hostEvents.cancel();
  });

  it('a badly shaped command is 400: unknown kinds, a sendBack id that is not a short string, no token', async () => {
    const s = setup();
    await register(s);
    const { token, events } = await joinPhone(s);
    for (const body of [
      { token, command: { kind: 'explode' } }, { token, command: { kind: 'sendBack', id: 42 } },
      { token, command: { kind: 'sendBack', id: 'x'.repeat(65) } }, { token, command: { kind: 'sendBack' } },
      { token }, { command: { kind: 'crown' } }, { token: 7, command: { kind: 'crown' } }, 'crown',
    ]) expect((await command(s, body)).status, JSON.stringify(body)).toBe(400);
    const junk = await s.app.request('/api/phone/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(junk.status).toBe(400);
    await events.cancel();
  });

  it('mashing is slowed: the sixth command within a second is 429', async () => {
    let t = 0;
    const s = setup({ now: () => t });
    await register(s);
    const { token, events } = await joinPhone(s);
    for (let i = 0; i < 5; i++) expect((await command(s, { token, command: { kind: 'crown' } })).status).toBe(200);
    expect((await command(s, { token, command: { kind: 'crown' } })).status).toBe(429);
    t = 1001;
    expect((await command(s, { token, command: { kind: 'crown' } })).status).toBe(200);
    await events.cancel();
  });

  it('the host sends the ring (no token needed) and every phone hears it', async () => {
    const s = setup();
    const { host, events: hostEvents } = await register(s);
    const a = await joinPhone(s, 'Doodle'), b = await joinPhone(s, 'Bo');
    const ring = { type: 'ring', phase: 'open', fighting: 1, roster: [fighter] };
    const res = await s.post(`/api/relay/host/send?h=${host.hostId}`, ring);
    expect(await res.json()).toEqual({ ok: true });
    for (const p of [a, b]) expect(await p.events.until<PhoneMsg>((m) => m.type === 'ring')).toEqual(ring);
    expect((await s.post(`/api/relay/host/send?h=other`, ring)).status).toBe(404);
    expect((await s.post(`/api/relay/host/send?h=${host.hostId}`, { ...ring, phase: 'nope' })).status).toBe(400);
    expect((await s.post(`/api/relay/host/send?h=${host.hostId}`, { type: 'released' })).status).toBe(400); // a stage message still needs its token
    await Promise.all([hostEvents.cancel(), a.events.cancel(), b.events.cancel()]);
  });
});

describe('relay routes: only the PC itself may host (Task 16 review)', () => {
  it('a LAN address gets 403 on every host route and on POST /api/cap; loopback is accepted', async () => {
    const s = setup();
    const { host, events } = await register(s); // from 127.0.0.1
    await events.cancel();
    s.from.address = '192.168.1.44';
    expect((await s.post('/api/relay/host', { port: 5180 })).status).toBe(403);
    expect((await s.app.request(`/api/relay/host/events?h=${host.hostId}`)).status).toBe(403);
    expect((await s.app.request(`/api/relay/host/status?h=${host.hostId}`)).status).toBe(403);
    expect((await s.post(`/api/relay/host/send?h=${host.hostId}`, { type: 'ring', phase: 'open', fighting: 9, roster: [] })).status).toBe(403);
    expect((await s.post('/api/cap', { limit: 20 })).status).toBe(403);
    expect(s.cap.state().limit).toBe(10);
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      s.from.address = address;
      expect((await s.app.request(`/api/relay/host/status?h=${host.hostId}`)).status, address).toBe(200);
    }
    expect((await s.post('/api/cap', { limit: 20 })).status).toBe(200);
  });

  it('an unknown address is refused (fail closed)', async () => {
    const s = setup();
    s.from.address = undefined;
    expect((await s.post('/api/relay/host', { port: 5180 })).status).toBe(403);
  });

  it('through the dev proxy (loopback socket) the forwarded-for address counts: its last entry, which the proxy added', async () => {
    const s = setup();
    expect((await s.post('/api/relay/host', { port: 5180 }, { 'x-forwarded-for': '::1' })).status).toBe(200);
    expect((await s.post('/api/relay/host', { port: 5180 }, { 'x-forwarded-for': '192.168.1.44' })).status).toBe(403);
    // a phone claiming to be local: the proxy appends the real address after its claim
    expect((await s.post('/api/relay/host', { port: 5180 }, { 'x-forwarded-for': '127.0.0.1,192.168.1.44' })).status).toBe(403);
    // a LAN socket's own forwarded-for is not believed
    s.from.address = '192.168.1.44';
    expect((await s.post('/api/relay/host', { port: 5180 }, { 'x-forwarded-for': '127.0.0.1' })).status).toBe(403);
  });

  it('phones stay open to the LAN', async () => {
    const s = setup();
    await register(s);
    s.from.address = '192.168.1.44';
    const { token, events } = await joinPhone(s);
    expect((await s.post('/api/phone/command', { token, command: { kind: 'crown' } })).status).toBe(200);
    expect((await s.post(`/api/relay/phone/submit?t=${token}`, { image: null, words: 'a frog' })).status).toBe(200);
    expect((await s.app.request('/api/cap')).status).toBe(200);
    await events.cancel();
  });
});

describe('lanHost and phoneUrl', () => {
  const iface = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal, netmask: '', mac: '', cidr: null });
  const ifaces = { lo: [iface('127.0.0.1', true)], auto: [iface('169.254.3.4')], eth0: [iface('192.168.1.20')], other: [iface('10.0.0.5')] };

  it('picks the first private address, not link-local or loopback', () => {
    expect(lanHost(ifaces)).toBe('192.168.1.20');
    expect(lanHost({ a: [iface('172.20.1.1')] })).toBe('172.20.1.1');
    expect(lanHost({ a: [iface('172.32.1.1')] })).toBe('localhost');
    expect(lanHost({})).toBe('localhost');
  });

  it('honours the override', () => {
    expect(lanHost(ifaces, 'tv.local')).toBe('tv.local');
  });

  it('reads the PHONE_HOST override from the environment', () => {
    expect(phoneHost({ PHONE_HOST: 'tv.local' }, ifaces)).toBe('tv.local');
    expect(phoneHost({}, ifaces)).toBe('192.168.1.20');
  });

  it('builds the phone link', () => {
    expect(phoneUrl('192.168.1.20', 5180, 'ABCD')).toBe('http://192.168.1.20:5180/phone.html?c=ABCD');
  });
});
