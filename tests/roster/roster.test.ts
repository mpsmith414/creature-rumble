import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Made } from '../../src/bring/workshop';
import { bodyCacheKey, saveBody } from '../../src/builder/cache';
import { Roster } from '../../src/roster/roster';
import { CAST } from '../fixtures/cast';
import { quadruped } from '../fixtures/recipes';

vi.mock('../../src/builder/cache', async (orig) => {
  const actual = await orig<typeof import('../../src/builder/cache')>();
  return { ...actual, saveBody: vi.fn(actual.saveBody) };
});

const dbName = () => `test-${Math.random()}`;
const jpeg = { base64: 'eA==', mediaType: 'image/jpeg' as const };
const made = (token: string, name = token): Made =>
  ({
    token, maker: { name: 'Sam', badge: '🦊' }, input: { image: null, words: '' }, recipe: quadruped,
    body: { key: `k-${token}`, lods: [] } as unknown as Made['body'], cards: { ...CAST[0].cards, name }, history: [], thumb: jpeg,
  }) as Made;
/** A fake thumbnailer: no canvas needed. */
const fake = async () => 'data:image/jpeg;base64,/9j/4AAQ';
const open = (name = dbName()) => Roster.open(name, { thumbnail: fake });

/** Overwrite a stored item's recipe behind the roster's back (an old schema). */
const rewrite = (name: string, id: string, recipe: unknown) =>
  new Promise<void>((res, rej) => {
    const o = indexedDB.open(name);
    o.onerror = () => rej(o.error);
    o.onsuccess = () => {
      const db = o.result, store = db.transaction('roster', 'readwrite').objectStore('roster');
      const g = store.get(id);
      g.onsuccess = () => {
        const put = store.put({ ...g.result, recipe });
        put.onsuccess = () => (db.close(), res());
      };
    };
  });

afterEach(() => vi.restoreAllMocks());

describe('Roster', () => {
  it('starts empty', async () => {
    expect(await (await open()).list()).toEqual([]);
  });

  it('a made creature is kept and listed newest first', async () => {
    const r = await open();
    const a = await r.add(made('a', 'Ann'), 10);
    const b = await r.add(made('b', 'Bo'), 20);
    expect(a).toMatchObject({ crowns: 0, bouts: 0, createdAt: 10, maker: { name: 'Sam', badge: '🦊' } });
    expect((await r.list()).map((i) => i.id)).toEqual([b.id, a.id]);
    expect((await r.get(a.id))?.cards.name).toBe('Ann');
    expect(await r.get('nope')).toBeUndefined();
  });

  it('crowning counts up', async () => {
    const r = await open();
    const a = await r.add(made('a'), 1);
    await r.crowned(a.id);
    await r.crowned(a.id);
    expect((await r.get(a.id))?.crowns).toBe(2);
  });

  it('fought adds a bout for each id', async () => {
    const r = await open();
    const a = await r.add(made('a'), 1), b = await r.add(made('b'), 2), c = await r.add(made('c'), 3);
    await r.fought([a.id, b.id]);
    await r.fought([a.id]);
    expect((await r.get(a.id))?.bouts).toBe(2);
    expect((await r.get(b.id))?.bouts).toBe(1);
    expect((await r.get(c.id))?.bouts).toBe(0);
  });

  it('an unknown id is a no-op, not a throw', async () => {
    const r = await open();
    const a = await r.add(made('a'), 1);
    await expect(r.crowned('ghost')).resolves.toBeUndefined();
    await expect(r.fought(['ghost', a.id])).resolves.toBeUndefined();
    expect((await r.list()).length).toBe(1);
    expect((await r.get(a.id))?.bouts).toBe(1);
  });

  it('summaries are small', async () => {
    const r = await open();
    const a = await r.add(made('a', 'Ann'), 1);
    await r.crowned(a.id);
    const [s] = await r.summaries();
    expect(s).toMatchObject({ id: a.id, name: 'Ann', maker: 'Sam', crowns: 1 });
    expect(s.thumb).toMatch(/^data:image\/jpeg;base64,/);
    expect(s.thumb!.length).toBeLessThan(20_000);
  });

  it('thumbs are made once, when added, and a failed one is null', async () => {
    const thumbnail = vi.fn(fake);
    const r = await Roster.open(dbName(), { thumbnail });
    await r.add(made('a'), 1);
    await r.summaries(); await r.summaries();
    expect(thumbnail).toHaveBeenCalledTimes(1);
    const none = await Roster.open(dbName(), { thumbnail: async () => null });
    await none.add(made('b'), 1);
    expect((await none.summaries())[0].thumb).toBeNull();
  });

  it('a thumbnail over the size limit is dropped', async () => {
    const r = await Roster.open(dbName(), { thumbnail: async () => `data:image/jpeg;base64,${'A'.repeat(20_000)}` });
    await r.add(made('a'), 1);
    expect((await r.summaries())[0].thumb).toBeNull();
  });

  it('keeps everything across a re-open', async () => {
    const name = dbName();
    const r = await open(name);
    const a = await r.add(made('a'), 1);
    await r.crowned(a.id);
    r.close();
    const again = await open(name);
    expect((await again.list()).map((i) => [i.id, i.crowns])).toEqual([[a.id, 1]]);
  });

  it('skips an item whose recipe no longer parses, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const name = dbName();
    const r = await open(name);
    const good = await r.add(made('good'), 1);
    const bad = await r.add(made('bad'), 2);
    await rewrite(name, bad.id, { not: 'a recipe' });
    expect((await r.list()).map((i) => i.id)).toEqual([good.id]);
    expect(await r.get(bad.id)).toBeUndefined();
    expect((await r.summaries()).map((s) => s.id)).toEqual([good.id]);
    expect(warn).toHaveBeenCalled();
  });

  it('items made at the same moment keep a stable order', async () => {
    const r = await open();
    const a = await r.add(made('a'), 5), b = await r.add(made('b'), 5);
    const want = [a.id, b.id].sort().reverse();
    expect((await r.list()).map((i) => i.id)).toEqual(want);
    expect((await r.list()).map((i) => i.id)).toEqual(want);
  });

  it('crowns counted at the same time are all kept', async () => {
    const r = await open();
    const a = await r.add(made('a'), 1);
    await Promise.all([r.crowned(a.id), r.crowned(a.id)]);
    expect((await r.get(a.id))?.crowns).toBe(2);
  });

  it('add saves the body under its cache key', async () => {
    const r = await open();
    const m = made('a');
    await r.add(m, 1);
    expect(saveBody).toHaveBeenLastCalledWith(bodyCacheKey(quadruped), m.body);
  });

  it('add still resolves when the body cache rejects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(saveBody).mockRejectedValueOnce(new Error('full'));
    const r = await open();
    const a = await r.add(made('a'), 1);
    expect((await r.get(a.id))?.id).toBe(a.id);
  });
});
