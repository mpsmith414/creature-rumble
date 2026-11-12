import { describe, expect, it } from 'vitest';
import type { BodyData } from '../../src/builder/build';
import type { HostMsg, HostSend, Maker } from '../../src/bring/protocol';
import { connectWorkshop, sendEnd, Workshop, type Made, type WorkshopHooks, type WorkshopUi } from '../../src/bring/workshop';
import { DesignerInvalid, DesignerResting, type DesignerApi } from '../../src/designer/api';
import { designCreature, tweakCreature } from '../../src/designer/loop';
import type { LookAgainResult, ReadResult } from '../../src/designer/types';
import type { Recipe } from '../../src/recipe/schema';
import { quadruped } from '../fixtures/recipes';

const mia: Maker = { name: 'Zig', badge: '🦊' };
const cards = { name: 'Puff', eats: 'clover 🍀', speed: 'slow 🐢', mood: 'shy 🙈', special: 'spots' };
const img = { base64: 'x', mediaType: 'image/png' as const };
const input = { image: img, words: 'a spotty cat' };
const TRY_AGAIN = "Hmm, let's try that one again!";
const edit: LookAgainResult = { status: 'ok', verdict: 'edits', edits: [{ op: 'set', path: 'parts.tail.length', valueJson: '0.5' }], note: 'The ears should be bigger…' };
const matches: LookAgainResult = { status: 'ok', verdict: 'matches', edits: [], note: 'Looks just right!' };
const readOk: ReadResult = { status: 'ok', recipe: quadruped, checklist: ['4 legs'], view: { angle: 'side', facing: 'left' }, cards, fixes: [] };

/** A promise to settle by hand, so a test can hold the designer mid-call. */
function later<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

type Calls = { sent: [string, HostSend][]; ui: string[]; shown: string[]; reveal: unknown[] };
function setup(o: { read?: () => Promise<ReadResult>; looks?: (() => Promise<LookAgainResult>)[]; build?: (r: Recipe) => Promise<BodyData>; tweak?: DesignerApi['tweak']; taken?: (m: HostSend) => boolean; idle?: () => Promise<void> } = {}) {
  const c: Calls = { sent: [], ui: [], shown: [], reveal: [] };
  const looks = [...(o.looks ?? [async () => edit, async () => matches])];
  const api: DesignerApi = {
    read: o.read ?? (async () => readOk),
    lookAgain: () => (looks.shift() ?? (async () => matches))(),
    tweak: o.tweak ?? (async () => ({ status: 'ok', edits: [{ op: 'set', path: 'life.sizeM', valueJson: '2' }], cards: { ...cards, name: 'Big Puff' }, note: 'Now it is bigger!' })),
  };
  const ui: WorkshopUi = {
    open: (m) => c.ui.push(`open ${m.name}`),
    step: (s) => c.ui.push(`step ${s.kind}${'pass' in s ? ` ${s.pass}` : ''}`),
    reveal: (k) => (c.ui.push(`reveal ${k.name}`), c.reveal.push(k)),
    note: (n) => c.ui.push(`note ${n}`),
    oops: (t) => c.ui.push(`oops ${t}`),
    close: () => c.ui.push('close'),
    ...(o.idle ? { idle: o.idle } : {}),
  };
  const ws = new Workshop({
    design: designCreature, tweak: tweakCreature, api,
    build: o.build ?? (async (r) => ({ key: r.id, size: r.life.sizeM }) as unknown as BodyData),
    studio: {
      show: async (b) => void c.shown.push(String((b as unknown as { size: number }).size)),
      snapshot: async () => img,
    },
    send: async (t, m) => (c.sent.push([t, m]), o.taken ? o.taken(m) : true),
    ui, now: () => 0,
  }, { retryMs: 5 });
  return { ws, c, kinds: () => c.sent.map(([, m]) => (m.type === 'step' ? `step ${m.step.kind}${'pass' in m.step ? ` ${m.step.pass}` : ''}` : m.type)) };
}

