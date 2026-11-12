import { describe, expect, it } from 'vitest';
import type { PhoneMsg } from '../../src/bring/protocol';
import { CROWN_HOLD_S, draftSpent, holdProgress, initial, reduce, ringButtons, showsTabs, type Action, type PhoneState } from '../../src/phone/state';

const maker = { name: 'Zig', badge: '🦊' };
const cards = { name: 'Zib', eats: 'leaves 🍃', speed: 'zippy ⚡', mood: 'shy 🌸', special: 'glows' };
const msg = (s: PhoneState, m: PhoneMsg) => reduce(s, { type: 'msg', msg: m });
const joined: PhoneState = reduce(initial, { type: 'joined', maker });

describe('phone state: single rules', () => {
  it('starts on the join screen with an empty draft', () => {
    expect(initial).toMatchObject({ screen: 'join', maker: null, draft: { hasImage: false, words: '' } });
  });
  it('joining lands on make with the maker', () => {
    expect(joined).toMatchObject({ screen: 'make', maker });
  });
  it('rescan shows the rescan screen', () => {
    expect(reduce(joined, { type: 'rescan' }).screen).toBe('rescan');
  });
  it('draft updates merge and keep what was not mentioned', () => {
    const a = reduce(joined, { type: 'draft', hasImage: true });
    const b = reduce(a, { type: 'draft', words: 'a fox' });
    expect(b.draft).toEqual({ hasImage: true, words: 'a fox' });
    expect(reduce(b, { type: 'draft', hasImage: false }).draft).toEqual({ hasImage: false, words: 'a fox' });
  });
  it('submitted waits for the line to say where we are', () => {
    expect(reduce(joined, { type: 'submitted' }).screen).toBe('waiting');
  });
  it('line place 0 is making, 1 and up is waiting with the place and who is ahead', () => {
    expect(msg(joined, { type: 'line', place: 0, ahead: [] }).screen).toBe('making');
    const w = msg(joined, { type: 'line', place: 2, ahead: [maker] });
    expect(w).toMatchObject({ screen: 'waiting', place: 2, ahead: [maker] });
  });
  it('a repeated line 0 does not wipe the step already showing', () => {
    const s = msg(msg(joined, { type: 'line', place: 0, ahead: [] }), { type: 'step', step: { kind: 'building' } });
    expect(msg(s, { type: 'line', place: 0, ahead: [] }).step).toEqual({ kind: 'building' });
  });
  it('step goes to making with the step', () => {
    expect(msg(joined, { type: 'step', step: { kind: 'looking', pass: 1 } })).toMatchObject({ screen: 'making', step: { kind: 'looking', pass: 1 } });
  });
  it('preview shows cards and tweaks left; tweaked adds the note', () => {
    const p = msg(joined, { type: 'preview', cards, tweaksLeft: 5 });
    expect(p).toMatchObject({ screen: 'preview', cards, tweaksLeft: 5 });
    expect(p.note).toBeUndefined();
    const t = msg(p, { type: 'tweaked', cards: { ...cards, name: 'Zab' }, note: 'Made it bluer!', tweaksLeft: 4 });
    expect(t).toMatchObject({ screen: 'preview', cards: { name: 'Zab' }, note: 'Made it bluer!', tweaksLeft: 4 });
    expect(msg(t, { type: 'preview', cards, tweaksLeft: 4 }).note).toBeUndefined();
  });
  it('released, kept, resting and noHost map to their screens', () => {
    expect(msg(joined, { type: 'released' }).screen).toBe('released');
    expect(msg(joined, { type: 'kept' }).screen).toBe('kept');
    expect(msg(joined, { type: 'resting' }).screen).toBe('resting');
    expect(msg(joined, { type: 'noHost' }).screen).toBe('noHost');
  });
  it('failed carries the message and whether to retry', () => {
    expect(msg(joined, { type: 'failed', message: 'Hmm!', retry: true })).toMatchObject({ screen: 'failed', message: 'Hmm!', retry: true });
  });
  it('again goes back to make, keeps the draft and drops the old result', () => {
    const failed = msg(reduce(joined, { type: 'draft', hasImage: true, words: 'owl' }), { type: 'failed', message: 'Hmm!', retry: true });
    const a = reduce(failed, { type: 'again' });
    expect(a).toMatchObject({ screen: 'make', maker, draft: { hasImage: true, words: 'owl' } });
    expect(a.message).toBeUndefined();
    expect(a.retry).toBeUndefined();
  });
});

