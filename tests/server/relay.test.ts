import { describe, expect, it } from 'vitest';
import { Relay } from '../../server/relay';
import {
  BADGES, CODE_LETTERS, HostSendSchema, PhoneCommandSchema, RING_ROSTER_MAX, ringEntry, ringRoster,
  type DesignInput, type HostSend, type HostMsg, type PhoneMsg, type RingEntry,
} from '../../src/bring/protocol';

const cards = { name: 'Bob', eats: 'flowers 🌸', speed: 'slow 🐌', mood: 'shy 🙈', special: 'six legs' };
const cards2 = { ...cards, name: 'Bobby' };
const input = (words = 'a fuzzy frog'): DesignInput => ({ image: null, words });
const maker = (name: string, badge = BADGES[0]) => ({ name, badge });

/** A relay on a fake clock and a counter id, a host with a recording sink, and phones that join and record. */
function setup(opts: { quietMs?: number; awayMs?: number; maxTweaks?: number; host?: boolean } = {}) {
  let t = 0;
  let n = 0;
  const relay = new Relay({ now: () => t, id: () => `id${++n}`, code: 'ABCD', ...opts });
  const host: HostMsg[] = [];
  const hostSink = (m: HostMsg) => host.push(m);
  const hostId = opts.host === false ? '' : relay.registerHost(hostSink, 'http://tv:5180/phone.html');
  const phones: Record<string, { token: string; msgs: PhoneMsg[]; sink: (m: PhoneMsg) => void }> = {};
  const join = (name: string) => {
    const r = relay.join('ABCD', maker(name));
    if ('error' in r) throw new Error('join failed');
    const msgs: PhoneMsg[] = [];
    const sink = (m: PhoneMsg) => msgs.push(m);
    relay.phoneStream(r.token, sink);
    phones[name] = { token: r.token, msgs, sink };
    return phones[name];
  };
  const send = (token: string, msg: HostSend) => relay.fromHost(hostId, { ...msg, token });
  return { relay, host, hostId, hostSink, phones, join, send, time: (ms: number) => { t = ms; }, clearAll: () => { host.length = 0; for (const p of Object.values(phones)) p.msgs.length = 0; } };
}

describe('protocol', () => {
  it('has twelve badges and join letters without I, L, O', () => {
    expect(BADGES).toHaveLength(12);
    expect(CODE_LETTERS).not.toMatch(/[ILO]/);
    expect(CODE_LETTERS).toHaveLength(23);
  });

  it('HostSendSchema accepts the six host messages and rejects others', () => {
    for (const m of [
      { type: 'step', step: { kind: 'reading' } }, { type: 'step', step: { kind: 'looking', pass: 1 } },
      { type: 'step', step: { kind: 'fixing', pass: 2, note: 'longer tail' } },
      { type: 'preview', cards }, { type: 'tweaked', cards, note: 'ok' }, { type: 'released' }, { type: 'kept' },
      { type: 'failed', message: 'oops', retry: true },
    ]) expect(HostSendSchema.safeParse(m).success, JSON.stringify(m)).toBe(true);
    expect(HostSendSchema.safeParse({ type: 'turn' }).success).toBe(false);
    expect(HostSendSchema.safeParse({ type: 'step', step: { kind: 'dancing' } }).success).toBe(false);
    expect(HostSendSchema.safeParse({ type: 'failed', message: 'x' }).success).toBe(false);
  });
});

describe('Relay codes and joining', () => {
  it('makes a 4-letter code from the allowed letters', () => {
    for (let i = 0; i < 50; i++) {
      const r = new Relay({ now: () => 0, id: () => 'x' });
      expect(r.code).toMatch(new RegExp(`^[${CODE_LETTERS}]{4}$`));
    }
  });

  it('joins with the right code (any case), refuses a wrong one, and tells the host', () => {
    const s = setup();
    expect(s.relay.join('WXYZ', maker('Ann'))).toEqual({ error: 'badCode' });
    expect(s.relay.join('abcd', maker('Ann'))).toEqual({ token: 'id2' });
    expect(s.host.slice(1)).toEqual([{ type: 'joined', token: 'id2', maker: maker('Ann') }]);
  });

  it('rejoining with a known token gives the same token and keeps phase and place', () => {
    const s = setup();
    const a = s.join('Ann');
    const b = s.join('Bo');
    s.relay.submit(a.token, input(), false);
    s.relay.submit(b.token, input(), false);
    expect(s.relay.join('ABCD', maker('Bo again'), b.token)).toEqual({ token: b.token });
    expect(s.relay.snapshot(b.token)).toEqual({ phase: 'waiting', place: 1 });
    expect(s.relay.snapshot(a.token)).toEqual({ phase: 'making' });
  });

  it('a stale token with the right code gets a fresh one', () => {
    const s = setup();
    const r = s.relay.join('ABCD', maker('Ann'), 'old');
    expect(r).toEqual({ token: 'id2' });
  });
});

describe('Relay streams', () => {
  it('sends hello with the snapshot first, and refuses an unknown token', () => {
    const s = setup();
    const a = s.join('Ann');
    expect(a.msgs).toEqual([{ type: 'hello', state: { phase: 'idle' } }]);
    expect(s.relay.phoneStream('nope', () => {})).toBe(false);
    expect(s.relay.snapshot('nope')).toBeNull();
  });

  it('hello is followed by noHost when no valley is open, and a fresh hello arrives when one registers', () => {
    const s = setup({ host: false });
    const a = s.join('Ann');
    expect(a.msgs).toEqual([{ type: 'hello', state: { phase: 'idle' } }, { type: 'noHost' }]);
    expect(s.relay.hasHost()).toBe(false);
    expect(s.relay.submit(a.token, input(), false)).toBe('noHost');
    a.msgs.length = 0;
    const host: HostMsg[] = [];
    s.relay.registerHost((m) => host.push(m), 'u');
    expect(s.relay.hasHost()).toBe(true);
    expect(a.msgs).toEqual([{ type: 'hello', state: { phase: 'idle' } }]);
    expect(host[0]).toEqual({ type: 'hello', code: 'ABCD', url: 'u' });
  });

  it('the host stream attaches, detaches and refuses other ids', () => {
    const s = setup();
    expect(s.relay.hostStream('other', () => {})).toBe(false);
    const got: HostMsg[] = [];
    s.relay.detachHost(s.hostId, s.hostSink);
    expect(s.relay.hasHost()).toBe(false);
    expect(s.relay.hostStream(s.hostId, (m) => got.push(m))).toBe(true);
    expect(got).toEqual([{ type: 'hello', code: 'ABCD', url: 'http://tv:5180/phone.html' }]);
    expect(s.relay.hasHost()).toBe(true);
  });
});