describe('Workshop.turn', () => {
  it('tells the phone each step, then reveals the creature and sends the preview with its cards', async () => {
    const s = setup();
    await s.ws.turn('t1', mia, input);
    expect(s.kinds()).toEqual(['step reading', 'step building', 'step looking 1', 'step fixing 1', 'step building', 'step looking 2', 'preview']);
    expect(s.c.sent.every(([t]) => t === 't1')).toBe(true);
    expect(s.c.sent.at(-1)![1]).toEqual({ type: 'preview', cards });
    // the phone gets `looking` without its picture
    expect(s.c.sent[2][1]).toEqual({ type: 'step', step: { kind: 'looking', pass: 1 } });
    expect(s.c.sent[3][1]).toEqual({ type: 'step', step: { kind: 'fixing', pass: 1, note: 'The ears should be bigger…' } });
    expect(s.c.ui[0]).toBe('open Zig');
    expect(s.c.ui).toContain('reveal Puff');
    expect(s.c.shown.length).toBe(2); // every build appears on the stage
    expect(s.ws.busy).toBe(true); // on stage until it is released or kept
  });

  for (const [what, read] of [
    ['a resting designer', async () => { throw new DesignerResting('503'); }],
    ['an invalid answer', async () => { throw new DesignerInvalid('invalid'); }],
  ] as const) {
    it(`${what}: the TV says try again and the phone gets failed with retry`, async () => {
      const s = setup({ read });
      await s.ws.turn('t1', mia, input);
      expect(s.c.ui).toContain(`oops ${TRY_AGAIN}`);
      expect(s.c.sent.at(-1)![1]).toEqual({ type: 'failed', message: TRY_AGAIN, retry: true });
      expect(s.ws.busy).toBe(false);
    });
  }

  it('a body that cannot be built: try again', async () => {
    const s = setup({ build: async () => { throw new Error('the builder threw'); } });
    await s.ws.turn('t1', mia, input);
    expect(s.c.ui).toContain(`oops ${TRY_AGAIN}`);
    expect(s.c.sent.at(-1)![1]).toEqual({ type: 'failed', message: TRY_AGAIN, retry: true });
    expect(s.ws.busy).toBe(false);
  });

  it('a declined read: the phone hears the designer’s kind sentence, the TV a short "try another"', async () => {
    const message = 'Let’s draw a friendly creature instead!';
    const s = setup({ read: async () => ({ status: 'declined', message }) });
    await s.ws.turn('t1', mia, input);
    expect(s.c.sent.at(-1)![1]).toEqual({ type: 'failed', message, retry: true });
    expect(s.c.ui).toContain('oops Let\'s try another drawing!');
    expect(s.ws.busy).toBe(false);
  });

  it('a repeated turn for the creature on stage is not started twice', async () => {
    const s = setup();
    await s.ws.turn('t1', mia, input);
    const n = s.c.sent.length;
    await s.ws.turn('t1', mia, input);
    expect(s.c.sent.length).toBe(n);
  });
});

describe('Workshop.tweak', () => {
  it('rebuilds on the stage and sends tweaked with the new cards and the note', async () => {
    const s = setup();
    await s.ws.turn('t1', mia, input);
    await s.ws.tweak('t1', 'Bigger!');
    expect(s.c.sent.at(-1)![1]).toEqual({ type: 'tweaked', cards: { ...cards, name: 'Big Puff' }, note: 'Now it is bigger!' });
    expect(s.c.shown.at(-1)).toBe('2');
    expect(s.c.ui).toContain('reveal Big Puff');
    expect(s.c.ui).toContain('note Now it is bigger!');
    expect(s.ws.release('t1')!.cards.name).toBe('Big Puff'); // the release takes the tweaked creature
  });

  it('a declined tweak keeps the creature and the preview: the phone hears the designer’s sentence as the note', async () => {
    const s = setup({ tweak: async () => ({ status: 'declined', message: 'Let’s keep it friendly!' }) });
    await s.ws.turn('t1', mia, input);
    await s.ws.tweak('t1', 'scary teeth');
    // not `failed`: the relay ends the turn on `failed` (see the report), so the phone stays on its preview
    expect(s.c.sent.at(-1)![1]).toEqual({ type: 'tweaked', cards, note: 'Let’s keep it friendly!' });
    expect(s.ws.busy).toBe(true);
    expect(s.ws.release('t1')!.cards).toEqual(cards);
  });

  it('a resting designer during a tweak keeps the preview too', async () => {
    const s = setup({ tweak: async () => { throw new DesignerResting('network'); } });
    await s.ws.turn('t1', mia, input);
    await s.ws.tweak('t1', 'Fluffier!');
    expect(s.c.sent.at(-1)![1]).toEqual({ type: 'tweaked', cards, note: TRY_AGAIN });
    expect(s.ws.busy).toBe(true);
  });

  it('is ignored while the creature is still being made, and for another phone', async () => {
    const read = later<ReadResult>();
    const s = setup({ read: () => read.promise });
    const turn = s.ws.turn('t1', mia, input);
    await s.ws.tweak('t1', 'Bigger!');
    read.resolve(readOk);
    await turn;
    await s.ws.tweak('t2', 'Bigger!');
    expect(s.kinds().filter((k) => k === 'tweaked')).toEqual([]);
  });
});