describe('phone state: hello restores from the snapshot', () => {
  const hello = (s: PhoneState, state: Extract<PhoneMsg, { type: 'hello' }>['state']) => msg(s, { type: 'hello', state });
  it('idle is make, or join with no maker', () => {
    expect(hello(joined, { phase: 'idle' }).screen).toBe('make');
    expect(hello(initial, { phase: 'idle' }).screen).toBe('join');
  });
  it('waiting keeps the place', () => {
    expect(hello(joined, { phase: 'waiting', place: 3 })).toMatchObject({ screen: 'waiting', place: 3 });
  });
  it('making, preview, released, kept and resting', () => {
    expect(hello(joined, { phase: 'making' }).screen).toBe('making');
    expect(hello(joined, { phase: 'preview', cards, tweaksLeft: 2 })).toMatchObject({ screen: 'preview', cards, tweaksLeft: 2 });
    expect(hello(joined, { phase: 'released' }).screen).toBe('released');
    expect(hello(joined, { phase: 'kept' }).screen).toBe('kept');
    expect(hello(joined, { phase: 'resting' }).screen).toBe('resting');
  });
  it('a rejoined phone (fresh page, stored maker) lands on the same preview', () => {
    const fresh: PhoneState = { ...initial, maker };
    expect(hello(fresh, { phase: 'preview', cards, tweaksLeft: 5 })).toMatchObject({ screen: 'preview', maker, cards });
  });
  it('keeps the draft', () => {
    const s = reduce(joined, { type: 'draft', words: 'a bear' });
    expect(hello(s, { phase: 'waiting', place: 1 }).draft.words).toBe('a bear');
  });
});

describe('phone state: a whole turn', () => {
  it('join, draft, submit, line 2, 1, 0, steps, preview, tweak, release', () => {
    let s = initial;
    const seen: string[] = [];
    const go = (a: Action) => { s = reduce(s, a); seen.push(s.screen); };
    go({ type: 'joined', maker });
    go({ type: 'draft', hasImage: true });
    go({ type: 'draft', words: 'a purple fox' });
    go({ type: 'submitted' });
    go({ type: 'msg', msg: { type: 'line', place: 2, ahead: [maker, maker] } });
    expect(s.place).toBe(2);
    go({ type: 'msg', msg: { type: 'line', place: 1, ahead: [maker] } });
    expect(s.place).toBe(1);
    go({ type: 'msg', msg: { type: 'line', place: 0, ahead: [] } });
    go({ type: 'msg', msg: { type: 'step', step: { kind: 'reading' } } });
    go({ type: 'msg', msg: { type: 'step', step: { kind: 'looking', pass: 1 } } });
    expect(s.step).toEqual({ kind: 'looking', pass: 1 });
    go({ type: 'msg', msg: { type: 'preview', cards, tweaksLeft: 5 } });
    go({ type: 'msg', msg: { type: 'tweaked', cards, note: 'Done!', tweaksLeft: 4 } });
    go({ type: 'msg', msg: { type: 'released' } });
    expect(seen).toEqual(['make', 'make', 'make', 'waiting', 'waiting', 'waiting', 'making', 'making', 'making', 'preview', 'preview', 'released']);
    expect(s.draft).toEqual({ hasImage: true, words: 'a purple fox' });
  });
});

describe('draftSpent: the sent draft is on the TV now', () => {
  const onStage = msg(reduce(reduce(joined, { type: 'draft', words: 'a fox' }), { type: 'submitted' }), { type: 'preview', cards, tweaksLeft: 5 });
  it('a live `released` spends the sent draft', () => {
    expect(draftSpent(msg(onStage, { type: 'released' }), true)).toBe(true);
  });
  it('so does the rejoin hello after a lock or refresh that missed it', () => {
    expect(draftSpent(msg(onStage, { type: 'hello', state: { phase: 'released' } }), true)).toBe(true);
    const refreshed: PhoneState = { ...initial, maker, screen: 'make' };
    expect(draftSpent(msg(refreshed, { type: 'hello', state: { phase: 'released' } }), true)).toBe(true);
  });
  it('a draft edited since it was sent is kept (a new creature being made)', () => {
    expect(draftSpent(msg(onStage, { type: 'hello', state: { phase: 'released' } }), false)).toBe(false);
  });
  it('kept, failed and any other screen keep it', () => {
    for (const m of [{ type: 'kept' }, { type: 'failed', message: 'x', retry: true }, { type: 'hello', state: { phase: 'kept' } }, { type: 'resting' }] as PhoneMsg[]) {
      expect(draftSpent(msg(onStage, m), true)).toBe(false);
    }
  });
});

