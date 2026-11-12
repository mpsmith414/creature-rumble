/** Spatial focus for controllers: the d-pad moves between buttons the way your eye expects. */

export type Rect = { id: string; x: number; y: number; w: number; h: number };
export type Dir = 'up' | 'down' | 'left' | 'right';

/** The nearest element in a direction (distance, with sideways drift costing extra); none keeps the current one. */
export function nextFocus(rects: Rect[], current: string, dir: Dir): string {
  const cur = rects.find((r) => r.id === current);
  if (!cur) return rects[0]?.id ?? current;
  const cx = cur.x + cur.w / 2, cy = cur.y + cur.h / 2;
  let best = current, bestScore = Infinity;
  for (const r of rects) {
    if (r.id === current) continue;
    const dx = r.x + r.w / 2 - cx, dy = r.y + r.h / 2 - cy;
    const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 1) continue;
    const score = along + across * 2;
    if (score < bestScore) (bestScore = score), (best = r.id);
  }
  return best;
}

/** Moves a visible focus ring between the [data-focus] elements inside the topmost open layer. */
export class FocusRing {
  private current: HTMLElement | null = null;

  constructor(private layer: () => HTMLElement) {}

  private candidates(): HTMLElement[] {
    return [...this.layer().querySelectorAll<HTMLElement>('[data-focus]')].filter((el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled);
  }

  focus(el: HTMLElement | null) {
    this.current?.classList.remove('focused');
    this.current = el;
    if (el) {
      el.classList.add('focused');
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.focus();
    }
  }

  move(dir: Dir) {
    const els = this.candidates();
    if (!els.length) return;
    if (!this.current || !els.includes(this.current)) return this.focus(els[0]);
    els.forEach((el, i) => (el.dataset.fid ??= String(i)));
    const rects = els.map((el) => {
      const b = el.getBoundingClientRect();
      return { id: el.dataset.fid!, x: b.x, y: b.y, w: b.width, h: b.height };
    });
    const id = nextFocus(rects, this.current.dataset.fid!, dir);
    this.focus(els.find((el) => el.dataset.fid === id) ?? this.current);
  }

  activate() {
    if (!this.current || !this.candidates().includes(this.current)) return this.move('down');
    this.current.click();
  }

  /** Focus the first thing worth pressing (not a panel's close button). */
  reset() {
    const els = this.candidates();
    this.focus(els.find((el) => !el.classList.contains('close')) ?? els[0] ?? null);
  }
}
