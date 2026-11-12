import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DailyCap, DEFAULT_LIMIT, LIMITS } from '../../server/cap';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-')), 'daily.json');

describe('DailyCap', () => {
  it('starts at the default limit with nothing taken', () => {
    const day = new Date(2026, 9, 14, 12, 0);
    expect(new DailyCap({ now: () => day }).state()).toEqual({ day: '2026-10-14', count: 0, limit: DEFAULT_LIMIT });
    expect(LIMITS).toEqual([5, 10, 20, 50]);
  });

  it('counts up to the limit, then is full and refuses', () => {
    const cap = new DailyCap({ now: () => new Date(2026, 9, 14, 12, 0) });
    cap.setLimit(5);
    for (let i = 0; i < 5; i++) {
      expect(cap.full()).toBe(false);
      expect(cap.take()).toBe(true);
    }
    expect(cap.full()).toBe(true);
    expect(cap.take()).toBe(false);
    expect(cap.state().count).toBe(5);
  });

  it('resets the count at local midnight but keeps the limit', () => {
    let now = new Date(2026, 9, 14, 23, 59);
    const cap = new DailyCap({ now: () => now });
    cap.setLimit(5);
    for (let i = 0; i < 5; i++) cap.take();
    expect(cap.full()).toBe(true);
    now = new Date(2026, 9, 15, 0, 1);
    expect(cap.state()).toEqual({ day: '2026-10-15', count: 0, limit: 5 });
    expect(cap.full()).toBe(false);
  });

  it('persists the limit and count across instances on the same file', () => {
    const file = tmpFile();
    const now = () => new Date(2026, 9, 14, 12, 0);
    const a = new DailyCap({ file, now });
    a.setLimit(20);
    a.take();
    expect(new DailyCap({ file, now }).state()).toEqual({ day: '2026-10-14', count: 1, limit: 20 });
    // the next day only the limit survives
    expect(new DailyCap({ file, now: () => new Date(2026, 9, 15, 8, 0) }).state()).toEqual({ day: '2026-10-15', count: 0, limit: 20 });
  });

  it('writes atomically (no temp file left behind)', () => {
    const file = tmpFile();
    new DailyCap({ file }).take();
    expect(fs.readdirSync(path.dirname(file))).toEqual(['daily.json']);
  });

  it('creates the data folder when it is missing', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-')), 'data', 'daily.json');
    new DailyCap({ file }).take();
    expect(fs.existsSync(file)).toBe(true);
  });

  it('only accepts a limit from LIMITS', () => {
    const cap = new DailyCap({});
    expect(() => cap.setLimit(7)).toThrow();
    expect(cap.state().limit).toBe(DEFAULT_LIMIT);
    expect(cap.setLimit(50).limit).toBe(50);
  });

  it('starts fresh from a corrupt or odd file', () => {
    const now = () => new Date(2026, 9, 14, 12, 0);
    const fresh = { day: '2026-10-14', count: 0, limit: DEFAULT_LIMIT };
    const file = tmpFile();
    fs.writeFileSync(file, '{not json');
    expect(new DailyCap({ file, now }).state()).toEqual(fresh);
    fs.writeFileSync(file, JSON.stringify({ day: '2026-10-14', count: -3, limit: 7 }));
    expect(new DailyCap({ file, now }).state()).toEqual(fresh);
    expect(new DailyCap({ file: path.join(path.dirname(file), 'missing.json'), now }).state()).toEqual(fresh);
  });
});
