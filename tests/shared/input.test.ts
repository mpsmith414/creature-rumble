import { describe, expect, it } from 'vitest';
import { nextFocus, type Rect } from '../../src/shared/focus';
import { EMPTY_PAD, Input, edges, readPad } from '../../src/shared/input';

describe('readPad', () => {
  const pad = (axes: number[], pressed: number[] = []) => ({ axes, buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: pressed.includes(i) })) });

  it('ignores small stick drift and maps buttons', () => {
    const s = readPad(pad([0.1, -0.05, 0.9, 0], [0, 12]));
    expect(s.lx).toBe(0);
    expect(s.ly).toBe(0);
    expect(s.rx).toBeGreaterThan(0.8);
    expect(s.a).toBe(true);
    expect(s.up).toBe(true);
    expect(s.b).toBe(false);
    expect(readPad(null)).toEqual(EMPTY_PAD);
  });

  it('reports only newly pressed buttons', () => {
    const a = readPad(pad([0, 0, 0, 0], [0]));
    const b = readPad(pad([0, 0, 0, 0], [0, 1]));
    expect(edges(a, b)).toEqual(['b']);
    expect(edges(b, b)).toEqual([]);
  });
});

describe('Input.mouse', () => {
  it('returns zero when nothing moved', () => {
    const input = new Input(new EventTarget());
    expect(input.mouse()).toEqual({ dx: 0, dy: 0 });
    expect(input.pad()).toEqual(EMPTY_PAD);
    expect(input.held('W')).toBe(false);
  });
});

describe('nextFocus', () => {
  // a 3 × 2 grid of buttons
  const grid: Rect[] = [0, 1, 2].flatMap((c) => [0, 1].map((r) => ({ id: `${r}${c}`, x: c * 100, y: r * 60, w: 80, h: 40 })));

  it('moves to the neighbour in the pressed direction', () => {
    expect(nextFocus(grid, '00', 'right')).toBe('01');
    expect(nextFocus(grid, '00', 'down')).toBe('10');
    expect(nextFocus(grid, '12', 'up')).toBe('02');
    expect(nextFocus(grid, '11', 'left')).toBe('10');
  });

  it('stays put when nothing lies that way', () => {
    expect(nextFocus(grid, '00', 'left')).toBe('00');
    expect(nextFocus(grid, '00', 'up')).toBe('00');
  });
});
