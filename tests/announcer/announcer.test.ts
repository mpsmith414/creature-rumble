import { describe, expect, it, vi } from 'vitest';
import { Announcer, introText, RecentLines } from '../../src/announcer/announcer';
import { LINES } from '../../src/announcer/lines';

/** A voice that has decoded the texts `ready` accepts, and logs what it is asked to do. */
function fakeVoice(o: { ready?: (t: string) => boolean; seconds?: number } = {}) {
  const log: string[] = [];
  let end: (() => void) | null = null;
  const voice = {
    prefetch: vi.fn((t: string) => void log.push(`prefetch ${t}`)),
    isReady: (t: string) => o.ready?.(t) ?? false,
    play(t: string, onEnd: () => void) {
      if (!(o.ready?.(t) ?? false)) return { spoken: false, seconds: 0 };
      const old = end;
      end = onEnd;
      old?.();
      log.push(`play ${t}`);
      return { spoken: true, seconds: o.seconds ?? 3 };
    },
    stop: vi.fn(() => {
      const e = end;
      end = null;
      e?.();
    }),
  };
  return { voice, log, finish: () => { const e = end; end = null; e?.(); } };
}

function setup(o: { ready?: (t: string) => boolean; seconds?: number; rng?: () => number } = {}) {
  const v = fakeVoice(o);
  const shown: { title: string; sub: string; seconds: number }[] = [];
  const calls: string[] = [];
  let t = 0;
  const later: { at: number; fn: () => void }[] = [];
  const a = new Announcer({
    voice: v.voice as never,
    banner: { show: (title: string, sub = '', seconds = 3) => shown.push({ title, sub, seconds }), hide() {} } as never,
    mixer: { duckForVoice: (on: boolean) => calls.push(`duck ${on}`) } as never,
    sfx: { drumRoll: (s: number) => calls.push(`roll ${s}`), sting: () => calls.push('sting') } as never,
    crowd: { roar: () => calls.push('roar'), aww: () => calls.push('aww') } as never,
    rng: o.rng ?? (() => 0.5),
    now: () => t,
    later: (fn, ms) => void later.push({ at: t + ms, fn }),
  });
  return {
    a, shown, calls, v, later,
    at: (s: number) => { t = s * 1000; },
    runLater: () => { for (const l of later.splice(0)) l.fn(); },
    lastText: () => shown.at(-1)?.sub ?? '',
  };
}