describe('Relay submit and the line', () => {
  it('goes straight on stage when the stage is free', () => {
    const s = setup();
    const a = s.join('Ann');
    s.clearAll();
    expect(s.relay.submit(a.token, input('hi'), false)).toBe('queued');
    expect(s.host).toEqual([{ type: 'turn', token: a.token, maker: maker('Ann'), input: input('hi') }, { type: 'line', line: [] }]);
    expect(a.msgs).toEqual([{ type: 'line', place: 0, ahead: [] }]);
    expect(s.relay.snapshot(a.token)).toEqual({ phase: 'making' });
  });

  it('two phones: B waits at place 1 with A ahead; A released starts B', () => {
    const s = setup();
    const a = s.join('Ann');
    const b = s.join('Bo');
    s.relay.submit(a.token, input('A'), false);
    s.clearAll();
    expect(s.relay.submit(b.token, input('B'), false)).toBe('queued');
    expect(b.msgs).toEqual([{ type: 'line', place: 1, ahead: [maker('Ann')] }]);
    expect(s.host).toEqual([{ type: 'line', line: [{ token: b.token, maker: maker('Bo') }] }]);
    expect(s.relay.snapshot(b.token)).toEqual({ phase: 'waiting', place: 1 });
    s.clearAll();
    expect(s.send(a.token, { type: 'released' })).toBe(true);
    expect(a.msgs).toEqual([{ type: 'released' }]);
    expect(s.host).toEqual([{ type: 'turn', token: b.token, maker: maker('Bo'), input: input('B') }, { type: 'line', line: [] }]);
    expect(b.msgs).toEqual([{ type: 'line', place: 0, ahead: [] }]);
  });

  it('three phones: places and makers ahead update as the line moves', () => {
    const s = setup();
    const [a, b, c] = ['Ann', 'Bo', 'Cy'].map((n) => s.join(n));
    for (const p of [a, b, c]) s.relay.submit(p.token, input(), false);
    expect(c.msgs.at(-1)).toEqual({ type: 'line', place: 2, ahead: [maker('Ann'), maker('Bo')] });
    s.clearAll();
    s.send(a.token, { type: 'kept' });
    expect(b.msgs).toEqual([{ type: 'line', place: 0, ahead: [] }]);
    expect(c.msgs).toEqual([{ type: 'line', place: 1, ahead: [maker('Bo')] }]);
  });

  it('busy while waiting, making or previewing; allowed again after the turn ends', () => {
    const s = setup();
    const a = s.join('Ann');
    expect(s.relay.submit(a.token, input(), false)).toBe('queued');
    expect(s.relay.submit(a.token, input(), false)).toBe('busy');
    s.send(a.token, { type: 'preview', cards });
    expect(s.relay.submit(a.token, input(), false)).toBe('busy');
    s.send(a.token, { type: 'released' });
    expect(s.relay.submit(a.token, input(), false)).toBe('queued');
  });

  it('unknown token; a full cap is resting and queues nothing', () => {
    const s = setup();
    expect(s.relay.submit('nope', input(), false)).toBe('unknown');
    const a = s.join('Ann');
    s.clearAll();
    expect(s.relay.submit(a.token, input(), true)).toBe('resting');
    expect(a.msgs).toEqual([{ type: 'resting' }]);
    expect(s.host).toEqual([]);
    expect(s.relay.snapshot(a.token)).toEqual({ phase: 'resting' });
    expect(s.relay.submit(a.token, input(), false)).toBe('queued');
  });

  it('a waiting phone leaving the line updates the others', () => {
    const s = setup();
    const [a, b, c] = ['Ann', 'Bo', 'Cy'].map((n) => s.join(n));
    for (const p of [a, b, c]) s.relay.submit(p.token, input(), false);
    s.clearAll();
    expect(s.relay.cancel(b.token)).toBe('ok');
    expect(c.msgs).toEqual([{ type: 'line', place: 1, ahead: [maker('Ann')] }]);
    expect(b.msgs).toEqual([]);
    expect(s.host).toEqual([{ type: 'line', line: [{ token: c.token, maker: maker('Cy') }] }]);
    expect(s.relay.snapshot(b.token)).toEqual({ phase: 'idle' });
  });
});

