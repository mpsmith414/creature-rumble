import { describe, expect, it } from 'vitest';
import { CRAYONS, exportPad, PadModel, SIZES } from '../../src/phone/pad';

/** A canvas that records what is drawn on it (node has no canvas). */
function fakeCanvas() {
  const log: string[] = [];
  let made: { w: number; h: number } | null = null;
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (t, k: string) => t[k] ?? ((...a: unknown[]) => log.push(`${k}(${a.map((x) => (typeof x === 'number' ? Math.round(x) : x)).join(',')})`)),
    set: (t, k: string, v) => { t[k] = v; log.push(`${k}=${v}`); return true; },
  });
  const canvas = (w: number, h: number) => {
    made = { w, h };
    return { width: w, height: h, getContext: () => ctx, convertToBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) } as unknown as OffscreenCanvas;
  };
  return { canvas, log, size: () => made };
}

function twoStrokes() {
  const m = new PadModel();
  m.begin(CRAYONS[1], SIZES[1], [0.1, 0.1]);
  m.add([0.5, 0.5]);
  m.end();
  m.begin('erase', SIZES[2], [0.25, 0.75]);
  m.add([0.5, 1]);
  m.end();
  return m;
}

describe('PadModel', () => {
  it('starts empty; a stroke makes it not empty', () => {
    const m = new PadModel();
    expect(m.empty).toBe(true);
    m.begin(CRAYONS[0], SIZES[0], [0, 0]);
    m.end();
    expect(m.empty).toBe(false);
    expect(m.strokes).toEqual([{ color: CRAYONS[0], size: SIZES[0], points: [[0, 0]] }]);
  });
  it('undo removes the last stroke', () => {
    const m = twoStrokes();
    m.undo();
    expect(m.strokes).toHaveLength(1);
    expect(m.strokes[0].color).toBe(CRAYONS[1]);
    m.undo();
    m.undo(); // nothing left: no harm
    expect(m.empty).toBe(true);
  });
  it('clear empties', () => {
    const m = twoStrokes();
    m.clear();
    expect(m.strokes).toEqual([]);
    expect(m.empty).toBe(true);
  });
  it('add after end does nothing (a stray move after lifting the finger)', () => {
    const m = twoStrokes();
    m.add([0.9, 0.9]);
    expect(m.strokes[1].points).toHaveLength(2);
  });
  it('has 8 crayons and 3 sizes', () => {
    expect(CRAYONS).toEqual(['#222', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#6d4c41']);
    expect(SIZES).toEqual([6, 14, 28]);
  });
});

describe('exportPad', () => {
  it('draws a white page, then one path per stroke in order (the eraser in white), at 768 × 1024 for 3:4', async () => {
    const f = fakeCanvas();
    const img = await exportPad(twoStrokes(), 3 / 4, f.canvas);
    expect(f.size()).toEqual({ w: 768, h: 1024 });
    expect(img.mediaType).toBe('image/png');
    expect(img.base64).toBe('AQID');
    const fill = f.log.indexOf('fillRect(0,0,768,1024)');
    expect(fill).toBeGreaterThan(-1);
    expect(f.log.slice(0, fill)).toContain('fillStyle=#fff');
    const strokes = f.log.flatMap((l, i) => (l === 'stroke()' ? [i] : []));
    expect(strokes).toHaveLength(2);
    expect(strokes[0]).toBeGreaterThan(fill);
    const first = f.log.slice(fill, strokes[0]);
    expect(first).toContain(`strokeStyle=${CRAYONS[1]}`);
    expect(first).toContain('moveTo(77,102)');
    expect(first).toContain('lineTo(384,512)');
    expect(first).toContain(`lineWidth=${(SIZES[1] * 768) / 1024}`);
    const second = f.log.slice(strokes[0], strokes[1]);
    expect(second).toContain('strokeStyle=#fff');
    expect(second).toContain('moveTo(192,768)');
    expect(second).toContain('lineTo(384,1024)');
  });
  it('a wide page is 1024 on its long side too', async () => {
    const f = fakeCanvas();
    await exportPad(new PadModel(), 4 / 3, f.canvas);
    expect(f.size()).toEqual({ w: 1024, h: 768 });
  });
});
