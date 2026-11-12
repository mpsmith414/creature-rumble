/** The arrival's welcome title on the TV (arrival v2): the newcomer's name, in the workshop reveal's big type. */
import { h } from '../shared/dom';
import './bring.css';

/** Fade in (0.6 s), hold (3.5 s), fade out (0.6 s): the CSS animation's length, after which the title is removed. */
export const TITLE_MS = 4700;

let shown: HTMLElement | null = null;

/** Show `text` over the ring in the upper third (the join card is hidden while an arrival is on, Ruling R21); one at a time. */
export function showTitle(root: HTMLElement, text: string, ms = TITLE_MS): HTMLElement {
  shown?.remove();
  const el = (shown = h('div', { class: 'arrive-title', role: 'status' }, text));
  root.append(el);
  setTimeout(() => {
    el.remove();
    if (shown === el) shown = null;
  }, ms);
  return el;
}