describe('Relay the turn on stage', () => {
  it('forwards step, preview and tweaked, counting tweaks left', () => {
    const s = setup();
    const a = s.join('Ann');
    s.relay.submit(a.token, input(), false);
    s.clearAll();
    s.send(a.token, { type: 'step', step: { kind: 'reading' } });
    s.send(a.token, { type: 'preview', cards });
    expect(s.relay.tweak(a.token, 'bigger ears')).toBe('sent');
    s.send(a.token, { type: 'step', step: { kind: 'fixing', pass: 1, note: 'ears' } });
    s.send(a.token, { type: 'tweaked', cards: cards2, note: 'bigger ears!' });
    expect(a.msgs).toEqual([
      { type: 'step', step: { kind: 'reading' } },
      { type: 'preview', cards, tweaksLeft: 5 },
      { type: 'step', step: { kind: 'fixing', pass: 1, note: 'ears' } },
      { type: 'tweaked', cards: cards2, note: 'bigger ears!', tweaksLeft: 4 },
    ]);
    expect(s.host).toEqual([{ type: 'tweak', token: a.token, words: 'bigger ears' }]);
    expect(s.relay.snapshot(a.token)).toEqual({ phase: 'preview', cards: cards2, tweaksLeft: 4 });
  });

  it('allows at most maxTweaks tweaks, then limit', () => {
    const s = setup({ maxTweaks: 2 });
    const a = s.join('Ann');
    s.relay.submit(a.token, input(), false);
    s.send(a.token, { type: 'preview', cards });
    expect(s.relay.tweak(a.token, 'one')).toBe('sent');
    expect(s.relay.tweak(a.token, 'two')).toBe('sent');
    s.clearAll();
    expect(s.relay.tweak(a.token, 'three')).toBe('limit');
    expect(s.host).toEqual([]);
  });

  it('the default is five tweaks', () => {
    const s = setup();
    const a = s.join('Ann');
    s.relay.submit(a.token, input(), false);
    for (let i = 0; i < 5; i++) expect(s.relay.tweak(a.token, `t${i}`)).toBe('sent');
    expect(s.relay.tweak(a.token, 'six')).toBe('limit');
  });

  it('tweak and release only work for the phone on stage', () => {
    const s = setup();
    const a = s.join('Ann');
    const b = s.join('Bo');
    s.relay.submit(a.token, input(), false);
    s.relay.submit(b.token, input(), false);
    s.clearAll();
    expect(s.relay.tweak(b.token, 'x')).toBe('notOnStage');
    expect(s.relay.release(b.token)).toBe('notOnStage');
    expect(s.relay.tweak('nope', 'x')).toBe('unknown');
    expect(s.relay.release('nope')).toBe('unknown');
    expect(s.relay.release(a.token)).toBe('sent');
    expect(s.host).toEqual([{ type: 'release', token: a.token }]);
  });

  it('released, kept and failed each end the turn and start the next', () => {
    for (const end of [{ type: 'released' }, { type: 'kept' }, { type: 'failed', message: 'oops', retry: true }] as const) {
      const s = setup();
      const a = s.join('Ann');
      const b = s.join('Bo');
      s.relay.submit(a.token, input(), false);
      s.relay.submit(b.token, input(), false);
      s.clearAll();
      expect(s.send(a.token, end)).toBe(true);
      expect(a.msgs).toEqual([end]);
      expect(s.host[0]).toMatchObject({ type: 'turn', token: b.token });
      expect(s.relay.snapshot(a.token)).toEqual({ phase: end.type === 'failed' ? 'idle' : end.type });
    }
  });

  it('ignores a message for a token not on stage, and from a non-host id', () => {
    const s = setup();
    const a = s.join('Ann');
    const b = s.join('Bo');
    s.relay.submit(a.token, input(), false);
    s.relay.submit(b.token, input(), false);
    s.clearAll();
    expect(s.send(b.token, { type: 'released' })).toBe(false);
    expect(s.relay.fromHost('someone-else', { type: 'released', token: a.token })).toBe(false);
    expect(s.send('nope', { type: 'released' })).toBe(false);
    expect(a.msgs).toEqual([]);
    expect(b.msgs).toEqual([]);
    expect(s.relay.snapshot(b.token)).toEqual({ phase: 'waiting', place: 1 });
  });
});

describe('Relay cancel and leave', () => {
  it('cancel from the on-stage phone tells the host and frees the stage only when the host answers', () => {
    const s = setup();
    const a = s.join('Ann');
    const b = s.join('Bo');
    s.relay.submit(a.token, input(), false);
    s.relay.submit(b.token, input(), false);
    s.clearAll();
    expect(s.relay.cancel(a.token)).toBe('ok');
    expect(s.host).toEqual([{ type: 'cancel', token: a.token }]);
    expect(b.msgs).toEqual([]);
    expect(s.relay.cancel(a.token)).toBe('ok'); // asking twice does not tell the host twice
    expect(s.relay.tweak(a.token, 'late')).toBe('notOnStage');
    expect(s.host).toHaveLength(1);
    s.clearAll();
    s.send(a.token, { type: 'kept' });
    expect(a.msgs).toEqual([{ type: 'kept' }]);
    expect(s.host[0]).toMatchObject({ type: 'turn', token: b.token });
    expect(b.msgs).toEqual([{ type: 'line', place: 0, ahead: [] }]);
  });

  it('cancel for an unknown token; cancel when idle does nothing', () => {
    const s = setup();
    const a = s.join('Ann');
    s.clearAll();
    expect(s.relay.cancel('nope')).toBe('unknown');
    expect(s.relay.cancel(a.token)).toBe('ok');
    expect(s.host).toEqual([]);
  });

  it('leave forgets a waiting phone', () => {
    const s = setup();
    const a = s.join('Ann');
    const b = s.join('Bo');
    s.relay.submit(a.token, input(), false);
    s.relay.submit(b.token, input(), false);
    s.clearAll();
    s.relay.leave(b.token);
    expect(s.relay.snapshot(b.token)).toBeNull();
    expect(s.host).toEqual([{ type: 'line', line: [] }, { type: 'left', token: b.token }]);
    expect(s.relay.submit(b.token, input(), false)).toBe('unknown');
  });

  it('leave of the on-stage phone cancels it and the host answering starts the next', () => {
    const s = setup();
    const a = s.join('Ann');
    const b = s.join('Bo');
    s.relay.submit(a.token, input(), false);
    s.relay.submit(b.token, input(), false);
    s.clearAll();
    s.relay.leave(a.token);
    expect(s.host).toEqual([{ type: 'cancel', token: a.token }, { type: 'left', token: a.token }]);
    expect(s.relay.snapshot(a.token)).toBeNull();
    s.clearAll();
    expect(s.send(a.token, { type: 'kept' })).toBe(true);
    expect(s.host[0]).toMatchObject({ type: 'turn', token: b.token });
  });
});

