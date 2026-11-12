import type { ImageIn } from '../designer/types';
import { h } from '../shared/dom';
import { base64, toBlob } from './image';

/** The draw pad: a white page, crayons, an eraser, undo and clear; exported as a PNG on white (spec §2.2). */

/** black, red, orange, yellow, green, blue, purple, brown */
export const CRAYONS: readonly string[] = ['#222', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#6d4c41'];
/** Line widths in px when the page is 1024 px wide (they scale with the page). */
export const SIZES = [6, 14, 28] as const;
/** Page coordinates 0..1 across and down, so the drawing is the same at any screen size. */
export type Stroke = { color: string | 'erase'; size: number; points: [number, number][] };

const PAGE = '#fff';
/** The page is portrait 3:4, like a sheet of paper held up. */
const ASPECT = 3 / 4;

export class PadModel {
  strokes: Stroke[] = [];
  private live: Stroke | null = null;
  begin(c: string | 'erase', size: number, p: [number, number]): void {
    this.live = { color: c, size, points: [p] };
    this.strokes.push(this.live);
  }
  add(p: [number, number]): void { this.live?.points.push(p); }
  end(): void { this.live = null; }
  undo(): void { this.live = null; this.strokes.pop(); }
  clear(): void { this.live = null; this.strokes = []; }
  get empty(): boolean { return this.strokes.length === 0; }
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** One stroke onto a w × h page; with `from`, only its tail from that point on (live drawing). */
function paintStroke(g: Ctx, s: Stroke, w: number, h: number, from = 0): void {
  const pts = s.points;
  const i = Math.max(0, from);
  g.strokeStyle = s.color === 'erase' ? PAGE : s.color;
  g.lineWidth = (s.size * w) / 1024;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(pts[i][0] * w, pts[i][1] * h);
  if (i === pts.length - 1) g.lineTo(pts[i][0] * w, pts[i][1] * h); // a single tap is a dot (round cap)
  for (let k = i + 1; k < pts.length; k++) g.lineTo(pts[k][0] * w, pts[k][1] * h);
  g.stroke();
}

/** The white page and every stroke in order. */
function paint(g: Ctx, strokes: Stroke[], w: number, h: number): void {
  g.fillStyle = PAGE;
  g.fillRect(0, 0, w, h);
  for (const s of strokes) paintStroke(g, s, w, h);
}

/** Draw the strokes on a white page, longest side 1024 (page aspect 3:4 portrait), and return a PNG ImageIn. */
export async function exportPad(m: PadModel, aspect: number, canvas: (w: number, h: number) => HTMLCanvasElement | OffscreenCanvas): Promise<ImageIn> {
  const w = aspect >= 1 ? 1024 : Math.round(1024 * aspect);
  const h = aspect >= 1 ? Math.round(1024 / aspect) : 1024;
  const c = canvas(w, h);
  const g = c.getContext('2d') as Ctx | null;
  if (!g) throw new Error('no 2D canvas');
  paint(g, m.strokes, w, h);
  const blob = await toBlob(c, 'image/png');
  if (!blob) throw new Error('could not encode the drawing');
  return { base64: await base64(blob), mediaType: 'image/png' };
}

const makeCanvas = (w: number, h: number): HTMLCanvasElement | OffscreenCanvas => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return Object.assign(document.createElement('canvas'), { width: w, height: h });
};

/**
 * The full-screen pad over the page. `done` gets the exported drawing, or null when the page is empty (nothing changes).
 * The model lives with the caller, so closing and reopening the pad keeps the drawing.
 */
export function openPad(m: PadModel, done: (img: ImageIn | null) => void): void {
  let color: string = CRAYONS[0];
  let size: number = SIZES[1];
  let erasing = false;
  let pointer: number | null = null;

  const canvas = h('canvas', { class: 'pad-page', 'aria-label': 'Drawing page' });
  const g = canvas.getContext('2d')!;
  const holder = h('div', { class: 'pad-holder' }, canvas);
  let cw = 0, ch = 0; // CSS size of the page

  /** Fit the 3:4 page in the space left between the bars, sharp on high-density screens. */
  function fit() {
    const r = holder.getBoundingClientRect();
    cw = Math.floor(Math.min(r.width, r.height * ASPECT));
    ch = Math.floor(cw / ASPECT);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    paint(g, m.strokes, canvas.width, canvas.height);
  }

  const at = (e: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (pointer !== null) return; // a second finger does not draw
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not a live pointer: draw without capture */ }
    pointer = e.pointerId;
    m.begin(erasing ? 'erase' : color, size, at(e));
    paintStroke(g, m.strokes[m.strokes.length - 1], canvas.width, canvas.height);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointer) return;
    const s = m.strokes[m.strokes.length - 1];
    const from = s.points.length - 1;
    // every point the finger passed since the last frame, not just the last one: smooth curves on fast strokes
    const all = e.getCoalescedEvents?.() ?? [];
    for (const ev of all.length ? all : [e]) m.add(at(ev)); // an empty list on some browsers: the event itself
    paintStroke(g, s, canvas.width, canvas.height, from);
  });
  const lift = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    pointer = null;
    m.end();
  };
  canvas.addEventListener('pointerup', lift);
  canvas.addEventListener('pointercancel', lift);
  canvas.addEventListener('lostpointercapture', lift); // never left waiting on a finger that is gone

  const redraw = () => paint(g, m.strokes, canvas.width, canvas.height);
  const pick = (el: HTMLElement, group: string) => {
    for (const b of overlay.querySelectorAll(`[data-group="${group}"]`)) b.classList.toggle('on', b === el);
  };
  const crayons = CRAYONS.map((c, i) => h('button', {
    class: `crayon${i === 0 ? ' on' : ''}`, 'data-group': 'tool', style: `--c:${c}`, 'aria-label': `Crayon ${i + 1}`,
    onclick: (e) => { color = c; erasing = false; pick(e.currentTarget as HTMLElement, 'tool'); overlay.style.setProperty('--crayon', c); },
  }));
  const eraser = h('button', {
    class: 'crayon eraser', 'data-group': 'tool', 'aria-label': 'Eraser',
    onclick: (e) => { erasing = true; pick(e.currentTarget as HTMLElement, 'tool'); },
  }, '🧽');
  const sizes = SIZES.map((s, i) => h('button', {
    class: `size${s === size ? ' on' : ''}`, 'data-group': 'size', 'aria-label': ['Thin', 'Medium', 'Thick'][i],
    onclick: (e) => { size = s; pick(e.currentTarget as HTMLElement, 'size'); },
  }, h('span', { class: 'dot', style: `--d:${s * 1.2 + 4}px` })));

  // Clear asks twice: a finished drawing is one stray tap away otherwise, and undo cannot bring it back
  let sure: ReturnType<typeof setTimeout> | null = null;
  const clearBtn = h('button', {
    class: 'tool-btn', onclick: () => {
      if (!sure) {
        clearBtn.textContent = 'Sure? 🗑️';
        clearBtn.classList.add('warn');
        sure = setTimeout(() => { sure = null; clearBtn.textContent = '🗑️ Clear'; clearBtn.classList.remove('warn'); }, 3000);
        return;
      }
      clearTimeout(sure);
      sure = null;
      clearBtn.textContent = '🗑️ Clear';
      clearBtn.classList.remove('warn');
      m.clear();
      redraw();
    },
  }, '🗑️ Clear');

  const close = async () => {
    window.removeEventListener('resize', fit);
    if (sure) clearTimeout(sure);
    const img = m.empty ? null : await exportPad(m, ASPECT, makeCanvas).catch(() => null);
    overlay.remove();
    done(img);
  };

  const overlay = h('div', { class: 'pad', style: `--crayon:${color}` },
    h('div', { class: 'pad-bar' },
      h('button', { class: 'tool-btn', onclick: () => { m.undo(); redraw(); } }, '↩️ Undo'),
      clearBtn,
      h('button', { class: 'tool-btn done', onclick: () => void close() }, '✅ Done'),
    ),
    holder,
    h('div', { class: 'pad-tools' }, ...crayons, ...sizes, eraser),
  );
  document.body.append(overlay);
  window.addEventListener('resize', fit);
  fit();
}