describe('Workshop.release', () => {
  it('hands over the made creature at the preview and ends the turn', async () => {
    const s = setup();
    await s.ws.turn('t1', mia, input);
    const made = s.ws.release('t1') as Made;
    expect(made).toMatchObject({ token: 't1', maker: mia, input, cards, thumb: img });
    expect(made.recipe.parts.find((p) => p.id === 'tail')!.length).toBe(0.5); // the look-again fix is in
    expect(made.history.map((h) => h.verdict)).toEqual(['edits', 'matches']);
    expect(s.ws.busy).toBe(false);
    expect(s.ws.release('t1')).toBeNull();
  });

  it('is refused while the creature is still being made', async () => {
    const read = later<ReadResult>();
    const s = setup({ read: () => read.promise });
    const turn = s.ws.turn('t1', mia, input);
    expect(s.ws.release('t1')).toBeNull();
    read.resolve(readOk);
    await turn;
    expect(s.ws.busy).toBe(true);
  });
});

describe('Workshop.cancel', () => {
  it('during the read: nothing was made, so it ends at once with failed and null', async () => {
    const read = later<ReadResult>();
    const s = setup({ read: () => read.promise });
    const turn = s.ws.turn('t1', mia, input);
    expect(await s.ws.cancel('t1')).toBeNull();
    expect(s.ws.busy).toBe(false);
    expect(s.c.ui.at(-1)).toBe('close');
    expect(s.c.sent.at(-1)![1]).toEqual({ type: 'failed', message: TRY_AGAIN, retry: true });
    // the read returns later: nothing more happens
    read.resolve(readOk);
    await turn;
    expect(s.kinds().filter((k) => k === 'preview' || k === 'step building')).toEqual([]);
    expect(s.c.shown).toEqual([]);
  });

  it('after the first build: returns the creature as it stands (kept), without a preview', async () => {
    const look = later<LookAgainResult>();
    const s = setup({ looks: [() => look.promise] });
    const turn = s.ws.turn('t1', mia, input);
    while (!s.kinds().includes('step looking 1')) await tick();
    const made = await s.ws.cancel('t1');
    expect(made).toMatchObject({ token: 't1', maker: mia, cards, thumb: img });
    expect(made!.recipe.id).toBe(quadruped.id);
    expect(s.ws.busy).toBe(false);
    expect(s.c.ui.at(-1)).toBe('close');
    look.resolve(edit);
    await turn;
    expect(s.kinds()).not.toContain('preview');
    expect(s.kinds()).not.toContain('failed');
    expect(s.c.shown.length).toBe(1); // the fix after the cancel is never built
  });

  it('during a build: waits for that build to return, then keeps it', async () => {
    const built = later<BodyData>();
    const s = setup({ build: () => built.promise });
    const turn = s.ws.turn('t1', mia, input);
    while (!s.kinds().includes('step building')) await tick();
    const cancelled = s.ws.cancel('t1');
    await tick();
    expect(s.ws.busy).toBe(true); // the build is still running
    built.resolve({ key: 'b', size: 1 } as unknown as BodyData);
    const made = await cancelled;
    expect(made?.body).toEqual({ key: 'b', size: 1 });
    expect(s.ws.busy).toBe(false);
    await turn;
    expect(s.kinds()).not.toContain('step looking 1');
  });

  it('at the preview: returns the made creature; a second cancel and a stranger’s are ignored', async () => {
    const s = setup();
    await s.ws.turn('t1', mia, input);
    expect(await s.ws.cancel('t2')).toBeNull();
    expect(s.ws.busy).toBe(true);
    const made = await s.ws.cancel('t1');
    expect(made?.cards).toEqual(cards);
    expect(s.c.ui.at(-1)).toBe('close');
    expect(s.kinds()).not.toContain('failed'); // the valley says `kept` (onKept)
    expect(await s.ws.cancel('t1')).toBeNull();
    expect(s.ws.busy).toBe(false);
  });
});

