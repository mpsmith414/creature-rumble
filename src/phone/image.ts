import type { ImageIn } from '../designer/types';

/** The phone scales a picked photo or drawing before sending it (the server body limit is 12 MB; a 48 MP photo is far over). */

/** Longest side sent to the server, in px. */
export const MAX_SIDE = 1568;

/** The size that fits `max` on its longest side, keeping the shape; a picture already small enough is unchanged. */
export function fitSize(w: number, h: number, max = MAX_SIDE): { w: number; h: number } {
  const k = max / Math.max(w, h);
  if (k >= 1) return { w, h };
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

type Deps = {
  decode(b: Blob): Promise<ImageBitmap | null>;
  canvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement;
};

/** Decode with the photo's EXIF rotation applied (asked for explicitly, not left to the browser default), so a portrait
 * photo is upright and `width`/`height` are the upright size. `make` is injectable for tests. */
export function decodeUpright(b: Blob, make: (b: Blob, o: ImageBitmapOptions) => Promise<ImageBitmap> = (x, o) => createImageBitmap(x, o)): Promise<ImageBitmap | null> {
  return make(b, { imageOrientation: 'from-image' }).catch(() => null);
}

const defaults: Deps = {
  decode: (b) => decodeUpright(b),
  canvas: (w, h) => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  },
};

/** A canvas's picture as a blob (OffscreenCanvas or DOM canvas). */
export function toBlob(c: OffscreenCanvas | HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality });
  return new Promise((resolve) => c.toBlob(resolve, type, quality));
}

/** base64 of a blob, in slices (one `fromCharCode(...bytes)` of a big picture overflows the call stack). */
export async function base64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Decode, scale and encode a picked photo (JPEG 0.85) or a drawing (PNG); null when the browser cannot decode it. */
export async function encodeImage(file: Blob, kind: 'photo' | 'drawing', deps: Deps = defaults): Promise<ImageIn | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await deps.decode(file);
    if (!bitmap) return null;
    const { w, h } = fitSize(bitmap.width, bitmap.height);
    const canvas = deps.canvas(w, h);
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const mediaType = kind === 'photo' ? 'image/jpeg' : 'image/png';
    const blob = await toBlob(canvas, mediaType, kind === 'photo' ? 0.85 : undefined);
    return blob ? { base64: await base64(blob), mediaType } : null;
  } catch {
    return null; // the screen says "Hmm, I can't open that picture. Try another!"
  } finally {
    bitmap?.close();
  }
}
