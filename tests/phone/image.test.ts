import { describe, expect, it } from 'vitest';
import { decodeUpright, encodeImage, fitSize, MAX_SIDE } from '../../src/phone/image';

describe('fitSize', () => {
  it('scales a huge portrait photo to a longest side of 1568', () => {
    expect(MAX_SIDE).toBe(1568);
    expect(fitSize(6000, 8000)).toEqual({ w: 1176, h: 1568 });
  });
  it('scales a huge landscape photo', () => {
    expect(fitSize(8000, 6000)).toEqual({ w: 1568, h: 1176 });
  });
  it('leaves a small picture unchanged', () => {
    expect(fitSize(800, 600)).toEqual({ w: 800, h: 600 });
    expect(fitSize(1568, 1568)).toEqual({ w: 1568, h: 1568 });
  });
  it('honours another max and never goes below 1 px', () => {
    expect(fitSize(1000, 500, 100)).toEqual({ w: 100, h: 50 });
    expect(fitSize(10000, 1, 100)).toEqual({ w: 100, h: 1 });
  });
});

describe('encodeImage', () => {
  const blob = new Blob(['x']);
  let closed = 0;
  const bitmap = (w: number, h: number) => ({ width: w, height: h, close() { closed++; } }) as unknown as ImageBitmap;
  function fakeCanvas() {
    const calls: { drawn?: [number, number]; type?: string; quality?: number; size?: [number, number] } = {};
    const canvas = (w: number, h: number) => {
      calls.size = [w, h];
      return {
        getContext: () => ({ drawImage: (_: unknown, _x: number, _y: number, dw: number, dh: number) => { calls.drawn = [dw, dh]; } }),
        convertToBlob: async (o: { type: string; quality?: number }) => { calls.type = o.type; calls.quality = o.quality; return new Blob([new Uint8Array([1, 2, 3])]); },
      } as unknown as OffscreenCanvas;
    };
    return { calls, canvas };
  }

  it('is null, and never throws, when the browser cannot decode the file', async () => {
    const canvas = () => { throw new Error('should not be asked for a canvas'); };
    expect(await encodeImage(blob, 'photo', { decode: async () => null, canvas })).toBeNull();
    expect(await encodeImage(blob, 'photo', { decode: async () => { throw new Error('boom'); }, canvas })).toBeNull();
  });
  it('scales a photo and encodes it as JPEG 0.85', async () => {
    closed = 0;
    const { calls, canvas } = fakeCanvas();
    const out = await encodeImage(blob, 'photo', { decode: async () => bitmap(6000, 8000), canvas });
    expect(calls.size).toEqual([1176, 1568]);
    expect(calls.drawn).toEqual([1176, 1568]);
    expect(calls.type).toBe('image/jpeg');
    expect(calls.quality).toBe(0.85);
    expect(out).toEqual({ base64: 'AQID', mediaType: 'image/jpeg' });
    expect(closed).toBe(1);
  });
  it('encodes a drawing as PNG', async () => {
    const { calls, canvas } = fakeCanvas();
    const out = await encodeImage(blob, 'drawing', { decode: async () => bitmap(400, 300), canvas });
    expect(calls.size).toEqual([400, 300]);
    expect(calls.type).toBe('image/png');
    expect(out?.mediaType).toBe('image/png');
  });
  it('is null when the canvas cannot be used', async () => {
    const canvas = () => ({ getContext: () => null }) as unknown as OffscreenCanvas;
    expect(await encodeImage(blob, 'photo', { decode: async () => bitmap(10, 10), canvas })).toBeNull();
  });
});

describe('decodeUpright', () => {
  const blob = new Blob(['x']);
  it('asks for the EXIF orientation explicitly', async () => {
    const seen: ImageBitmapOptions[] = [];
    const bmp = { width: 3, height: 4 } as ImageBitmap;
    const out = await decodeUpright(blob, async (_b, o) => { seen.push(o); return bmp; });
    expect(seen).toEqual([{ imageOrientation: 'from-image' }]);
    expect(out).toBe(bmp);
  });
  it('is null when the browser cannot decode the file', async () => {
    expect(await decodeUpright(blob, () => Promise.reject(new Error('HEIC')))).toBeNull();
  });
});
