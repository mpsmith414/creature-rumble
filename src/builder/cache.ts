import { openDB } from 'idb';
import type { Recipe } from '../recipe/schema';
import { bodyKey, type BodyData } from './build';

const DB = 'creature-bodies', BODIES = 'bodies', USED = 'used', BY_USE = 'usedAt';
/** The most bodies kept; the least recently used go first. */
export const MAX_BODIES = 32;
/** Bodies are big, so when one is used only its small `used` record is rewritten; eviction reads those. */
const open = () =>
  openDB(DB, 2, {
    upgrade(d) {
      for (const name of [...d.objectStoreNames]) d.deleteObjectStore(name);
      d.createObjectStore(BODIES, { keyPath: 'key' });
      d.createObjectStore(USED, { keyPath: 'key' }).createIndex(BY_USE, 'usedAt');
    },
  });

/** The key a built body is stored under: the recipe's body key plus the builder's source hash (new builder code, new keys). */
export const bodyCacheKey = (recipe: Recipe) => `${__BUILDER_HASH__}:${bodyKey(recipe)}`;

let lastUsed = 0; // strictly increasing, so uses in the same millisecond keep their order
const stamp = () => (lastUsed = Math.max(Date.now(), lastUsed + 1));

/** A saved body, or null (also null when IndexedDB is unavailable, e.g. private mode). A hit counts as a use. Never throws. */
export async function loadBody(key: string): Promise<BodyData | null> {
  try {
    const db = await open();
    try {
      const tx = db.transaction([BODIES, USED], 'readwrite');
      tx.done.catch(() => {});
      const hit = (await tx.objectStore(BODIES).get(key)) as { body: BodyData } | undefined;
      // noting the use can fail (quota, a closing database) after the body was read: the body is still good
      if (hit) {
        try {
          await Promise.all([tx.objectStore(USED).put({ key, usedAt: stamp() }), tx.done]);
        } catch (e) {
          console.warn('could not note a body cache use', e);
        }
      }
      // a body saved before the groom existed is stale whatever its key says
      return hit && hit.body.lods.every((l) => l.groom) ? hit.body : null;
    } finally { db.close(); }
  } catch (e) {
    console.warn('body cache unavailable; building instead', e);
    return null;
  }
}

/**
 * Save a body (a cache, not storage: failures are swallowed). Entries from another builder hash are dropped, then
 * all but the MAX_BODIES most recently used.
 */
export async function saveBody(key: string, body: BodyData): Promise<void> {
  try {
    const db = await open();
    try {
      const tx = db.transaction([BODIES, USED], 'readwrite');
      tx.done.catch(() => {}); // a failed request also rejects `done`; the request's own error is the one we report
      const bodies = tx.objectStore(BODIES), used = tx.objectStore(USED);
      await Promise.all([bodies.put({ key, body }), used.put({ key, usedAt: stamp() })]);
      const byUse = (await used.index(BY_USE).getAllKeys()) as unknown as string[]; // primary keys, least recently used first
      const keep = new Set(byUse.filter((k) => k.startsWith(`${__BUILDER_HASH__}:`)).slice(-MAX_BODIES));
      const all = new Set([...byUse, ...((await bodies.getAllKeys()) as string[])]);
      const drop = [...all].filter((k) => !keep.has(k));
      await Promise.all([...drop.flatMap((k) => [bodies.delete(k), used.delete(k)]), tx.done]);
    } finally { db.close(); }
  } catch (e) {
    console.warn('could not save the body cache', e);
  }
}