describe('connectWorkshop', () => {
  function wire() {
    const s = setup();
    type St = 'hosting' | 'reconnecting' | 'replaced';
    const listeners: ((m: HostMsg) => void)[] = [], statuses: ((st: St, fresh?: boolean) => void)[] = [];
    const making: boolean[] = [], released: Made[] = [], kept: Made[] = [];
    const link = connectWorkshop(
      { on: (fn) => (listeners.push(fn), () => {}), onStatus: (fn) => (statuses.push(fn), () => {}), setMaking: (b) => void making.push(b) },
      s.ws,
      { onRelease: (m) => void released.push(m), onKept: (m) => void kept.push(m) },
    );
    const msg = (m: HostMsg) => listeners.forEach((fn) => fn(m));
    const status = (st: St, fresh?: boolean) => statuses.forEach((fn) => fn(st, fresh));
    const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
    return { ...s, link, msg, status, making, released, kept, settle };
  }

  it('routes a turn, a tweak and a release; the release goes to onRelease and the card stops "making"', async () => {
    const w = wire();
    w.msg({ type: 'turn', token: 't1', maker: mia, input });
    await w.settle();
    expect(w.kinds().at(-1)).toBe('preview');
    w.msg({ type: 'tweak', token: 't1', words: 'Bigger!' });
    await w.settle();
    expect(w.kinds().at(-1)).toBe('tweaked');
    w.msg({ type: 'release', token: 't1' });
    expect(w.released.map((m) => m.cards.name)).toEqual(['Big Puff']);
    expect(w.making.at(-1)).toBe(false);
  });

  it('a cancel at the preview goes to onKept; Back does the same', async () => {
    const w = wire();
    w.msg({ type: 'turn', token: 't1', maker: mia, input });
    await w.settle();
    w.msg({ type: 'cancel', token: 't1' });
    await w.settle();
    expect(w.kept.length).toBe(1);
    w.msg({ type: 'turn', token: 't2', maker: mia, input });
    await w.settle();
    await w.link.back();
    expect(w.kept.map((m) => m.token)).toEqual(['t1', 't2']);
    expect(w.making.at(-1)).toBe(false);
  });

  it('back on the relay while busy: "making" again and the last message re-sent (the relay does not replay it)', async () => {
    const w = wire();
    w.msg({ type: 'turn', token: 't1', maker: mia, input });
    await w.settle();
    const n = w.c.sent.length;
    w.status('reconnecting');
    w.status('hosting', false);
    await w.settle();
    expect(w.making.at(-1)).toBe(true);
    expect(w.c.sent.slice(n).map(([, m]) => m.type)).toEqual(['preview']);
  });

  it('a fresh registration (the relay restarted and forgot the phone): the creature at the preview is kept, the TV clears', async () => {
    const w = wire();
    w.msg({ type: 'turn', token: 't1', maker: mia, input });
    await w.settle();
    const n = w.c.sent.length;
    w.status('reconnecting');
    w.status('hosting', true);
    await w.settle();
    expect(w.kept.map((m) => m.token)).toEqual(['t1']);
    expect(w.ws.busy).toBe(false);
    expect(w.c.ui.at(-1)).toBe('close');
    expect(w.making.at(-1)).toBe(false);
    expect(w.c.sent.slice(n).map(([, m]) => m.type)).not.toContain('preview'); // nothing re-sent to a phone it never knew
  });

  it('a fresh registration while nothing was made yet just closes', async () => {
    const read = later<ReadResult>();
    const s = setup({ read: () => read.promise });
    const statuses: ((st: 'hosting' | 'reconnecting' | 'replaced', fresh?: boolean) => void)[] = [], kept: Made[] = [];
    connectWorkshop({ on: () => () => {}, onStatus: (fn) => (statuses.push(fn), () => {}), setMaking: () => {} }, s.ws,
      { onRelease: () => {}, onKept: (m) => void kept.push(m) });
    void s.ws.turn('t1', mia, input);
    statuses.forEach((fn) => fn('hosting', true));
    for (let i = 0; i < 20; i++) await tick();
    expect(s.ws.busy).toBe(false);
    expect(kept).toEqual([]);
    expect(s.c.ui.at(-1)).toBe('close');
  });

  it('a new turn while another is still open: the made one is kept first, then the new one is made', async () => {
    const w = wire();
    w.msg({ type: 'turn', token: 't1', maker: mia, input });
    await w.settle();
    w.msg({ type: 'turn', token: 't2', maker: { name: 'Zag', badge: '🐻' }, input });
    await w.settle();
    expect(w.kept.map((m) => m.token)).toEqual(['t1']);
    expect(w.ws.token).toBe('t2');
    expect(w.c.sent.at(-1)).toEqual(['t2', { type: 'preview', cards }]);
    expect(w.making.at(-1)).not.toBe(false); // still making: the card stays up
  });

  it('a page that another valley page replaced lets its turn go without keeping it', async () => {
    const w = wire();
    w.msg({ type: 'turn', token: 't1', maker: mia, input });
    await w.settle();
    w.status('replaced');
    await w.settle();
    expect(w.ws.busy).toBe(false);
    expect(w.kept).toEqual([]);
  });
});