describe('an acknowledged outcome stays acknowledged (ruling R8)', () => {
  const hi = (s: PhoneState, state: Extract<PhoneMsg, { type: 'hello' }>['state']) => msg(s, { type: 'hello', state });
  const drafted = reduce(joined, { type: 'draft', words: 'a new fox', hasImage: true });
  const finished = (m: PhoneMsg) => msg(drafted, m);
  it('Make another on released, then a rejoin hello released → make, draft intact', () => {
    const s = reduce(finished({ type: 'released' }), { type: 'again' });
    expect(s.seen).toBe('released');
    const back = hi(s, { phase: 'released' });
    expect(back.screen).toBe('make');
    expect(back.draft).toEqual({ hasImage: true, words: 'a new fox' });
  });
  it('the same for kept and resting', () => {
    expect(hi(reduce(finished({ type: 'kept' }), { type: 'again' }), { phase: 'kept' }).screen).toBe('make');
    expect(hi(reduce(finished({ type: 'resting' }), { type: 'again' }), { phase: 'resting' }).screen).toBe('make');
  });
  it('Try again on failed, then the idle hello → make', () => {
    const s = reduce(finished({ type: 'failed', message: 'x', retry: true }), { type: 'again' });
    expect(hi(s, { phase: 'idle' }).screen).toBe('make');
  });
  it('not acknowledged: hello released still shows released (the phone missed it)', () => {
    expect(hi(drafted, { phase: 'released' }).screen).toBe('released');
    expect(hi(finished({ type: 'released' }), { phase: 'released' }).screen).toBe('released');
  });
  it('acknowledged one outcome, told another: shows the other', () => {
    expect(hi(reduce(finished({ type: 'released' }), { type: 'again' }), { phase: 'kept' }).screen).toBe('kept');
  });
  it('acknowledged, then hello waiting / making / preview → those screens as usual (and the mark is gone)', () => {
    const s = reduce(finished({ type: 'released' }), { type: 'again' });
    const w = hi(s, { phase: 'waiting', place: 2 });
    expect(w).toMatchObject({ screen: 'waiting', place: 2 });
    expect(hi(s, { phase: 'making' }).screen).toBe('making');
    const p = hi(s, { phase: 'preview', cards, tweaksLeft: 5 });
    expect(p).toMatchObject({ screen: 'preview', cards, tweaksLeft: 5 });
    expect([w.seen, p.seen]).toEqual([undefined, undefined]);
  });
  it('the next submit clears it, so that creature`s release is shown', () => {
    const s = reduce(reduce(finished({ type: 'released' }), { type: 'again' }), { type: 'submitted' });
    expect(s.seen).toBeUndefined();
    expect(hi(s, { phase: 'released' }).screen).toBe('released');
  });
  it('the mark survives other screens until then (line, steps)', () => {
    const s = reduce(finished({ type: 'released' }), { type: 'again' });
    expect(reduce(s, { type: 'draft', words: 'x' }).seen).toBe('released');
    expect(hi(hi(s, { phase: 'released' }), { phase: 'released' }).screen).toBe('make');
  });
  it('live news of a new turn clears it even before `submitted` lands (straight onto the TV)', () => {
    const s = reduce(finished({ type: 'released' }), { type: 'again' });
    const onTv = msg(s, { type: 'line', place: 0, ahead: [] });
    expect(onTv.seen).toBeUndefined();
    expect(hi(onTv, { phase: 'released' }).screen).toBe('released');
  });
  it('noHost (the TV closed for a moment) keeps it', () => {
    const s = msg(reduce(finished({ type: 'released' }), { type: 'again' }), { type: 'noHost' });
    expect(hi(s, { phase: 'released' }).screen).toBe('make');
  });
  it('a fresh join forgets it', () => {
    const s = reduce(finished({ type: 'released' }), { type: 'again' });
    expect(reduce(s, { type: 'joined', maker }).seen).toBeUndefined();
  });
});

