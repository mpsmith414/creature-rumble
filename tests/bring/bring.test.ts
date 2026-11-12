import { describe, expect, it } from 'vitest';
import { cardWanted, joinAddress } from '../../src/bring/card';
import { createBring, type CardView } from '../../src/bring/bring';
import type { HostEvents, HostInfo } from '../../src/bring/host';
import type { HostMsg, Maker, PhoneCommand } from '../../src/bring/protocol';

const info: HostInfo = { code: 'ABCD', url: 'http://192.168.1.5:5180/phone.html?c=ABCD', qrSvg: '<svg/>' };
const mia: Maker = { name: 'Zig', badge: '🦊' }, leo: Maker = { name: 'Zag', badge: '🐻' };

/** A card that records what it was told. */
function fakeCard() {
  const c = { shown: null as HostInfo | null, visible: false, line: [] as { token: string; maker: Maker }[] };
  const view: CardView = {
    show: (i) => { c.shown = i; c.visible = true; },
    hide: () => { c.visible = false; },
    line: (l) => { c.line = l; },
    get visible() { return c.visible; },
  };
  return Object.assign(c, { view });
}
function setup() {
  const s0 = { reclaimed: 0 };
  const card = fakeCard();
  let ev!: HostEvents;
  const sent: [string, unknown][] = [];
  const rings: unknown[][] = [];
  const commands = new Set<(token: string, command: PhoneCommand) => void>();
  const bring = createBring(card.view, (e) => {
    ev = e;
    return {
      start: async () => {}, stop: () => {}, reclaim: async () => void s0.reclaimed++, send: async (t, m) => (sent.push([t, m]), true),
      sendRing: async (...a) => (rings.push(a), true), onCommand: (fn) => (commands.add(fn), () => void commands.delete(fn)),
    };
  });
  return { card, bring, sent, rings, commands, reclaimed: () => s0.reclaimed, msg: (m: HostMsg) => ev.onMsg(m), ev: () => ev };
}
const join = (s: ReturnType<typeof setup>, token: string, maker: Maker) => s.msg({ type: 'joined', token, maker });

describe('cardWanted', () => {
  it('auto shows while a phone is connected or a creature is being made, and hides otherwise', () => {
    expect(cardWanted({ mode: 'auto', phones: 0, making: false })).toBe(false);
    expect(cardWanted({ mode: 'auto', phones: 1, making: false })).toBe(true);
    expect(cardWanted({ mode: 'auto', phones: 0, making: true })).toBe(true);
  });
  it('on always shows and off never does', () => {
    for (const [phones, making] of [[0, false], [2, false], [0, true], [2, true]] as const) {
      expect(cardWanted({ mode: 'on', phones, making })).toBe(true);
      expect(cardWanted({ mode: 'off', phones, making })).toBe(false);
    }
  });
});

describe('joinAddress', () => {
  it('shows the address a phone types, without the scheme or the code', () => {
    expect(joinAddress('http://192.168.1.5:5180/phone.html?c=ABCD')).toEqual({ host: '192.168.1.5:5180', page: '/phone.html' });
    expect(joinAddress('not a url')).toEqual({ host: 'not a url', page: '' });
  });
});