describe('Relay tick (the quiet timeout)', () => {
  it('a preview quiet for quietMs: host gets cancel, phone gets kept, and the host answering starts the next', () => {
    const s = setup({ quietMs: 1000 });
    const a = s.join('Ann');
    const b = s.join('Bo');
    s.relay.submit(a.token, input(), false);
    s.relay.submit(b.token, input(), false);
    s.time(500);
    s.send(a.token, { type: 'preview', cards });
    s.clearAll();
    s.time(1500);
    s.relay.tick();
    expect(s.host).toEqual([]); // not yet: 1000 ms since the preview, not older than quietMs
    s.time(1501);
    s.relay.tick();
    expect(s.host).toEqual([{ type: 'cancel', token: a.token }]);
    expect(a.msgs).toEqual([{ type: 'kept' }]);
    s.relay.tick();
    expect(s.host).toHaveLength(1); // only once
    expect(s.relay.snapshot(a.token)).toEqual({ phase: 'kept' });
    s.clearAll();
    s.send(a.token, { type: 'kept' }); // the host's answer: no second `kept` to the phone
    expect(a.msgs).toEqual([]);
    expect(s.host[0]).toMatchObject({ type: 'turn', token: b.token });
  });

  it('any request from the phone keeps it alive', () => {
    const s = setup({ quietMs: 1000 });
    const a = s.join('Ann');
    s.relay.submit(a.token, input(), false);
    s.send(a.token, { type: 'preview', cards });
    s.time(900);
    s.relay.tweak(a.token, 'hat');
    s.time(1800);
    s.relay.tick();
    expect(s.relay.snapshot(a.token)).toMatchObject({ phase: 'preview' });
    s.time(1901);
    s.relay.tick();
    expect(s.relay.snapshot(a.token)).toEqual({ phase: 'kept' });
  });

  it('a new stream (a rejoin) counts as activity', () => {
    const s = setup({ quietMs: 1000 });
    const a = s.join('Ann');
    s.relay.submit(a.token, input(), false);
    s.send(a.token, { type: 'preview', cards });
    s.time(900);
    s.relay.detachPhone(a.token, a.sink);
    s.time(1500);
    s.relay.phoneStream(a.token, (m) => a.msgs.push(m));
    s.time(2400);
    s.relay.tick();
    expect(s.relay.snapshot(a.token)).toMatchObject({ phase: 'preview' });
  });

  it('only a preview times out, not a creature being made, and the default is two minutes', () => {
    const s = setup();
    const a = s.join('Ann');
    s.relay.submit(a.token, input(), false);
    s.time(10 * 60000);
    s.relay.tick();
    expect(s.relay.snapshot(a.token)).toEqual({ phase: 'making' });
    s.send(a.token, { type: 'preview', cards });
    s.time(10 * 60000 + 120000);
    s.relay.tick();
    expect(s.relay.snapshot(a.token)).toMatchObject({ phase: 'preview' });
    s.time(10 * 60000 + 120001);
    s.relay.tick();
    expect(s.relay.snapshot(a.token)).toEqual({ phase: 'kept' });
  });
});

describe('Relay host replacement', () => {
  it('a second host replaces the first: old gets replaced, line and code are kept, the turn is made again', () => {
    const s = setup();
    const a = s.join('Ann');
    const b = s.join('Bo');
    s.relay.submit(a.token, input('A'), false);
    s.relay.submit(b.token, input('B'), false);
    s.send(a.token, { type: 'preview', cards });
    s.clearAll();
    const second: HostMsg[] = [];
    const id2 = s.relay.registerHost((m) => second.push(m), 'u2');
    expect(s.host).toEqual([{ type: 'replaced' }]);
    expect(second).toEqual([
      { type: 'hello', code: 'ABCD', url: 'u2' },
      { type: 'joined', token: a.token, maker: maker('Ann') },
      { type: 'joined', token: b.token, maker: maker('Bo') },
      { type: 'line', line: [{ token: b.token, maker: maker('Bo') }] },
      { type: 'turn', token: a.token, maker: maker('Ann'), input: input('A') },
    ]);
    expect(s.relay.code).toBe('ABCD');
    expect(s.relay.snapshot(b.token)).toEqual({ phase: 'waiting', place: 1 });
    // the old host is out; the new one is in charge
    expect(s.send(a.token, { type: 'released' })).toBe(false);
    expect(s.relay.fromHost(id2, { type: 'released', token: a.token })).toBe(true);
    expect(second.at(-2)).toMatchObject({ type: 'turn', token: b.token });
  });

  it('replacing the host when nobody is on stage replays no turn, only who is connected', () => {
    const s = setup();
    const a = s.join('Ann');
    const second: HostMsg[] = [];
    s.relay.registerHost((m) => second.push(m), 'u2');
    expect(second).toEqual([{ type: 'hello', code: 'ABCD', url: 'u2' }, { type: 'joined', token: a.token, maker: maker('Ann') }]);
  });

  it('a reattached host stream hears the turn it missed while detached', () => {
    const s = setup();
    const a = s.join('Ann');
    s.relay.detachHost(s.hostId, s.hostSink);
    expect(s.relay.submit(a.token, input(), false)).toBe('noHost');
    const got: HostMsg[] = [];
    s.relay.hostStream(s.hostId, (m) => got.push(m));
    expect(got).toEqual([{ type: 'hello', code: 'ABCD', url: 'http://tv:5180/phone.html' }, { type: 'joined', token: a.token, maker: maker('Ann') }]);
  });

  it('re-announces every connected phone, then the line, to a newly registered or re-attached host', () => {
    const s = setup();
    const a = s.join('Ann');
    const b = s.join('Bo');
    s.join('Cy');
    s.relay.submit(b.token, input('B'), false); // Bo is on stage, Cy idle
    s.relay.submit(a.token, input('A'), false); // Ann waits
    const names = (l: HostMsg[]) => l.flatMap((m) => (m.type === 'joined' ? [m.maker.name] : []));
    const fresh: HostMsg[] = [];
    const id2 = s.relay.registerHost((m) => fresh.push(m), 'u2');
    expect(names(fresh)).toEqual(['Ann', 'Bo', 'Cy']);
    expect(fresh.findIndex((m) => m.type === 'line')).toBeGreaterThan(fresh.findLastIndex((m) => m.type === 'joined'));
    const again: HostMsg[] = [];
    s.relay.hostStream(id2, (m) => again.push(m));
    expect(names(again)).toEqual(['Ann', 'Bo', 'Cy']);
    s.relay.leave(a.token);
    const after: HostMsg[] = [];
    s.relay.hostStream(id2, (m) => after.push(m));
    expect(names(after)).toEqual(['Bo', 'Cy']); // a phone that left is not announced
  });

  it('knows its hosts: current, replaced by a newer page, or never heard of', () => {
    const s = setup();
    expect(s.relay.hostState(s.hostId)).toBe('current');
    const id2 = s.relay.registerHost(() => undefined, 'u2');
    expect(s.relay.hostState(s.hostId)).toBe('replaced');
    expect(s.relay.hostState(id2)).toBe('current');
    expect(s.relay.hostState('from-before-the-restart')).toBe('unknown');
    // a dropped stream reattaches without the relay telling anyone they were replaced
    s.host.length = 0;
    s.relay.detachHost(id2, () => undefined);
    expect(s.relay.hostStream(id2, () => undefined)).toBe(true);
    expect(s.host).toEqual([]);
    expect(s.relay.hostStream(s.hostId, () => undefined)).toBe(false);
  });
});

