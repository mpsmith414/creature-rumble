import { describe, expect, it } from 'vitest';
import { pickWorker, transferables } from '../../src/builder/pool';
import type { BodyData } from '../../src/builder/build';

describe('pickWorker', () => {
  it('chooses the worker with the fewest pending requests', () => {
    expect(pickWorker([3, 1, 2])).toBe(1);
    expect(pickWorker([2, 2, 0, 5])).toBe(2);
  });
  it('breaks ties towards the lowest index', () => {
    expect(pickWorker([0, 0, 0])).toBe(0);
    expect(pickWorker([2, 1, 1])).toBe(1);
  });
  it('skips dead workers (Infinity) and gives -1 when none is alive', () => {
    expect(pickWorker([Infinity, 5, 3])).toBe(2);
    expect(pickWorker([Infinity, Infinity, 0])).toBe(2);
    expect(pickWorker([Infinity, Infinity])).toBe(-1);
  });
  it('spreads a burst evenly', () => {
    const pending = [0, 0, 0];
    const got = Array.from({ length: 7 }, () => { const i = pickWorker(pending); pending[i]++; return i; });
    expect(got).toEqual([0, 1, 2, 0, 1, 2, 0]);
  });
});

describe('transferables', () => {
  it('lists every typed array buffer of every LOD, once each', () => {
    const shared = new Float32Array(4);
    const lod = { positions: new Float32Array(3), indices: new Uint32Array(3), skinIndex: new Uint16Array(4), extra: new Float32Array(2), twin: shared, same: shared, n: 5, s: 'x' };
    const list = transferables({ lods: [lod, { ...lod, positions: new Float32Array(3) }] } as unknown as BodyData);
    expect(list).toContain(lod.positions.buffer);
    expect(list).toContain(lod.extra.buffer);
    expect(list.length).toBe(new Set(list).size);
    expect(list.every((b) => b instanceof ArrayBuffer)).toBe(true);
  });
});