describe('createBring', () => {
  it('keeps the card hidden until a phone joins, then lists the phones as badges, and hides it when the last leaves', () => {
    const s = setup();
    s.ev().onStatus('hosting', info);
    expect(s.card.visible).toBe(false);
    join(s, 't1', mia);
    expect(s.card.visible).toBe(true);
    expect(s.card.shown).toEqual(info);
    join(s, 't2', leo);
    expect(s.card.line.map((p) => p.maker.name)).toEqual(['Zig', 'Zag']);
    s.msg({ type: 'left', token: 't1' });
    expect(s.card.line.map((p) => p.maker.name)).toEqual(['Zag']);
    s.msg({ type: 'left', token: 't2' });
    expect(s.card.visible).toBe(false);
  });

  it('lists the ones in the line first, in line order', () => {
    const s = setup();
    s.ev().onStatus('hosting', info);
    join(s, 't1', mia);
    join(s, 't2', leo);
    s.msg({ type: 'line', line: [{ token: 't2', maker: leo }] });
    expect(s.card.line.map((p) => p.maker.name)).toEqual(['Zag', 'Zig']);
  });

  it('auto (the start): hidden with nobody there, shown by a phone, and the menu marks what shows', () => {
    const s = setup();
    s.ev().onStatus('hosting', info);
    expect(s.bring.mode).toBe('auto');
    expect(s.bring.cardShown).toBe(false);
    join(s, 't1', mia);
    expect(s.bring.cardShown).toBe(true);
    expect(s.card.visible).toBe(true);
  });

  it('on: toggling a hidden card shows it with nobody there and keeps it when the phones go; toggling again turns it off', () => {
    const s = setup();
    s.ev().onStatus('hosting', info);
    expect(s.bring.toggle()).toBe(true);
    expect(s.bring.mode).toBe('on');
    expect(s.card.visible).toBe(true);
    join(s, 't1', mia);
    s.msg({ type: 'left', token: 't1' });
    expect(s.card.visible).toBe(true);
    expect(s.bring.toggle()).toBe(false);
    expect(s.bring.mode).toBe('off');
    expect(s.card.visible).toBe(false);
  });

  it('off: toggling a card that phones keep showing hides it, and it stays hidden with phones connected until toggled on', () => {
    const s = setup();
    s.ev().onStatus('hosting', info);
    join(s, 't1', mia);
    expect(s.card.visible).toBe(true);
    expect(s.bring.toggle()).toBe(false);
    expect(s.bring.cardShown).toBe(false);
    expect(s.card.visible).toBe(false);
    join(s, 't2', leo); // more phones do not bring it back
    s.msg({ type: 'turn', token: 't2', maker: leo, input: { image: null, words: 'x' } });
    expect(s.card.visible).toBe(false);
    expect(s.bring.toggle()).toBe(true);
    expect(s.card.visible).toBe(true);
  });

  it('hears the same phone announced twice without listing it twice (a re-announce after a reload)', () => {
    const s = setup();
    s.ev().onStatus('hosting', info);
    join(s, 't1', mia);
    join(s, 't1', mia);
    s.msg({ type: 'line', line: [{ token: 't1', maker: mia }] });
    join(s, 't1', mia);
    expect(s.card.line.map((p) => p.maker.name)).toEqual(['Zig']);
  });

  it('stays up while a creature is being made, from the turn until the workshop says it is done', () => {
    const s = setup();
    s.ev().onStatus('hosting', info);
    join(s, 't1', mia);
    s.msg({ type: 'turn', token: 't1', maker: mia, input: { image: null, words: 'a fox' } });
    s.msg({ type: 'left', token: 't1' });
    expect(s.card.visible).toBe(true); // the phone went but the creature is still on the stage
    s.bring.setMaking(false);
    expect(s.card.visible).toBe(false);
  });

  describe('the stage has the screen (Ruling R21)', () => {
    /** A host with Zig connected, in `mode` (`on`/`off` by the menu's toggle, as the family switches it). */
    const inMode = (mode: 'auto' | 'on' | 'off') => {
      const s = setup();
      s.ev().onStatus('hosting', info);
      if (mode === 'on') s.bring.toggle(); // hidden (nobody yet) → on
      join(s, 't1', mia);
      if (mode === 'off') s.bring.toggle(); // showing → off
      expect(s.bring.mode).toBe(mode);
      return s;
    };
    for (const [mode, before] of [['auto', true], ['on', true], ['off', false]] as const) {
      it(`${mode}: hidden while the stage is on, as before once it is off`, () => {
        const s = inMode(mode);
        expect(s.card.visible).toBe(before);
        s.bring.setStage(true);
        expect(s.card.visible).toBe(false);
        s.msg({ type: 'turn', token: 't1', maker: mia, input: { image: null, words: 'a fox' } }); // "making" does not bring it back
        join(s, 't2', leo);
        expect(s.card.visible).toBe(false);
        expect(s.card.line.map((p) => p.maker.name)).toEqual(['Zig', 'Zag']); // still kept up to date behind the stage
        s.bring.setStage(false);
        expect(s.card.visible).toBe(before);
      });
    }

    it('the menu marks the mode, not the stage: toggling during an arrival switches the mode as it would without one', () => {
      const s = inMode('auto');
      s.bring.setStage(true);
      expect(s.bring.cardShown).toBe(true); // on, though stepped aside for now
      expect(s.bring.toggle()).toBe(false);
      expect(s.bring.mode).toBe('off');
      s.bring.setStage(false);
      expect(s.card.visible).toBe(false);
      s.bring.setStage(true);
      expect(s.bring.toggle()).toBe(true);
      expect(s.bring.mode).toBe('on');
      expect(s.card.visible).toBe(false); // still the stage's
      s.bring.setStage(false);
      expect(s.card.visible).toBe(true);
    });

    it('auto with nobody left: the card stays hidden after the stage once the phones went', () => {
      const s = inMode('auto');
      s.bring.setStage(true);
      s.msg({ type: 'left', token: 't1' });
      s.bring.setStage(false);
      expect(s.card.visible).toBe(false);
    });
  });

  it('hands every message to the listeners (turn, tweak, release, cancel ...) until they unhook', () => {
    const s = setup();
    const got: string[] = [];
    const off = s.bring.on((m) => got.push(m.type));
    s.msg({ type: 'tweak', token: 't1', words: 'fluffier' });
    s.msg({ type: 'cancel', token: 't1' });
    off();
    s.msg({ type: 'release', token: 't1' });
    expect(got).toEqual(['tweak', 'cancel']);
  });

  it('a lost connection hides the card and forgets the phones; coming back shows the new address', () => {
    const s = setup();
    s.ev().onStatus('hosting', info);
    join(s, 't1', mia);
    s.ev().onStatus('reconnecting');
    expect(s.card.visible).toBe(false);
    s.ev().onStatus('hosting', { ...info, code: 'WXYZ' });
    expect(s.card.visible).toBe(false); // nobody is known to be there yet
    join(s, 't3', leo);
    expect(s.card.shown?.code).toBe('WXYZ');
  });

  it('a newer valley page replaces this one: no card, and only the menu action takes hosting back', () => {
    const s = setup();
    s.ev().onStatus('hosting', info);
    join(s, 't1', mia);
    s.ev().onStatus('replaced');
    expect(s.card.visible).toBe(false);
    expect(s.bring.cardShown).toBe(false);
    expect(s.reclaimed()).toBe(0);
    expect(s.bring.toggle()).toBe(true); // "Add a creature"
    expect(s.reclaimed()).toBe(1);
    s.ev().onStatus('hosting', { ...info, code: 'NEWC' });
    expect(s.card.visible).toBe(true);
    expect(s.card.shown?.code).toBe('NEWC');
  });

  it('sends to the phone through the host client', async () => {
    const s = setup();
    expect(await s.bring.send('t1', { type: 'released' })).toBe(true);
    expect(s.sent).toEqual([['t1', { type: 'released' }]]);
  });
});

describe('createBring: the ring (Task 16)', () => {
  it('sendRing and onCommand go straight to the host client', async () => {
    const s = setup();
    const roster = [{ id: 'r1', name: 'Zib', maker: 'Zig', crowns: 1, thumb: null }];
    expect(await s.bring.sendRing('open', 2, roster)).toBe(true);
    expect(s.rings).toEqual([['open', 2, roster]]);
    const got: unknown[] = [];
    const off = s.bring.onCommand((token, command) => got.push([token, command]));
    for (const fn of s.commands) fn('t1', { kind: 'crown' });
    expect(got).toEqual([['t1', { kind: 'crown' }]]);
    off();
    expect(s.commands.size).toBe(0);
  });
});
