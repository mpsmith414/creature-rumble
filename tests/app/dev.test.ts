import { describe, expect, test } from 'vitest';
import { fillSpecial } from '../../src/app/dev';
import type { Fighter } from '../../src/fight/fighter';

const fighter = (id: string, state = 'fighting') => ({ id, state, special: { meter: 0, active: null } }) as unknown as Fighter;

describe('the dev panel’s S key', () => {
  test('fills the next fighter’s special meter, round the ring, skipping anyone not fighting', () => {
    const fs = [fighter('a'), fighter('b', 'out'), fighter('c'), fighter('d', 'entering')];
    expect(fillSpecial(fs, null)?.id).toBe('a');
    expect(fs[0].special.meter).toBe(1);
    expect(fillSpecial(fs, 'a')?.id).toBe('c');
    expect(fs[2].special.meter).toBe(1);
    expect(fillSpecial(fs, 'c')?.id).toBe('a');
    expect(fs[1].special.meter).toBe(0);
    expect(fs[3].special.meter).toBe(0);
  });

  test('does nothing with nobody fighting', () => {
    expect(fillSpecial([fighter('a', 'out')], null)).toBeNull();
  });
});