describe('Relay snapshot', () => {
  it('describes every phase so a rejoining phone restores its screen', () => {
    const s = setup();
    const a = s.join('Ann');
    const b = s.join('Bo');
    expect(s.relay.snapshot(a.token)).toEqual({ phase: 'idle' });
    s.relay.submit(a.token, input(), false);
    s.relay.submit(b.token, input(), false);
    expect(s.relay.snapshot(a.token)).toEqual({ phase: 'making' });
    expect(s.relay.snapshot(b.token)).toEqual({ phase: 'waiting', place: 1 });
    s.send(a.token, { type: 'preview', cards });
    expect(s.relay.snapshot(a.token)).toEqual({ phase: 'preview', cards, tweaksLeft: 5 });
    s.send(a.token, { type: 'released' });
    expect(s.relay.snapshot(a.token)).toEqual({ phase: 'released' });
  });

  it('a phone that rejoins mid-preview gets a hello with the same cards and tweaks left', () => {
    const s = setup();
    const a = s.join('Ann');
    s.relay.submit(a.token, input(), false);
    s.send(a.token, { type: 'preview', cards });
    s.relay.tweak(a.token, 'x');
    s.relay.detachPhone(a.token, a.sink);
    const again: PhoneMsg[] = [];
    s.relay.join('ABCD', maker('Ann'), a.token);
    s.relay.phoneStream(a.token, (m) => again.push(m));
    expect(again).toEqual([{ type: 'hello', state: { phase: 'preview', cards, tweaksLeft: 4 } }]);
  });
});

describe('Relay review fixes', () => {
  it('a phone that leaves while on stage does not break later line updates', () => {
    const s = setup();
    const [a, b, c] = ['Ann', 'Bo', 'Cy'].map((n) => s.join(n));
    s.relay.submit(a.token, input(), false);
    s.relay.submit(b.token, input(), false);
    s.relay.leave(a.token); // the host has not answered yet, so A still holds the stage
    s.clearAll();
    expect(s.relay.submit(c.token, input(), false)).toBe('queued');
    expect(c.msgs).toEqual([{ type: 'line', place: 2, ahead: [maker('Ann'), maker('Bo')] }]);
    s.clearAll();
    expect(s.relay.cancel(b.token)).toBe('ok');
    expect(c.msgs).toEqual([{ type: 'line', place: 1, ahead: [maker('Ann')] }]);
    s.clearAll();
    expect(s.send(a.token, { type: 'kept' })).toBe(true);
    expect(s.host[0]).toMatchObject({ type: 'turn', token: c.token });
  });

  it('a timed-out phone is busy until the host answers, then may submit again', () => {
    const s = setup({ quietMs: 1000 });
    const a = s.join('Ann');
    s.relay.submit(a.token, input(), false);
    s.send(a.token, { type: 'preview', cards });
    s.time(1001);
    s.relay.tick();
    expect(s.relay.snapshot(a.token)).toEqual({ phase: 'kept' });
    s.clearAll();
    expect(s.relay.submit(a.token, input(), false)).toBe('busy');
    expect(s.host).toEqual([]);
    expect(a.msgs).toEqual([]);
    s.send(a.token, { type: 'kept' });
    expect(a.msgs).toEqual([]); // already heard `kept`
    expect(s.host).toEqual([]); // nobody else in line
    expect(s.relay.submit(a.token, input(), false)).toBe('queued');
  });

  it('a late close of an old phone stream does not detach the new one', () => {
    const s = setup();
    const a = s.join('Ann');
    const fresh: PhoneMsg[] = [];
    const freshSink = (m: PhoneMsg) => fresh.push(m);
    s.relay.phoneStream(a.token, freshSink); // the reconnect arrives first
    s.relay.detachPhone(a.token, a.sink); // then the old connection's abort fires
    s.clearAll();
    s.relay.submit(a.token, input(), false);
    expect(fresh).toEqual([{ type: 'hello', state: { phase: 'idle' } }, { type: 'line', place: 0, ahead: [] }]);
    s.relay.detachPhone(a.token, freshSink); // the current stream closing does detach
    s.send(a.token, { type: 'step', step: { kind: 'reading' } });
    expect(fresh).toHaveLength(2);
  });

  it('a late close of an old host stream does not detach the new one', () => {
    const s = setup();
    const got: HostMsg[] = [];
    const freshSink = (m: HostMsg) => got.push(m);
    s.relay.hostStream(s.hostId, freshSink); // same host id reconnecting
    s.relay.detachHost(s.hostId, s.hostSink); // late abort of the old stream
    expect(s.relay.hasHost()).toBe(true);
    const a = s.join('Ann');
    got.length = 0;
    expect(s.relay.submit(a.token, input(), false)).toBe('queued');
    expect(got[0]).toMatchObject({ type: 'turn', token: a.token });
    s.relay.detachHost(s.hostId, freshSink);
    expect(s.relay.hasHost()).toBe(false);
  });
});

