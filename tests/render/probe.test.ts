import { afterEach, describe, expect, it, vi } from 'vitest';
import { probe } from '../../src/render/probe';

describe('probe', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes `ok` through and warns once per failing check', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(probe(true, 'fine')).toBe(true);
    expect(probe(false, 'broken thing')).toBe(false);
    expect(probe(false, 'broken thing')).toBe(false);
    expect(probe(false, 'another')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('broken thing');
  });
});
