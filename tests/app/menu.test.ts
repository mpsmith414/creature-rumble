import { describe, expect, test } from 'vitest';
import { CROWN_LABEL, menuModel, type MenuState } from '../../src/app/menu';

const base: MenuState = { phase: 'open', fighting: 0, joinShown: true, volume: 0.8, muted: false };
const ids = (s: MenuState) => menuModel(s).flatMap((r) => r.items.map((i) => i.id));

describe('the TV menu', () => {
  test('Crown shows only while the ring is open with someone in it; Again! only after a crowning', () => {
    expect(ids(base)).not.toContain('crown');
    expect(ids(base)).not.toContain('again');
    const open = menuModel({ ...base, fighting: 2 });
    expect(open[0].items).toEqual([{ id: 'crown', label: CROWN_LABEL }]);
    expect(ids({ ...base, fighting: 2 })).not.toContain('again');
    expect(ids({ ...base, phase: 'crowned', fighting: 1 })).toEqual(expect.arrayContaining(['again']));
    expect(ids({ ...base, phase: 'crowned', fighting: 1 })).not.toContain('crown');
  });

  test('always: Fighters, Show join code, Sound, Clear the ring and back to the fight', () => {
    expect(ids(base)).toEqual(['fighters', 'join', 'down', 'up', 'mute', 'clear', 'resume']);
    const labels = menuModel(base).flatMap((r) => r.items.map((i) => i.label));
    expect(labels).toEqual(expect.arrayContaining(['Fighters', 'Show join code', 'Clear the ring']));
  });

  test('the join code and the sound show their state; volume stops at its ends', () => {
    const row = (s: MenuState, id: string) => menuModel(s).find((r) => r.id === id)!;
    expect(row(base, 'join').items[0].selected).toBe(true);
    expect(row({ ...base, joinShown: false }, 'join').items[0].selected).toBe(false);
    expect(row(base, 'volume').level).toBe(8);
    expect(row({ ...base, volume: 0 }, 'volume').items[0].disabled).toBe(true);
    expect(row({ ...base, volume: 1 }, 'volume').items[1].disabled).toBe(true);
    const muted = row({ ...base, muted: true }, 'volume');
    expect(muted.off).toBe(true);
    expect(muted.items[2]).toMatchObject({ label: 'Sound on', selected: true });
  });
});