describe('Relay presence (final review I2): who the card counts', () => {
  /** Ann joins and her stream closes (a closed tab, a phone put away) at t = 0. */
  const gone = (opts: { awayMs?: number } = {}) => {
    const s = setup(opts);
    const a = s.join('Ann');
    s.relay.detachPhone(a.token, a.sink);
    s.clearAll();
    return { s, a };
  };

  it('a phone between creatures with no stream for awayMs is away: the host hears left once', () => {
    const { s, a } = gone({ awayMs: 1000 });
    s.time(1000);
    s.relay.tick();
    expect(s.host).toEqual([]); // not yet: quiet for exactly awayMs
    s.time(1001);
    s.relay.tick();
    s.relay.tick();
    expect(s.host).toEqual([{ type: 'left', token: a.token }]);
    expect(s.relay.snapshot(a.token)).toEqual({ phase: 'idle' }); // it keeps its token and its screen
  });

  it('the default is three minutes', () => {
    const { s, a } = gone();
    s.time(180000);
    s.relay.tick();
    expect(s.host).toEqual([]);
    s.time(180001);
    s.relay.tick();
    expect(s.host).toEqual([{ type: 'left', token: a.token }]);
  });

  it('a phone with its stream open is never away, however quiet', () => {
    const s = setup({ awayMs: 1000 });
    s.join('Ann');
    s.clearAll();
    s.time(10 ** 7);
    s.relay.tick();
    expect(s.host).toEqual([]);
  });

  it('after a release, a keep or a rest it may go away too', () => {
    const s = setup({ awayMs: 1000 });
    const a = s.join('Ann'), b = s.join('Bo'), c = s.join('Cy');
    s.relay.submit(a.token, input(), false);
    s.send(a.token, { type: 'released' });
    s.relay.submit(b.token, input(), false);
    s.send(b.token, { type: 'kept' });
    s.relay.submit(c.token, input(), true); // resting
    for (const p of [a, b, c]) s.relay.detachPhone(p.token, p.sink);
    s.clearAll();
    s.time(5000);
    s.relay.tick();
    expect(s.host.map((m) => m.type === 'left' && m.token)).toEqual([a.token, b.token, c.token]);
  });

  it('Review Focus 1: a phone in the line or on stage keeps its place with no stream, however long (a locked screen)', () => {
    const s = setup({ awayMs: 1000, quietMs: 10 ** 9 });
    const a = s.join('Ann'), b = s.join('Bo');
    s.relay.submit(a.token, input(), false); // on stage
    s.relay.submit(b.token, input(), false); // waiting
    s.relay.detachPhone(a.token, a.sink);
    s.relay.detachPhone(b.token, b.sink);
    s.clearAll();
    s.time(10 ** 6);
    s.relay.tick();
    s.send(a.token, { type: 'preview', cards });
    s.time(2 * 10 ** 6);
    s.relay.tick();
    expect(s.host.filter((m) => m.type === 'left')).toEqual([]);
    expect(s.relay.snapshot(b.token)).toEqual({ phase: 'waiting', place: 1 });
    expect(s.relay.snapshot(a.token)).toMatchObject({ phase: 'preview' });
  });

  it('an away phone that rejoins (or does anything) is back: joined, with its token and its screen', () => {
    const { s, a } = gone({ awayMs: 1000 });
    s.time(2000);
    s.relay.tick();
    s.clearAll();
    expect(s.relay.join('ABCD', maker('Ann'), a.token)).toEqual({ token: a.token });
    expect(s.host).toEqual([{ type: 'joined', token: a.token, maker: maker('Ann') }]);
    s.relay.phoneStream(a.token, a.sink);
    expect(s.host).toHaveLength(1); // not twice
    expect(a.msgs[0]).toEqual({ type: 'hello', state: { phase: 'idle' } });
  });

  it('a phone away for ten times awayMs is forgotten (the relay stays small); back later, it joins afresh', () => {
    const { s, a } = gone({ awayMs: 1000 });
    const b = s.join('Bo'); // here all along, stream open: never forgotten
    s.time(2000);
    s.relay.tick(); // away
    s.time(10_000);
    s.relay.tick();
    expect(s.relay.snapshot(a.token)).toEqual({ phase: 'idle' }); // quiet for exactly 10 × awayMs: still known
    s.time(10_001);
    s.relay.tick();
    expect(s.relay.snapshot(a.token)).toBeNull();
    expect(s.relay.snapshot(b.token)).toEqual({ phase: 'idle' });
    expect(s.relay.command(a.token, { kind: 'crown' })).toBe('unknown');
    const back = s.relay.join('ABCD', maker('Ann'), a.token);
    expect(back).not.toEqual({ token: a.token });
  });

  it('a phone in the line is never forgotten, however long its stream is closed', () => {
    const s = setup({ awayMs: 1000 });
    const a = s.join('Ann'), b = s.join('Bo');
    s.relay.submit(a.token, input(), false);
    s.relay.submit(b.token, input(), false);
    s.relay.detachPhone(b.token, b.sink);
    s.time(100_000);
    s.relay.tick();
    expect(s.relay.snapshot(b.token)).toEqual({ phase: 'waiting', place: 1 });
  });

  it('a reloaded TV is told only of the phones that are here', () => {
    const { s, a } = gone({ awayMs: 1000 });
    const b = s.join('Bo');
    s.time(2000);
    s.relay.tick();
    const got: HostMsg[] = [];
    s.relay.registerHost((m) => got.push(m), 'http://tv:5180/phone.html');
    expect(got.filter((m) => m.type === 'joined').map((m) => m.type === 'joined' && m.token)).toEqual([b.token]);
    expect(a.token).not.toBe(b.token);
  });
});

