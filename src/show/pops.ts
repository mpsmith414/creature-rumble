import { Vector3, type Camera } from 'three/webgpu';
import './show.css';

/** The comic words a landed hit pops (spec §4). */
export const POP_WORDS = ['BONK!', 'POW!', 'BOING!', 'WHAM!', 'SPLAT!', 'BOP!', 'KAPOW!', 'THWACK!'] as const;
/** Popped over a fighter knocked out of the ring, and over a show-off. */
export const BYE_BYE = 'BYE BYE!', TA_DA = 'TA-DA!';
const COLOURS = ['#ffe14d', '#ff5ad1', '#3ec7ff', '#7dff5a', '#ff7a2f'];
/** How many words can be in the air at once (the oldest is reused), and how long one lasts (ms, = the CSS animation). */
const POOL = 16, LIFE_MS = 900;

const _p = new Vector3();

/** A box on the screen, as fractions of its width (left, right) and height (top, bottom; 0 at the top). */
export type Band = { top: number; bottom: number; left: number; right: number };
/**
 * A pop's size on the screen (fractions, at size 1): half its height, half the width of a long word, and how far it
 * floats up as it fades (the CSS animation rises to −140% of its own height from −50%).
 */
const POP_HALF_H = 0.03, POP_HALF_W = 0.09, POP_RISE = 0.05;
/** Space kept between a moved pop and the band. */
const POP_GAP = 0.015;

/**
 * The height (screen fraction, 0 at the top) a pop at (`x`, `y`) of `size` goes to so that, all the way up its float,
 * it never covers `band` (the banner): moved to just below the band, or just above it when below would leave the
 * screen. Left alone when it is clear of the band, or there is none.
 */
export function clearOf(x: number, y: number, band: Band | null, size = 1): number {
  if (!band) return y;
  const hw = POP_HALF_W * size, hh = POP_HALF_H * size, rise = POP_RISE * size;
  if (x + hw < band.left || x - hw > band.right) return y; // beside it
  if (y - hh - rise > band.bottom || y + hh < band.top) return y; // below or above it all the way
  const below = band.bottom + hh + rise + POP_GAP;
  if (below + hh <= 1) return below;
  return Math.max(hh, band.top - hh - POP_GAP);
}

/**
 * Comic text pops (the spike's Fx.pop): a word in a random bright colour, tilted, bursting out of a point in the
 * world and floating up as it fades. A small pool of elements is reused, so a busy fight adds nothing to the page.
 */
export class Pops {
  readonly el: HTMLDivElement;
  private readonly pool: HTMLDivElement[] = [];
  private next = 0;

  /** `avoid`: where the banner is now (or null when it is down), for pops to keep clear of (`clearOf`). */
  constructor(parent: HTMLElement, private readonly rng: () => number = Math.random,
    private readonly avoid: () => Band | null = () => null) {
    this.el = document.createElement('div');
    this.el.className = 'show-pops';
    parent.append(this.el);
    for (let i = 0; i < POOL; i++) {
      const d = document.createElement('div');
      d.className = 'show-pop';
      d.hidden = true;
      d.addEventListener('animationend', () => { d.hidden = true; });
      this.el.append(d);
      this.pool.push(d);
    }
  }

  /** Pops `word` (a random hit word when none) at `at`, `size` × the normal size. Nothing when `at` is behind the camera. */
  pop(at: Vector3, camera: Camera, word?: string, size = 1): void {
    const p = _p.copy(at).project(camera);
    if (p.z > 1 || p.z < -1) return;
    const d = this.pool[this.next];
    this.next = (this.next + 1) % POOL;
    const r = this.rng;
    d.textContent = word ?? POP_WORDS[Math.floor(r() * POP_WORDS.length)];
    const x = (p.x + 1) / 2, y = clearOf(x, (1 - p.y) / 2, this.avoid(), size);
    d.style.left = `${x * 100}%`;
    d.style.top = `${y * 100}%`;
    d.style.color = COLOURS[Math.floor(r() * COLOURS.length)];
    d.style.setProperty('--s', String(size));
    d.style.setProperty('--r', `${(r() - 0.5) * 30}deg`);
    d.hidden = false;
    d.classList.remove('go');
    void d.offsetWidth; // restart the animation on a reused element
    d.classList.add('go');
    d.style.animationDuration = `${LIFE_MS}ms`;
  }

  /** Takes every word off the page. */
  dispose(): void {
    this.el.remove();
    this.pool.length = 0;
  }
}