describe('the ring on the phone: crown, again and the Fighters tab (Task 16)', () => {
  const fighter = (id: string, crowns = 0) => ({ id, name: `Fighter ${id}`, maker: 'Zig', crowns, thumb: null });
  const ring = (phase: 'open' | 'crowned', fighting = 2) => ({ type: 'ring' as const, phase, fighting, roster: [fighter('r1', 1), fighter('r2')] });

  it('phone shows Crown in open and Again in crowned', () => {
    expect(ringButtons(reduce(joined, ring('open')))).toEqual({ crown: true, again: false });
    expect(ringButtons(reduce(joined, ring('crowned')))).toEqual({ crown: false, again: true });
    expect(ringButtons(reduce(joined, ring('open', 0)))).toEqual({ crown: false, again: false }); // nobody fighting: nothing to crown
    expect(ringButtons(joined)).toEqual({ crown: false, again: false }); // the TV has not said yet
    // the same news from the relay's stream
    expect(ringButtons(msg(joined, ring('crowned')))).toEqual({ crown: false, again: true });
  });

  it('crown needs a 2 s hold', () => {
    expect(CROWN_HOLD_S).toBe(2);
    expect(holdProgress(0)).toBe(0);
    expect(holdProgress(1)).toBeCloseTo(0.5);
    expect(holdProgress(1.9)).toBeLessThan(1);
    expect(holdProgress(2.0)).toBe(1);
    expect(holdProgress(5)).toBe(1);
    expect(holdProgress(-1)).toBe(0);
  });

  it('the ring changes no screen, no draft and no acknowledged outcome', () => {
    const s = reduce(reduce(reduce(joined, { type: 'draft', words: 'a fox' }), { type: 'msg', msg: { type: 'released' } }), { type: 'again' });
    const r = reduce(s, ring('open'));
    expect(r).toMatchObject({ screen: 'make', seen: 'released', draft: { words: 'a fox' } });
    expect(r.ring).toEqual({ phase: 'open', fighting: 2, roster: [fighter('r1', 1), fighter('r2')] });
  });

  it('the ring stays known across screens', () => {
    let s = reduce(joined, ring('open'));
    for (const m of [{ type: 'line', place: 2, ahead: [] }, { type: 'step', step: { kind: 'building' } }, { type: 'released' }, { type: 'resting' }] as PhoneMsg[]) {
      s = msg(s, m);
      expect(s.ring?.phase).toBe('open');
    }
    expect(reduce(s, { type: 'again' }).ring?.phase).toBe('open');
  });

  it('noHost forgets the ring (the TV that comes back may have a new match): no stale Crown or roster', () => {
    const s = msg(reduce(joined, ring('open')), { type: 'noHost' });
    expect(s.ring).toBeUndefined();
    expect(ringButtons(msg(s, { type: 'hello', state: { phase: 'idle' } }))).toEqual({ crown: false, again: false });
  });

  it('the Fighters tab opens and closes, and only where there are tabs', () => {
    const f = reduce(joined, { type: 'tab', tab: 'fighters' });
    expect(f.tab).toBe('fighters');
    expect(showsTabs(f)).toBe(true);
    expect(reduce(f, { type: 'tab', tab: 'flow' }).tab).toBe('flow');
    for (const screen of ['join', 'rescan', 'noHost'] as const) expect(showsTabs({ ...f, screen })).toBe(false);
  });

  it('news that changes the screen brings the kid back from Fighters to it; a new place in line does not', () => {
    const waiting = reduce(msg(joined, { type: 'line', place: 3, ahead: [] }), { type: 'tab', tab: 'fighters' });
    expect(msg(waiting, { type: 'line', place: 2, ahead: [] }).tab).toBe('fighters');
    expect(reduce(waiting, ring('crowned')).tab).toBe('fighters');
    expect(msg(waiting, { type: 'preview', cards, tweaksLeft: 5 }).tab ?? 'flow').toBe('flow');
  });
});
