import { describe, expect, test, vi } from 'vitest';
import type { BodyData } from '../../src/builder/build';
import type { Studio } from '../../src/bring/studio';
import type { Made } from '../../src/bring/workshop';
import type { Maker, PhoneCommand, RingPhase } from '../../src/bring/protocol';
import type { RosterItem } from '../../src/roster/roster';
import {
  capsuleUi, gatedVoice, handleCommand, keepMade, localStore, memoryRoster, OOPS_MS, RingBroadcast, sendBack, type CommandDeps,
} from '../../src/app/wiring';
import { loadFixture } from '../fixtures/fighters';

const flush = () => new Promise((go) => setTimeout(go, 0));

function ring(phase: RingPhase, fighting: number) {
  const s = { phase, fighting };
  const d: CommandDeps & { s: typeof s } = {
    s, phase: () => s.phase, fighting: () => s.fighting,
    crown: vi.fn(() => { s.phase = 'crowned'; }),
    again: vi.fn(() => { s.phase = 'open'; }),
    sendBack: vi.fn(async () => {}),
  };
  return d;
}

describe('phone commands are gated by the phase', () => {
  const crown: PhoneCommand = { kind: 'crown' }, again: PhoneCommand = { kind: 'again' };

  test('crown only while open with someone fighting, and only once', () => {
    expect(handleCommand(crown, ring('open', 0))).toBe('ignored');
    const d = ring('open', 2);
    expect(handleCommand(crown, d)).toBe('crown');
    expect(handleCommand(crown, d)).toBe('ignored'); // a second phone, a double tap
    expect(d.crown).toHaveBeenCalledTimes(1);
  });

  test('again only after a crowning, and only once', () => {
    expect(handleCommand(again, ring('open', 3))).toBe('ignored');
    const d = ring('crowned', 1);
    expect(handleCommand(again, d)).toBe('again');
    expect(handleCommand(again, d)).toBe('ignored');
    expect(d.again).toHaveBeenCalledTimes(1);
  });

  test('send back goes to sendBack with its id in either phase', () => {
    for (const p of ['open', 'crowned'] as const) {
      const d = ring(p, 0);
      expect(handleCommand({ kind: 'sendBack', id: 'r1' }, d)).toBe('sendBack');
      expect(d.sendBack).toHaveBeenCalledWith('r1');
    }
  });
});

