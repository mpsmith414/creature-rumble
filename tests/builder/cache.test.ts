import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BodyData, LodMesh } from '../../src/builder/build';
import { bodyKey } from '../../src/builder/build';
import { MAX_BODIES, bodyCacheKey, loadBody, saveBody } from '../../src/builder/cache';
import { quadruped, biped } from '../fixtures/recipes';

const lod = (n: number): LodMesh => ({
  positions: new Float32Array([n, 1, 2, 3, 4, 5, 6, 7, 8]), normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]),
  skinIndex: new Uint16Array([0, 1, 0, 0, 1, 1, 0, 0, 2, 0, 0, 0]), skinWeight: new Float32Array(12).fill(0.25), region: new Float32Array([0, 1, 0]),
  partT: new Float32Array([0, 0.5, 1]), partS: new Float32Array([0.1, 0.2, 0.3]), boneOf: new Uint16Array([0, 1, 2]), feature: new Float32Array(12).fill(0.5),
  groom: new Float32Array(12).fill(0.5),
} as LodMesh);
const body = (n = 0): BodyData => ({
  key: `k${n}`,
  skeleton: { bones: [], contacts: [], jaw: -1, min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 1, z: 1 } } as unknown as BodyData['skeleton'],
  regions: ['body', 'tail'], lods: [lod(n), lod(n + 1)], mouth: null, jawLift: 0.012,
});
const key = (i: number | string) => `${__BUILDER_HASH__}:${i}`;
const count = async () => {
  const dbs = await indexedDB.databases();
  expect(dbs.map((d) => d.name)).toContain('creature-bodies');
  return new Promise<IDBValidKey[]>((res) => {
    const open = indexedDB.open('creature-bodies');
    open.onsuccess = () => {
      const db = open.result, r = db.transaction('bodies').objectStore('bodies').getAllKeys();
      r.onsuccess = () => (db.close(), res(r.result));
    };
  });
};

const putRaw = (value: unknown) =>
  new Promise<void>((res) => {
    const open = indexedDB.open('creature-bodies');
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction(['bodies', 'used'], 'readwrite'), v = value as { key: string; body: unknown; savedAt: number };
      tx.objectStore('bodies').put({ key: v.key, body: v.body });
      tx.objectStore('used').put({ key: v.key, usedAt: v.savedAt });
      tx.oncomplete = () => (db.close(), res());
    };
  });

describe('body cache', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('includes the builder hash and follows the recipe body key', () => {
    expect(__BUILDER_HASH__).toMatch(/^[0-9a-f]{12}$/);
    expect(bodyCacheKey(quadruped)).toBe(`${__BUILDER_HASH__}:${bodyKey(quadruped)}`);
    expect(bodyCacheKey(biped)).not.toBe(bodyCacheKey(quadruped));
  });

  it('misses when nothing is saved', async () => {
    expect(await loadBody(key('nope'))).toBeNull();
  });

  it('round-trips a body, typed arrays included', async () => {
    const b = body(3);
    await saveBody(key('one'), b);
    const back = await loadBody(key('one'));
    expect(back).toEqual(b);
    expect(back!.lods[0].positions).toBeInstanceOf(Float32Array);
    expect(back!.lods[0].boneOf).toBeInstanceOf(Uint16Array);
    expect(back!.lods[0].indices).toBeInstanceOf(Uint32Array);
    expect(back!.lods[0].positions.buffer).not.toBe(b.lods[0].positions.buffer);
  });

  it('treats a saved body whose levels of detail lack a groom as a miss', async () => {
    const old = body(5);
    delete (old.lods[1] as Partial<LodMesh>).groom;
    await saveBody(key('old'), old);
    expect(await loadBody(key('old'))).toBeNull();
  });

  it('drops entries saved under another builder hash when it saves', async () => {
    await saveBody(key('first'), body(0)); // makes the database
    await putRaw({ key: 'deadbeef0000:old', body: body(1), savedAt: 1 }); // what an earlier build of the code would have left
    expect(await loadBody('deadbeef0000:old')).not.toBeNull();
    await saveBody(key('fresh'), body(2));
    expect(await loadBody('deadbeef0000:old')).toBeNull();
    expect(await loadBody(key('fresh'))).not.toBeNull();
  });

  it('keeps the newest MAX_BODIES and drops the oldest', async () => {
    const total = MAX_BODIES + 6;
    for (let i = 0; i < total; i++) await saveBody(key(`n${i}`), body(i));
    expect((await count()).length).toBe(MAX_BODIES);
    expect(await loadBody(key('n0'))).toBeNull();
    expect(await loadBody(key(`n${total - MAX_BODIES - 1}`))).toBeNull();
    expect(await loadBody(key(`n${total - MAX_BODIES}`))).not.toBeNull();
    expect(await loadBody(key(`n${total - 1}`))).not.toBeNull();
  });

  it('evicts by last use: a body read again survives', async () => {
    await saveBody(key('keep'), body(0));
    for (let i = 0; i < MAX_BODIES + 5; i++) {
      await saveBody(key(`u${i}`), body(i));
      if (i % 4 === 0) expect(await loadBody(key('keep'))).not.toBeNull(); // used now and then
    }
    expect(await loadBody(key('keep'))).not.toBeNull();
    expect(await loadBody(key('u0'))).toBeNull();
    expect((await count()).length).toBe(MAX_BODIES);
  });

  it('a hit whose use cannot be noted (the used store refuses the write) still returns the body', async () => {
    const b = body(4);
    await saveBody(key('noted'), b);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'used') throw new DOMException('full', 'QuotaExceededError');
      return put.apply(this, args);
    });
    try {
      expect(await loadBody(key('noted'))).toEqual(b);
      expect(warn).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });

  it('never throws when IndexedDB is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('indexedDB', { open() { throw new Error('no storage'); } });
    expect(await loadBody(key('x'))).toBeNull();
    await expect(saveBody(key('x'), body())).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