describe('Relay a reattached host and the cancel it may have missed (final review minor 1)', () => {
  it('the same host back on a new stream hears the cancel again; its answer ends the turn', () => {
    const s = setup();
    const a = s.join('Ann');
    s.relay.submit(a.token, input(), false);
    s.send(a.token, { type: 'preview', cards });
    s.relay.detachHost(s.hostId, s.hostSink);
    s.relay.cancel(a.token); // "Start again" while the TV's stream was down: nobody heard it
    const got: HostMsg[] = [];
    s.relay.hostStream(s.hostId, (m) => got.push(m));
    expect(got).toContainEqual({ type: 'cancel', token: a.token });
    expect(s.relay.snapshot(a.token)).toMatchObject({ phase: 'preview' }); // not concluded behind the TV's back
    a.msgs.length = 0;
    expect(s.relay.fromHost(s.hostId, { type: 'kept', token: a.token })).toBe(true);
    expect(a.msgs).toEqual([{ type: 'kept' }]);
  });

  it('a newly registered page (the TV reloaded) still ends the cancelled turn as kept', () => {
    const s = setup();
    const a = s.join('Ann'), b = s.join('Bo');
    s.relay.submit(a.token, input(), false);
    s.relay.submit(b.token, input(), false);
    s.relay.cancel(a.token);
    s.clearAll();
    const got: HostMsg[] = [];
    s.relay.registerHost((m) => got.push(m), 'http://tv:5180/phone.html');
    expect(a.msgs).toEqual([{ type: 'kept' }]);
    expect(got).toContainEqual(expect.objectContaining({ type: 'turn', token: b.token }));
  });
});

describe('Relay ring: phone commands and the ring broadcast (Task 16)', () => {
  const entry = (id: string, crowns = 0): RingEntry => ({ id, name: `Fighter ${id}`, maker: 'Zig', crowns, thumb: null });
  const ring = (over: Partial<{ phase: 'open' | 'crowned'; fighting: number; roster: RingEntry[] }> = {}) =>
    ({ phase: 'open' as const, fighting: 2, roster: [entry('r1', 1), entry('r2')], ...over });

  it('relay forwards a phone command to the host', () => {
    const s = setup();
    const a = s.join('Ann');
    s.clearAll();
    expect(s.relay.command(a.token, { kind: 'crown' })).toBe('sent');
    expect(s.relay.command(a.token, { kind: 'again' })).toBe('sent');
    expect(s.relay.command(a.token, { kind: 'sendBack', id: 'r1' })).toBe('sent');
    expect(s.host).toEqual([
      { type: 'command', token: a.token, command: { kind: 'crown' } },
      { type: 'command', token: a.token, command: { kind: 'again' } },
      { type: 'command', token: a.token, command: { kind: 'sendBack', id: 'r1' } },
    ]);
  });

  it('unknown token command is refused', () => {
    const s = setup();
    s.clearAll();
    expect(s.relay.command('nope', { kind: 'crown' })).toBe('unknown');
    expect(s.host).toEqual([]);
  });

  it('ring broadcast reaches every phone', () => {
    const s = setup();
    const a = s.join('Ann'), b = s.join('Bo');
    s.clearAll();
    expect(s.relay.ring(s.hostId, ring())).toBe(true);
    for (const p of [a, b]) expect(p.msgs).toEqual([{ type: 'ring', ...ring() }]);
    // a phone that opens its stream later hears the latest ring straight after its hello
    const c = s.join('Cy');
    expect(c.msgs).toEqual([{ type: 'hello', state: { phase: 'idle' } }, { type: 'ring', ...ring() }]);
    s.relay.ring(s.hostId, ring({ phase: 'crowned' }));
    for (const p of [a, b, c]) expect(p.msgs.at(-1)).toEqual({ type: 'ring', ...ring({ phase: 'crowned' }) });
  });

  it('a ring from a host id that is not the host is refused', () => {
    const s = setup();
    const a = s.join('Ann');
    s.clearAll();
    expect(s.relay.ring('someone-else', ring())).toBe(false);
    expect(a.msgs).toEqual([]);
  });

  it('a newly registered host starts with no ring (its match is new); a reattached one keeps it', () => {
    const s = setup();
    s.relay.ring(s.hostId, ring());
    s.relay.detachHost(s.hostId, s.hostSink);
    s.relay.hostStream(s.hostId, s.hostSink);
    expect(s.join('Ann').msgs.at(-1)).toEqual({ type: 'ring', ...ring() });
    s.relay.registerHost(() => {}, 'http://tv:5180/phone.html');
    expect(s.join('Bo').msgs).toEqual([{ type: 'hello', state: { phase: 'idle' } }]);
  });

  it('a new TV page empties the ring on phones that heard one (no stale Crown or roster), and only those', () => {
    const s = setup();
    const a = s.join('Ann');
    s.relay.ring(s.hostId, ring());
    a.msgs.length = 0;
    s.relay.registerHost(() => {}, 'http://tv:5180/phone.html');
    expect(a.msgs).toContainEqual({ type: 'ring', phase: 'open', fighting: 0, roster: [] });
    a.msgs.length = 0;
    s.relay.registerHost(() => {}, 'http://tv:5180/phone.html'); // no ring since: nothing stale to clear
    expect(a.msgs.some((m) => m.type === 'ring')).toBe(false);
  });

  it('a phone woken by a returning host hears the ring too', () => {
    const s = setup();
    s.relay.ring(s.hostId, ring());
    s.relay.detachHost(s.hostId, s.hostSink);
    const a = s.join('Ann'); // the TV is away: hello, noHost
    a.msgs.length = 0;
    s.relay.hostStream(s.hostId, s.hostSink);
    expect(a.msgs).toEqual([{ type: 'hello', state: { phase: 'idle' } }, { type: 'ring', ...ring() }]);
  });

  it('a command with no TV listening says noHost', () => {
    const s = setup({ host: false });
    const a = s.join('Ann');
    expect(s.relay.command(a.token, { kind: 'crown' })).toBe('noHost');
  });

  it('rate-limits commands per phone: 5 a second, then slow until the second has passed', () => {
    const s = setup();
    const a = s.join('Ann'), b = s.join('Bo');
    s.clearAll();
    s.time(1000);
    for (let i = 0; i < 5; i++) expect(s.relay.command(a.token, { kind: 'crown' })).toBe('sent');
    expect(s.relay.command(a.token, { kind: 'crown' })).toBe('slow');
    s.time(1500);
    expect(s.relay.command(a.token, { kind: 'again' })).toBe('slow');
    expect(s.relay.command(b.token, { kind: 'again' })).toBe('sent'); // another phone is not held up
    s.time(2001);
    expect(s.relay.command(a.token, { kind: 'again' })).toBe('sent');
    expect(s.host.filter((m) => m.type === 'command' && m.token === a.token)).toHaveLength(6);
  });

  it('the ring broadcast keeps at most 60 fighters: champions first, then the newest', () => {
    const s = setup();
    const a = s.join('Ann');
    s.clearAll();
    const roster = Array.from({ length: 100 }, (_, i) => entry(`r${i}`, i === 70 || i === 99 ? 2 : 0)); // newest first
    s.relay.ring(s.hostId, ring({ roster }));
    const got = a.msgs[0] as Extract<PhoneMsg, { type: 'ring' }>;
    expect(got.roster).toHaveLength(RING_ROSTER_MAX);
    expect(got.roster.map((e) => e.id)).toEqual(['r70', 'r99', ...roster.slice(0, 58).map((e) => e.id)]);
  });
});