describe('connectWorkshop: a turn waits for the arrival on screen (Ruling R17)', () => {
  function wired() {
    const s = setup();
    type St = 'hosting' | 'reconnecting' | 'replaced';
    const listeners: ((m: HostMsg) => void)[] = [], statuses: ((st: St, fresh?: boolean) => void)[] = [];
    const making: boolean[] = [];
    let free = later<void>();
    const link = connectWorkshop(
      { on: (fn) => (listeners.push(fn), () => {}), onStatus: (fn) => (statuses.push(fn), () => {}), setMaking: (b) => void making.push(b) },
      s.ws,
      { onRelease: () => {}, onKept: () => {}, ready: () => free.promise },
    );
    const msg = (m: HostMsg) => listeners.forEach((fn) => fn(m));
    const status = (st: St, fresh?: boolean) => statuses.forEach((fn) => fn(st, fresh));
    const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
    return { ...s, link, msg, status, making, settle, free: () => free.resolve(), hold: () => (free = later<void>()) };
  }

  it('does not open the workshop until the hold has ended, then makes the creature', async () => {
    const w = wired();
    w.msg({ type: 'turn', token: 't2', maker: mia, input });
    await w.settle();
    expect(w.c.ui).toEqual([]); // the TV is not dimmed over the arrival
    expect(w.c.sent).toEqual([]);
    expect(w.ws.busy).toBe(false);
    w.free();
    await w.settle();
    expect(w.c.ui[0]).toBe('open Zig');
    expect(w.kinds().at(-1)).toBe('preview');
  });

  it('a cancel while it waits: never shown, the phone hears failed (nothing was made), and it never starts', async () => {
    const w = wired();
    w.msg({ type: 'turn', token: 't2', maker: mia, input });
    await w.settle();
    w.msg({ type: 'cancel', token: 't2' });
    await w.settle();
    expect(w.c.sent).toEqual([['t2', { type: 'failed', message: TRY_AGAIN, retry: true }]]);
    expect(w.making.at(-1)).toBe(false);
    w.free();
    await w.settle();
    expect(w.c.ui).toEqual([]);
    expect(w.ws.busy).toBe(false);
    expect(await w.link.back()).toBeUndefined(); // Back has nothing to close
  });

  it('a restarted relay forgets the waiting turn; a reattached one keeps it', async () => {
    const w = wired();
    w.msg({ type: 'turn', token: 't2', maker: mia, input });
    await w.settle();
    w.status('reconnecting');
    w.status('hosting', false);
    expect(w.making.at(-1)).toBe(true);
    w.status('reconnecting');
    w.status('hosting', true);
    w.free();
    await w.settle();
    expect(w.c.ui).toEqual([]);
    expect(w.c.sent).toEqual([]);
  });
});

describe('turn-ending messages are sent again once if the relay did not take them', () => {
  it('sendEnd tries once more after a pause, and no more', async () => {
    const tries: boolean[] = [];
    const send = async () => (tries.push(true), tries.length > 1);
    expect(await sendEnd(send, 't1', { type: 'released' }, 1)).toBe(true);
    expect(tries.length).toBe(2);
    const never = async () => (tries.push(false), false);
    expect(await sendEnd(never, 't1', { type: 'kept' }, 1)).toBe(false);
    expect(tries.length).toBe(4);
    expect(await sendEnd(async () => { throw new Error('offline'); }, 't1', { type: 'kept' }, 1)).toBe(false);
  });

  it('a failed turn the relay missed is said again; the steps are not', async () => {
    let first = true;
    const s = setup({ read: async () => { throw new DesignerResting('503'); }, taken: (m) => m.type !== 'failed' || !(first && !(first = false)) });
    await s.ws.turn('t1', mia, input);
    expect(s.kinds()).toEqual(['step reading', 'failed', 'failed']);
  });
});

