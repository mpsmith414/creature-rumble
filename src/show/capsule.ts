import { Vector3, type Camera } from 'three/webgpu';
import type { Maker } from '../bring/protocol';
import './show.css';

/** The capsule stays this far inside the screen's edges (fraction of the width / height). */
const EDGE_X = 0.1, EDGE_Y = 0.14;
/** It only moves when its spot moved this far (fraction of the screen): no style writes for a still camera. */
const MOVE = 0.002;

const _p = new Vector3();

/**
 * The "coming soon" capsule (spec §2.12): while a creature is being made the fight stays full-screen and only this
 * small pill by the entrance ramp shows who is making one (their badge and name), with a bouncing silhouette once
 * the shape exists. Text only (never HTML): names come from kids' phones.
 */
export class Capsule {
  readonly el: HTMLDivElement;
  private readonly badge: HTMLSpanElement;
  private readonly who: HTMLSpanElement;
  private readonly shape: HTMLDivElement;
  private x = NaN;
  private y = NaN;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'show-capsule';
    this.el.hidden = true;
    this.shape = document.createElement('div');
    this.shape.className = 'show-capsule-shape';
    this.shape.textContent = '?';
    this.badge = document.createElement('span');
    this.badge.className = 'show-capsule-badge';
    const words = document.createElement('div');
    words.className = 'show-capsule-words';
    const soon = document.createElement('span');
    soon.className = 'show-capsule-soon';
    soon.textContent = 'COMING SOON';
    this.who = document.createElement('span');
    this.who.className = 'show-capsule-who';
    words.append(soon, this.who);
    this.el.append(this.shape, this.badge, words);
    parent.append(this.el);
  }

  /** Who is making one (null hides the capsule), and whether its shape exists yet (the bouncing silhouette). */
  set(maker: Maker | null, silhouette: boolean): void {
    this.el.hidden = !maker;
    if (!maker) return;
    this.badge.textContent = maker.badge;
    this.who.textContent = `${maker.name.trim() || 'Somebody'} is making one!`;
    this.shape.hidden = !silhouette;
  }

  /** Once a frame while shown: keeps it beside `at` (a point by the ramp, in the world), on screen. */
  update(camera: Camera, at: Vector3): void {
    if (this.el.hidden) return;
    const p = _p.copy(at).project(camera);
    let x = (p.x + 1) / 2, y = (1 - p.y) / 2;
    if (p.z > 1) { x = 1 - x; y = 1 - EDGE_Y; } // behind the camera: keep it low, on the side the ramp is
    x = Math.min(1 - EDGE_X, Math.max(EDGE_X, x));
    y = Math.min(1 - EDGE_Y, Math.max(EDGE_Y, y));
    if (Math.abs(x - this.x) < MOVE && Math.abs(y - this.y) < MOVE) return;
    this.x = x;
    this.y = y;
    this.el.style.left = `${(x * 100).toFixed(2)}%`;
    this.el.style.top = `${(y * 100).toFixed(2)}%`;
  }

  /** Takes it off the page. */
  dispose(): void {
    this.el.remove();
  }
}