describe('the ring broadcast', () => {
  function rig() {
    const state = { phase: 'open' as RingPhase, fighting: 0 };
    const send = vi.fn(async () => true);
    const roster = vi.fn(async () => [{ id: 'r1', name: 'Pip', maker: 'Pickle', crowns: 0, thumb: null }]);
    return { state, send, roster, b: new RingBroadcast({ state: () => ({ ...state }), roster, send }) };
  }

  test('pushes on the first look, then only when the phase or the fighting count changes', async () => {
    const { state, send, b } = rig();
    b.watch();
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith('open', 0, [{ id: 'r1', name: 'Pip', maker: 'Pickle', crowns: 0, thumb: null }]);
    b.watch();
    await flush();
    expect(send).toHaveBeenCalledTimes(1); // nothing changed
    state.fighting = 1;
    b.watch();
    await flush();
    expect(send).toHaveBeenLastCalledWith('open', 1, expect.anything());
    state.phase = 'crowned';
    b.watch();
    await flush();
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith('crowned', 1, expect.anything());
  });

  test('the roster is read once and reused for ring changes; a roster change or a failed read reads it again', async () => {
    const { state, roster, b } = rig();
    b.watch();
    await flush();
    state.fighting = 3;
    b.watch();
    await flush();
    await b.push(false); // a fresh relay: the same roster
    expect(roster).toHaveBeenCalledTimes(1);
    await b.push(); // the roster changed
    expect(roster).toHaveBeenCalledTimes(2);
    roster.mockRejectedValueOnce(new Error('idb'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await b.push();
    state.fighting = 4;
    b.watch();
    await flush();
    expect(roster).toHaveBeenCalledTimes(4); // read again after the failure
    warn.mockRestore();
  });

  test('a roster change or a fresh relay pushes even when the ring is the same; pushes never overlap', async () => {
    const { send, roster, b } = rig();
    b.watch();
    void b.push();
    void b.push();
    await b.push();
    await flush();
    // the first, then once more for the three asked for while it was on its way
    expect(send).toHaveBeenCalledTimes(2);
    expect(roster).toHaveBeenCalledTimes(2);
  });

  test('a failed send is not fatal and the next change still goes', async () => {
    const { state, send, b } = rig();
    send.mockRejectedValueOnce(new Error('relay away'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await b.push();
    state.fighting = 2;
    b.watch();
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('send back in', () => {
  const recipe = loadFixture('fists');
  const item = { id: 'r1', recipe } as RosterItem;
  const body = { key: 'k' } as BodyData;

  test('uses the cached body and arrives', async () => {
    const arrive = vi.fn(), build = vi.fn();
    expect(await sendBack('r1', { get: async () => item, cached: async () => body, build, arrive })).toBe(true);
    expect(build).not.toHaveBeenCalled();
    expect(arrive).toHaveBeenCalledWith(item, body);
  });

  test('rebuilds on a cache miss (or a broken cache)', async () => {
    for (const cached of [async () => null, async () => { throw new Error('idb'); }]) {
      const arrive = vi.fn(), build = vi.fn(async () => body);
      expect(await sendBack('r1', { get: async () => item, cached, build, arrive })).toBe(true);
      expect(build).toHaveBeenCalledWith(recipe);
      expect(arrive).toHaveBeenCalledWith(item, body);
    }
  });

  test('one already in the ring or on deck: nothing is read, loaded or built', async () => {
    const arrive = vi.fn(), build = vi.fn(), cached = vi.fn(), get = vi.fn(async () => item);
    expect(await sendBack('r1', { known: () => true, get, cached, build, arrive })).toBe(false);
    for (const f of [get, cached, build, arrive]) expect(f).not.toHaveBeenCalled();
  });

  test('an unknown id does nothing', async () => {
    const arrive = vi.fn(), build = vi.fn(), cached = vi.fn();
    expect(await sendBack('nope', { get: async () => undefined, cached, build, arrive })).toBe(false);
    expect(arrive).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });
});

describe('keeping a made creature', () => {
  const made = { recipe: loadFixture('fists') } as Made;

  test('checked, kept, then sent in', async () => {
    const order: string[] = [];
    const item = await keepMade(made, {
      check: () => void order.push('check'),
      add: async () => { order.push('add'); return 'r1'; },
      enter: (i) => void order.push(`enter ${i}`),
    });
    expect(item).toBe('r1');
    expect(order).toEqual(['check', 'add', 'enter r1']);
  });

  test('a creature that cannot fight is never kept', async () => {
    const add = vi.fn(async () => 'r1'), enter = vi.fn();
    await expect(keepMade(made, { check: () => { throw new Error('no torso'); }, add, enter })).rejects.toThrow('no torso');
    expect(add).not.toHaveBeenCalled();
    expect(enter).not.toHaveBeenCalled();
  });
});

describe('the capsule is the workshop screen on the TV', () => {
  const maker: Maker = { name: 'Pickle', badge: '🦊' };
  function rig() {
    const set = vi.fn();
    const studios: { dispose: ReturnType<typeof vi.fn> }[] = [];
    const oops = vi.fn();
    let fire: (() => void) | null = null;
    const ui = capsuleUi({ set }, {
      makeStudio: () => {
        const s = { ready: Promise.resolve(), dispose: vi.fn(), snapshot: vi.fn(async () => ({ base64: 'x', mediaType: 'image/png' as const })), show: vi.fn(async () => {}) };
        studios.push(s);
        return s as unknown as Studio;
      },
      oops,
      later: (fn, ms) => { expect(ms).toBe(OOPS_MS); fire = fn; },
    });
    return { set, studios, oops, ui, fire: () => fire?.() };
  }

  test('making shows the maker, the silhouette once the shape exists, and hides on close', async () => {
    const { set, studios, ui } = rig();
    ui.open(maker, { words: 'a dragon', image: null });
    expect(set).toHaveBeenLastCalledWith(maker, false);
    expect(ui.making).toBe(true);
    ui.step({ kind: 'reading' });
    expect(set).toHaveBeenLastCalledWith(maker, false);
    ui.step({ kind: 'building' });
    expect(set).toHaveBeenLastCalledWith(maker, true);
    await expect(ui.studio.snapshot({} as BodyData, loadFixture('fists'), { angle: 'front', facing: 'right' })).resolves.toBeTruthy();
    ui.close();
    expect(set).toHaveBeenLastCalledWith(null, false);
    expect(studios[0].dispose).toHaveBeenCalled();
    expect(ui.making).toBe(false);
    await expect(ui.studio.snapshot({} as BodyData, loadFixture('fists'), { angle: 'front', facing: 'right' })).rejects.toThrow();
  });

  test('a resting designer: the capsule goes, the words show, the next turn waits out the words', async () => {
    const { set, oops, ui, fire } = rig();
    ui.open(maker, { words: 'a dragon', image: null });
    ui.oops("Hmm, let's try that one again!");
    expect(set).toHaveBeenLastCalledWith(null, false);
    expect(oops).toHaveBeenCalledWith("Hmm, let's try that one again!");
    let idle = false;
    void ui.idle!().then(() => (idle = true));
    await flush();
    expect(idle).toBe(false);
    fire();
    await flush();
    expect(idle).toBe(true);
  });
});

describe('stores and stand-ins never throw', () => {
  test('localStore survives a broken or missing storage', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } } as unknown as Storage;
    const s = localStore('k', () => broken);
    expect(s.get()).toEqual([]);
    expect(() => s.set(['a'])).not.toThrow();
    expect(localStore('k', () => undefined).get()).toEqual([]);
    const map = new Map<string, string>();
    const ok = localStore('k', () => ({ getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) }) as unknown as Storage);
    ok.set(['hit:1', 'ringOut:2']);
    expect(ok.get()).toEqual(['hit:1', 'ringOut:2']);
    map.set('k', '{not json');
    expect(ok.get()).toEqual([]);
  });

  test('the voice says nothing until the audio is unlocked, but still fetches', () => {
    let live = false;
    const v = { prefetch: vi.fn(), isReady: vi.fn(() => true), play: vi.fn(() => ({ spoken: true, seconds: 1 })), stop: vi.fn() };
    const g = gatedVoice(v, () => live);
    g.prefetch('hi');
    expect(v.prefetch).toHaveBeenCalledWith('hi');
    expect(g.isReady('hi')).toBe(false);
    expect(g.play('hi', () => {})).toEqual({ spoken: false, seconds: 0 });
    live = true;
    expect(g.isReady('hi')).toBe(true);
    expect(g.play('hi', () => {}).spoken).toBe(true);
  });

  test('the memory roster keeps tonight\'s creatures', async () => {
    const r = memoryRoster();
    const made = { recipe: loadFixture('blob'), cards: { name: 'Blobby' }, maker: { name: 'Sam', badge: '🐸' } } as never;
    const a = await r.add(made, 1), b = await r.add(made, 2);
    expect((await r.list()).map((i) => i.id)).toEqual([b.id, a.id]);
    await r.crowned(a.id);
    await r.fought([a.id, b.id, 'nope']);
    expect(await r.get(a.id)).toMatchObject({ crowns: 1, bouts: 1 });
    expect((await r.summaries())[1]).toEqual({ id: a.id, name: 'Blobby', maker: 'Sam', crowns: 1, thumb: null });
  });
});
