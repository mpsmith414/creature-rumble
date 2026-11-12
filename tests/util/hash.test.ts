import { describe, expect, it } from 'vitest';
import { hash, hashNumbers, stableStringify } from '../../src/util/hash';
import { mulberry32 } from '../../src/util/rng';

describe('hash', () => {
  it('ignores key order', () => {
    expect(hash({ a: 1, b: { c: 2, d: 3 } })).toBe(hash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it('differs for different values', () => {
    expect(hash({ a: 1 })).not.toBe(hash({ a: 2 }));
    expect(hashNumbers([1, 2, 3])).not.toBe(hashNumbers([1, 2, 4]));
  });
  it('rng repeats per seed', () => {
    const a = mulberry32(7), b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
