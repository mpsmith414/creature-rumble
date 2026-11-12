import { h } from '../shared/dom';
import type { HostInfo } from './host';
import type { Maker } from './protocol';
import './bring.css';

/** The card's mode: `auto` (the default) shows it while a phone is connected or a creature is being made, `on` always,
 * `off` never (the menu's "Add a creature" switches it on and off). */
export type CardMode = 'auto' | 'on' | 'off';
/** Should the join card show? */
export const cardWanted = (s: { mode: CardMode; phones: number; making: boolean }) =>
  s.mode === 'on' || (s.mode === 'auto' && (s.phones > 0 || s.making));

/** The address a phone types (the QR code carries the rest): host and port, and the page. */
export function joinAddress(url: string): { host: string; page: string } {
  try {
    const u = new URL(url);
    return { host: u.host, page: u.pathname === '/' ? '' : u.pathname };
  } catch {
    return { host: url, page: '' };
  }
}

/**
 * The corner card (spec §3.1): the QR code, the address in large type, the code, "Scan to add a creature!" and the
 * phones' badges with their names. It is for looking at from the sofa, so it never takes clicks.
 */
export function joinCard(root: HTMLElement) {
  const qr = h('div', { class: 'join-qr', role: 'img', 'aria-label': 'QR code for the phone page' });
  const host = h('div', { class: 'join-host' }), page = h('div', { class: 'join-page' });
  const code = h('div', { class: 'join-code' });
  const people = h('ul', { class: 'join-line', 'aria-label': 'Who is here' });
  const el = h('aside', { class: 'join-card', hidden: true, 'aria-label': 'Add a creature from a phone' },
    qr, h('div', { class: 'join-scan' }, 'Scan to add a creature!'), host, page,
    h('div', { class: 'join-code-row' }, h('span', { class: 'join-code-label' }, 'Code'), code), people);
  root.append(el);
  return {
    show(info: HostInfo) {
      const a = joinAddress(info.url);
      qr.innerHTML = info.qrSvg; // drawn by our own server from the address above
      host.textContent = a.host;
      page.textContent = a.page;
      code.textContent = info.code;
      el.hidden = false;
    },
    /** The badges with names, in the order given. */
    line(l: { token: string; maker: Maker }[]) {
      people.replaceChildren(...l.map((p) => h('li', { class: 'join-person' }, h('span', { class: 'join-badge' }, p.maker.badge), h('span', { class: 'join-name' }, p.maker.name || 'Friend'))));
    },
    hide() {
      el.hidden = true;
    },
    get visible() {
      return !el.hidden;
    },
  };
}
export type JoinCard = ReturnType<typeof joinCard>;
