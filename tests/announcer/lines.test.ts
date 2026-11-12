import { describe, expect, it } from 'vitest';
import { fillSlots, LINE_MAX, LINES } from '../../src/announcer/lines';

const ALL_SLOTS = { name: 'Sir Bounces', other: 'Captain Wobble', names: 'Sir Bounces, Captain Wobble and Pip', maker: 'Pickle', weight: 'two tons' };

describe('LINES', () => {
  it('every bank has enough variants and fills its slots', () => {
    for (const [beat, bank] of Object.entries(LINES)) {
      expect(bank.length, beat).toBeGreaterThanOrEqual(beat === 'hit' || beat === 'bigHit' ? 30 : 8);
      for (const l of bank) expect(fillSlots(l, ALL_SLOTS), l).not.toMatch(/[{}]/);
    }
  });

  it('every line is short, even with long names, and none repeats', () => {
    const long = { name: 'Sir Bouncealot', other: 'Captain Wobble', names: 'Sir Bounces, Captain Wobble and Pip' };
    for (const [beat, bank] of Object.entries(LINES)) {
      expect(new Set(bank).size, beat).toBe(bank.length);
      for (const l of bank) expect(fillSlots(l, long).length, l).toBeLessThanOrEqual(LINE_MAX);
    }
  });

  it('leaves no slot showing when the scene gave none', () => {
    for (const bank of Object.values(LINES)) for (const l of bank) expect(fillSlots(l, {})).not.toMatch(/[{}]/);
  });

  it('shouts names and lets a name holding braces make no new slot', () => {
    expect(fillSlots('Hi {name} and {other}!', { name: 'Pip', other: '{name}' })).toBe('Hi PIP and NAME!');
  });

  it('keeps to kind words', () => {
    const banned = /\b(hurt|hurts|kill|killed|die|dies|blood|dead|pain|stupid|ugly|loser)\b/i;
    for (const bank of Object.values(LINES)) for (const l of bank) expect(l).not.toMatch(banned);
  });
});
