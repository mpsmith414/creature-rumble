import { describe, expect, test } from 'vitest';
import { fillIntro, INTRO_MAX, makerName, MYSTERY_MAKER } from '../../src/show/intro';
import { KINDS, loadFixture } from '../fixtures/fighters';

describe('fillIntro', () => {
  test('puts the maker’s name where {maker} is, every time', () => {
    expect(fillIntro('From the bedroom of {maker}! {maker} made it!', 'Pickle')).toBe('From the bedroom of Pickle! Pickle made it!');
  });

  test('a mystery maker when nobody is known', () => {
    for (const m of [null, undefined, '', '   ']) expect(fillIntro('From {maker}!', m)).toBe(`From ${MYSTERY_MAKER}!`);
    expect(makerName(' Sam ')).toBe('Sam');
    expect(makerName(null)).toBe('a mystery maker');
  });

  test('a name with $ signs or braces goes in as typed', () => {
    expect(fillIntro('Hi {maker}!', '$& {maker}')).toBe('Hi $& {maker}!');
  });

  test('keeps a short intro whole', () => {
    expect(fillIntro("It's... PIP!", 'Pickle')).toBe("It's... PIP!");
  });

  test('cuts a long intro to 220 characters at a word boundary, with an ellipsis', () => {
    const words = 'BOING '.repeat(60).trim();
    const out = fillIntro(words, 'Pickle');
    expect(out.length).toBeLessThanOrEqual(INTRO_MAX);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, -1).split(' ').every((w) => w === 'BOING')).toBe(true);
    expect(INTRO_MAX).toBe(220);
  });

  test('measures after the name goes in', () => {
    const intro = `From the bedroom of {maker}! ${'x '.repeat(90)}`.trim();
    expect(intro.length).toBeLessThan(INTRO_MAX);
    expect(fillIntro(intro, 'Bartholomew-Maximilian').length).toBeLessThanOrEqual(INTRO_MAX);
  });

  test('one endless word is cut hard', () => {
    const out = fillIntro('A'.repeat(500), null);
    expect(out.length).toBe(INTRO_MAX);
    expect(out.endsWith('…')).toBe(true);
  });
});

test('every fixture intro names its maker with the {maker} placeholder', () => {
  for (const k of KINDS) expect(loadFixture(k).fight?.intro).toContain('{maker}');
});
