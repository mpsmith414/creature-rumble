import { openDB, type IDBPDatabase } from 'idb';
import { bodyCacheKey, saveBody } from '../builder/cache';
import type { Maker } from '../bring/protocol';
import type { Made } from '../bring/workshop';
import type { ImageIn, KidCards } from '../designer/types';
import { normalizeRecipe } from '../recipe/normalize';
import type { Recipe } from '../recipe/schema';

/** The roster: every creature a kid has made, kept in this browser (IndexedDB). Bodies live in the builder cache, not here. */

export type RosterItem = {
  id: string; recipe: Recipe; cards: KidCards; maker: Maker; thumb: ImageIn | null; createdAt: number; crowns: number; bouts: number;
};
export type RosterSummary = { id: string; name: string; maker: string; crowns: number; thumb: string | null };

/** A picture as a small JPEG data URL (or null when it cannot be made). */
export type Thumbnailer = (img: ImageIn) => Promise<string | null>;

const STORE = 'roster';
/** Thumbs are at most this many pixels on a side, and their data URLs under MAX_THUMB_CHARS. */
export const THUMB_PX = 96;
export const MAX_THUMB_CHARS = 20_000;

/** Browser default: scale down with an OffscreenCanvas and encode as JPEG. Null where that is unavailable or fails. */
export const canvasThumbnail: Thumbnailer = async (img) => {
  try {
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;
    const bytes = Uint8Array.from(atob(img.base64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: img.mediaType }));
    try {
      const k = Math.min(1, THUMB_PX / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#fff'; // JPEG has no alpha
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
      const out = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
      return `data:image/jpeg;base64,${btoa(bin)}`;
    } finally {
      bmp.close();
    }
  } catch (e) {
    console.warn('could not make a thumbnail', e);
    return null;
  }
};

const PREFIX = 'data:image/jpeg;base64,';
const toImage = (url: string | null): ImageIn | null =>
  url && url.startsWith(PREFIX) && url.length < MAX_THUMB_CHARS ? { base64: url.slice(PREFIX.length), mediaType: 'image/jpeg' } : null;

const newId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export class Roster {
  private constructor(private db: IDBPDatabase, private thumbnail: Thumbnailer) {}

  /** Open (or create) the roster database. `thumbnail` is injectable so tests need no canvas. */
  static async open(name = 'rumble', opts: { thumbnail?: Thumbnailer; blocked?: () => void } = {}): Promise<Roster> {
    const db: IDBPDatabase = await openDB(name, 1, {
      upgrade(d) {
        d.createObjectStore(STORE, { keyPath: 'id' });
      },
      blocked: () => opts.blocked?.(),
      blocking: () => db.close(),
    });
    return new Roster(db, opts.thumbnail ?? canvasThumbnail);
  }

  /** Keep a made creature (its body goes to the builder cache). The thumb is shrunk once, here. */
  async add(made: Made, now: number): Promise<RosterItem> {
    const item: RosterItem = {
      id: newId(), recipe: made.recipe, cards: made.cards, maker: made.maker,
      thumb: toImage(await this.thumbnail(made.thumb).catch(() => null)), createdAt: now, crowns: 0, bouts: 0,
    };
    await this.db.put(STORE, item);
    try {
      await saveBody(bodyCacheKey(made.recipe), made.body);
    } catch (e) {
      console.warn('could not cache the body', e); // the roster entry is kept either way
    }
    return item;
  }

  /** The item with its recipe upgraded to the current schema, or undefined (with a warning) when it no longer fits. */
  private usable(raw: RosterItem): RosterItem | undefined {
    try {
      return { ...raw, recipe: normalizeRecipe(raw.recipe).recipe };
    } catch (e) {
      console.warn(`skipping roster item ${raw?.id}: its recipe no longer fits`, e);
      return undefined;
    }
  }

  /** Everyone, newest first. Champions are the ones with `crowns > 0`. */
  async list(): Promise<RosterItem[]> {
    const all = (await this.db.getAll(STORE)) as RosterItem[];
    return all.flatMap((i) => this.usable(i) ?? []).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  }

  async get(id: string): Promise<RosterItem | undefined> {
    const raw = (await this.db.get(STORE, id)) as RosterItem | undefined;
    return raw && this.usable(raw);
  }

  /** One more crown. An unknown id does nothing. */
  async crowned(id: string): Promise<void> {
    await this.bump([id], 'crowns');
  }

  /** One more bout for each id (unknown ids are skipped). */
  async fought(ids: string[]): Promise<void> {
    await this.bump(ids, 'bouts');
  }

  private async bump(ids: string[], field: 'crowns' | 'bouts'): Promise<void> {
    const tx = this.db.transaction(STORE, 'readwrite');
    for (const id of new Set(ids)) {
      const item = (await tx.store.get(id)) as RosterItem | undefined;
      if (item) await tx.store.put({ ...item, [field]: (item[field] ?? 0) + 1 });
    }
    await tx.done;
  }

  /** What a menu needs: name, maker, crowns and the small stored thumb. */
  async summaries(): Promise<RosterSummary[]> {
    return (await this.list()).map((i) => ({
      id: i.id, name: i.cards.name, maker: i.maker.name, crowns: i.crowns,
      thumb: i.thumb ? `${PREFIX}${i.thumb.base64}` : null,
    }));
  }

  close() {
    this.db.close();
  }
}