describe('connectWorkshop: the end of every wait (final review)', () => {
  function wired(hooks: Partial<WorkshopHooks> = {}, o: Parameters<typeof setup>[0] = {}) {
    const s = setup(o);
    const listeners: ((m: HostMsg) => void)[] = [];
    const calls: string[] = [];
    const link = connectWorkshop(
      { on: (fn) => (listeners.push(fn), () => {}), onStatus: () => () => {}, setMaking: () => {} },
      s.ws,
      { onRelease: () => {}, onKept: () => {}, opening: () => void calls.push(`opening (${s.c.ui.length} ui calls before)`), ...hooks },
    );
    const msg = (m: HostMsg) => listeners.forEach((fn) => fn(m));
    const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
    return { ...s, link, msg, settle, calls };
  }

  it('a cancel for a turn this page does not have is answered failed, so the relay can move the line on', async () => {
    const w = wired();
    w.msg({ type: 'cancel', token: 'lost' });
    await w.settle();
    expect(w.c.sent).toEqual([['lost', { type: 'failed', message: TRY_AGAIN, retry: true }]]);
  });

  it('a cancel while the release is still saving is left to the release’s own answer', async () => {
    const saving = later<void>();
    const w = wired({ onRelease: () => saving.promise });
    w.msg({ type: 'turn', token: 't1', maker: mia, input });
    await w.settle();
    w.msg({ type: 'release', token: 't1' });
    w.msg({ type: 'cancel', token: 't1' });
    await w.settle();
    expect(w.kinds()).not.toContain('failed');
    saving.resolve();
    await w.settle();
    w.msg({ type: 'cancel', token: 't1' }); // the release is done: a cancel now means its answer was lost
    await w.settle();
    expect(w.kinds().at(-1)).toBe('failed');
  });

  it('a cancel while the keep is still saving is not answered twice', async () => {
    const saving = later<void>();
    const kept: string[] = [];
    const w = wired({ onKept: (m) => (kept.push(m.token), saving.promise) });
    w.msg({ type: 'turn', token: 't1', maker: mia, input });
    await w.settle();
    void w.link.back();
    await w.settle();
    w.msg({ type: 'cancel', token: 't1' });
    await w.settle();
    expect(kept).toEqual(['t1']);
    expect(w.kinds()).not.toContain('failed');
    saving.resolve();
  });

  it('a new turn waits for a "try again" to have its seconds on the screen (spec §3.5)', async () => {
    let clear = later<void>();
    const w = wired({}, { idle: () => clear.promise });
    w.msg({ type: 'turn', token: 't2', maker: mia, input });
    await w.settle();
    expect(w.c.ui).toEqual([]);
    expect(w.link.waiting).toBe(true);
    clear.resolve();
    clear = later<void>();
    await w.settle();
    expect(w.c.ui[0]).toBe('open Zig');
    expect(w.link.waiting).toBe(false);
  });

  it('opening comes once the stage is free, just before the workshop takes the screen; waiting meanwhile', async () => {
    const free = later<void>();
    const w = wired({ ready: () => free.promise });
    w.msg({ type: 'turn', token: 't2', maker: mia, input });
    await w.settle();
    expect(w.calls).toEqual([]);
    expect(w.link.waiting).toBe(true); // the menu stays shut: B cannot reach the turn
    free.resolve();
    await w.settle();
    expect(w.calls).toEqual(['opening (0 ui calls before)']);
    expect(w.c.ui[0]).toBe('open Zig');
    expect(w.link.waiting).toBe(false);
  });

  it('a turn cancelled while it waited never opens (no opening)', async () => {
    const free = later<void>();
    const w = wired({ ready: () => free.promise });
    w.msg({ type: 'turn', token: 't2', maker: mia, input });
    await w.settle();
    w.msg({ type: 'cancel', token: 't2' });
    free.resolve();
    await w.settle();
    expect(w.calls).toEqual([]);
    expect(w.link.waiting).toBe(false);
  });
});