describe('protocol: phone commands and the ring', () => {
  const entry = (id: string, crowns = 0): RingEntry => ({ id, name: id, maker: 'Zig', crowns, thumb: null });

  it('ringRoster: champions first (newest first among them), then the newest, at most 60', () => {
    expect(RING_ROSTER_MAX).toBe(60);
    expect(ringRoster([entry('a'), entry('b', 1), entry('c'), entry('d', 3)]).map((e) => e.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(ringRoster(Array.from({ length: 61 }, (_, i) => entry(`x${i}`)))).toHaveLength(60);
  });

  it('PhoneCommandSchema takes crown, again and sendBack with a short string id, and nothing else', () => {
    for (const c of [{ kind: 'crown' }, { kind: 'again' }, { kind: 'sendBack', id: 'r1' }, { kind: 'sendBack', id: 'x'.repeat(64) }]) {
      expect(PhoneCommandSchema.safeParse(c).success, JSON.stringify(c)).toBe(true);
    }
    for (const c of [
      { kind: 'fight' }, { kind: 'sendBack' }, { kind: 'sendBack', id: 7 }, { kind: 'sendBack', id: 'x'.repeat(65) },
      { kind: 'sendBack', id: '' }, { kind: 'crown', extra: 1 }, null, 'crown', {},
    ]) expect(PhoneCommandSchema.safeParse(c).success, JSON.stringify(c)).toBe(false);
  });

  it('ringEntry keeps a good entry, drops a bad thumb, and refuses an entry that cannot be sent', () => {
    const one = { id: 'r1', name: 'Zib', maker: 'Zig', crowns: 0, thumb: 'data:image/jpeg;base64,AAAA' };
    expect(ringEntry(one)).toEqual(one);
    expect(ringEntry({ ...one, thumb: `data:image/jpeg;base64,${'A'.repeat(20_000)}` })).toEqual({ ...one, thumb: null });
    expect(ringEntry({ ...one, thumb: 'data:image/png;base64,AAAA' })).toEqual({ ...one, thumb: null }); // JPEG only
    expect(ringEntry({ ...one, id: 'x'.repeat(65) })).toBeNull();
    expect(ringEntry({ ...one, crowns: -1 })).toBeNull();
    expect(ringEntry(null)).toBeNull();
  });

  it('HostSendSchema takes a ring and refuses a bad one', () => {
    const one = { id: 'r1', name: 'Zib', maker: 'Zig', crowns: 0, thumb: 'data:image/jpeg;base64,AAAA' };
    const ok = { type: 'ring', phase: 'open', fighting: 1, roster: [one] };
    expect(HostSendSchema.safeParse(ok).success).toBe(true);
    expect(HostSendSchema.safeParse({ ...ok, roster: [{ ...one, thumb: null }] }).success).toBe(true);
    expect(HostSendSchema.safeParse({ ...ok, phase: 'paused' }).success).toBe(false);
    expect(HostSendSchema.safeParse({ ...ok, fighting: -1 }).success).toBe(false);
    expect(HostSendSchema.safeParse({ ...ok, roster: [{ ...one, thumb: 'javascript:alert(1)' }] }).success).toBe(false);
    expect(HostSendSchema.safeParse({ ...ok, roster: [{ ...one, thumb: 'data:image/png;base64,AAAA' }] }).success).toBe(false);
    expect(HostSendSchema.safeParse({ ...ok, roster: [{ ...one, thumb: `data:image/jpeg;base64,${'A'.repeat(20_000)}` }] }).success).toBe(false);
  });
});
