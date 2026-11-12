import type { ImageIn } from './types';

const MAX_SIDE = 1024;

/**
 * Auto-levels: stretch each colour channel so its darkest 1% becomes black and brightest 1% white.
 * A pencil drawing photographed under a lamp comes out crisp. RGBA in, RGBA out.
 */
export function levels(data: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data);
  const pixels = data.length / 4;
  for (let c = 0; c < 3; c++) {
    const hist = new Uint32Array(256);
    for (let i = c; i < data.length; i += 4) hist[data[i]]++;
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255 && (acc += hist[lo]) < pixels * 0.01; lo++);
    acc = 0;
    for (; hi > 0 && (acc += hist[hi]) < pixels * 0.01; hi--);
    if (hi - lo < 10 || (lo <= 6 && hi >= 249)) continue; // flat, or already using the full range
    const scale = 255 / (hi - lo);
    for (let i = c; i < data.length; i += 4) out[i] = (data[i] - lo) * scale;
  }
  return out;
}

const toBase64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Ready a photo or file for the designer: upright (phone rotation), at most 1024 px, auto-levelled JPEG. */
export async function prepareImage(file: Blob): Promise<ImageIn> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; // transparent PNG drawings go on white paper
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  img.data.set(levels(img.data));
  ctx.putImageData(img, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  return { base64: await toBase64(blob), mediaType: 'image/jpeg' };
}

export const imageUrl = (img: ImageIn) => `data:${img.mediaType};base64,${img.base64}`;