describe('Announcer', () => {
  it('entrance proceeds with words only when voice unavailable', () => {
    const s = setup();
    const r = s.a.say('intro', { name: 'Sir Bounces', maker: 'Pickle' }, { priority: true });
    expect(r.spoken).toBe(false);
    expect(s.shown.at(-1)!.title).toContain('SIR BOUNCES');
    expect(r.text).toContain('Pickle');
    expect(r.text).not.toMatch(/[{}]/);
  });

  it('hit chatter is rate-limited', () => {
    const s = setup();
    s.at(0);
    s.a.say('hit', { name: 'A', other: 'B' });
    s.at(3);
    const r = s.a.say('hit', { name: 'A', other: 'B' });
    expect(r.spoken).toBe(false);
    expect(s.shown).toHaveLength(1);
    s.at(6.1);
    s.a.say('hit', { name: 'A', other: 'B' });
    expect(s.shown).toHaveLength(2);
  });

  it('a hit never talks over a priority line that is still showing, and a priority line interrupts anything', () => {
    const s = setup();
    s.at(0);
    s.a.say('ringOut', { other: 'Pip' });
    s.at(2);
    s.a.say('hit', { name: 'A', other: 'B' });
    expect(s.shown).toHaveLength(1);
    s.at(2.5);
    s.a.say('crown', { name: 'A' });
    expect(s.shown).toHaveLength(2);
    s.at(30);
    s.a.say('hit', { name: 'A', other: 'B' });
    expect(s.shown).toHaveLength(3);
  });

  it('a priority line stops the voice mid-line and speaks itself', () => {
    const s = setup({ ready: () => true });
    s.at(0);
    expect(s.a.say('hit', { name: 'A', other: 'B' }).spoken).toBe(true);
    s.at(1);
    const r = s.a.say('ringOut', { other: 'Pip' });
    expect(s.v.voice.stop).toHaveBeenCalled();
    expect(r.spoken).toBe(true);
    expect(s.calls.filter((c) => c.startsWith('duck'))).toEqual(['duck true', 'duck false', 'duck true']);
  });

  it('a hit does not talk over a priority line that is being spoken, even after its words are gone', () => {
    const s = setup({ ready: () => true, seconds: 20 });
    s.at(0);
    s.a.say('crown', { name: 'A' });
    s.at(12);
    s.a.say('hit', { name: 'A', other: 'B' });
    expect(s.shown).toHaveLength(1);
  });

  it('speaks only a decoded line, and ducks the crowd around it', () => {
    const s = setup({ ready: () => true });
    const r = s.a.say('crown', { name: 'Pip' });
    expect(r.spoken).toBe(true);
    expect(s.v.log).toContain(`play ${r.text}`);
    expect(s.calls).toEqual(['duck true']);
    s.v.finish();
    expect(s.calls).toEqual(['duck true', 'duck false']);
  });

  it('shows words only and does not duck when the voice is not ready (a 503 while loading)', () => {
    const s = setup({ ready: () => false });
    const r = s.a.say('crown', { name: 'Pip' });
    expect(r.spoken).toBe(false);
    expect(s.lastText()).toBe(r.text);
    expect(s.calls).toEqual([]);
  });

  it('prefetch hands the exact text to the voice, and the intro said matches it', () => {
    const s = setup({ ready: () => true });
    const raw = 'From {maker}! It is {name}!';
    const text = introText(raw, { name: 'Pip', maker: 'Pickle' });
    s.a.prefetch(text);
    expect(s.v.voice.prefetch).toHaveBeenCalledWith(text);
    expect(text).toBe('From Pickle! It is PIP!');
    expect(s.a.say('intro', { name: 'Pip', maker: 'Pickle' }, { text: raw }).text).toBe(text);
  });

  it('frames an intro: drum roll first, then the voice, then a sting and a roar when the line ends', () => {
    const s = setup({ ready: () => true });
    expect(s.a.say('intro', { name: 'Pip', maker: 'Pickle' }).spoken).toBe(true);
    expect(s.calls).toEqual(['roll 1']);
    s.runLater();
    expect(s.calls).toEqual(['roll 1', 'duck true']);
    s.v.finish();
    expect(s.calls).toEqual(['roll 1', 'duck true', 'duck false', 'sting', 'roar']);
  });

  it('a group intro is a priority beat: chatter cannot talk over it, and its framing is not cancelled', () => {
    const s = setup({ ready: () => true });
    s.at(0);
    s.a.say('groupIntro', { names: 'A and B' });
    s.runLater();
    s.at(3);
    s.a.say('hit', { name: 'A', other: 'B' });
    s.a.say('holdsRing', { name: 'A' });
    expect(s.shown).toHaveLength(1);
    s.v.finish();
    expect(s.calls).toContain('sting');
  });

  it('after a bank is used up, ready lines are still chosen, so chatter keeps speaking', () => {
    const ready = new Set<string>();
    let seed = 3;
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const s = setup({ ready: (t) => ready.has(t), rng });
    let spoken = 0;
    for (let i = 0; i < 40; i++) {
      s.at(i * 10);
      s.a.warm('hit', { name: 'A', other: 'B' }, 6);
      for (const c of s.v.voice.prefetch.mock.calls) ready.add(c[0] as string);
      if (s.a.say('hit', { name: 'A', other: 'B' }).spoken) spoken++;
      s.v.finish();
    }
    expect(spoken).toBeGreaterThan(20);
  });

  it('frames a words-only intro after a pause', () => {
    const s = setup();
    s.a.say('intro', { name: 'Pip', maker: 'Pickle' });
    expect(s.calls).toEqual(['roll 1']);
    s.runLater();
    expect(s.calls).toEqual(['roll 1', 'sting', 'roar']);
  });

  describe('a special', () => {
    const slots = { name: 'Pip', special: 'MEGA PUNCH' };

    it('puts its name up as the banner title over a special line, shouting the special', () => {
      const s = setup();
      const r = s.a.say('special', slots, { title: 'MEGA PUNCH!' });
      expect(s.shown.at(-1)!.title).toBe('MEGA PUNCH!');
      expect(r.text).toContain('MEGA PUNCH');
      expect(LINES.special.some((l) => l.replace('{name}', 'PIP').replace('{special}', 'MEGA PUNCH') === r.text)).toBe(true);
    });

    it('is a priority beat: it cuts chatter off and chatter cannot talk over it', () => {
      const s = setup({ ready: () => true });
      s.at(0);
      s.a.say('hit', { name: 'A', other: 'B' });
      s.at(1);
      expect(s.a.say('special', slots).spoken).toBe(true);
      expect(s.v.voice.stop).toHaveBeenCalled();
      s.at(8);
      expect(s.a.say('hit', { name: 'A', other: 'B' }).text).toBe(''); // the special line is still being spoken
    });

    it('never interrupts an intro, spoken or words only, but follows once it is over', () => {
      for (const ready of [true, false]) {
        const s = setup({ ready: () => ready, seconds: 4 });
        s.at(0);
        s.a.say('intro', { name: 'Sir Bounces', maker: 'Pickle' });
        s.runLater();
        s.at(2);
        expect(s.a.say('special', slots).text).toBe('');
        expect(s.shown).toHaveLength(1);
        if (ready) s.v.finish();
        s.at(11);
        expect(s.a.say('special', slots).text).not.toBe('');
      }
    });

    it('a group intro holds it off too, and so does a ring-out line still up, until it is over', () => {
      const s = setup();
      s.at(0);
      s.a.say('groupIntro', { names: 'A and B' });
      s.at(1);
      expect(s.a.say('special', slots).text).toBe('');
      s.a.say('ringOut', { other: 'A' });
      s.at(1.5);
      expect(s.a.say('special', slots).text).toBe(''); // never cuts "A IS OUT!" off
      s.at(30);
      expect(s.a.say('special', slots).text).not.toBe('');
    });

    it('never cuts another special off mid-line', () => {
      const s = setup({ ready: () => true });
      s.at(0);
      expect(s.a.say('special', slots).spoken).toBe(true);
      s.at(1);
      expect(s.a.say('special', slots).text).toBe('');
      expect(s.v.voice.stop).toHaveBeenCalledTimes(1);
    });

    it('warms its lines with the exact words it says', () => {
      const ready = new Set<string>();
      const s = setup({ ready: (t) => ready.has(t) });
      s.a.warm('special', slots, 1);
      const [warmed] = s.v.voice.prefetch.mock.calls.map((c) => c[0] as string);
      ready.add(warmed);
      expect(s.a.say('special', slots).text).toBe(warmed);
    });
  });

  it('a tie gets the crowd aww', () => {
    const s = setup();
    s.a.say('tie', {});
    expect(s.calls).toContain('aww');
  });

  it('warm prefetches a few lines of a beat, and a ready line is preferred', () => {
    const ready = new Set<string>();
    const s = setup({ ready: (t) => ready.has(t) });
    s.a.warm('crown', { name: 'Pip' }, 3);
    expect(s.v.voice.prefetch).toHaveBeenCalledTimes(3);
    const warmed = s.v.voice.prefetch.mock.calls.map((c) => c[0] as string);
    ready.add(warmed[2]);
    expect(s.a.say('crown', { name: 'Pip' }, { priority: true }).text).toBe(warmed[2]);
  });

  it('no line repeats until the bank is used up', () => {
    let seed = 7;
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const s = setup({ rng });
    const seen = new Set<string>();
    const n = LINES.hit.length;
    for (let i = 0; i < n; i++) {
      s.at(i * 10);
      seen.add(s.a.say('hit', { name: 'A', other: 'B' }).text);
    }
    expect(seen.size).toBe(n);
  });
});

describe('RecentLines', () => {
  const mem = () => {
    let ids: string[] = [];
    return { get: () => ids, set: (x: string[]) => void (ids = x) };
  };
  it('remembers the last 200 and forgets the rest', () => {
    const r = new RecentLines(mem());
    for (let i = 0; i < 250; i++) r.add(`l${i}`);
    expect(r.has('l49')).toBe(false);
    expect(r.has('l50')).toBe(true);
    expect(r.has('l249')).toBe(true);
    expect(r.oldest(['l249', 'l50', 'never'])).toBe('never');
    expect(r.oldest(['l249', 'l50'])).toBe('l50');
  });
  it('ignores a store that throws', () => {
    const r = new RecentLines({ get: () => { throw new Error('x'); }, set: () => { throw new Error('y'); } });
    r.add('a');
    expect(r.has('a')).toBe(true);
  });
});
