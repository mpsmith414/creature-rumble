import type { RingPhase } from '../bring/protocol';
import { h } from '../shared/dom';
import { FocusRing } from '../shared/focus';
import type { Button } from '../shared/input';
import type { Menu } from './menu-control';

/**
 * The TV menu (spec §2.8–2.11): big buttons for the sofa, a focus ring the remote's arrows move, Enter presses, Back
 * goes back. Crown and Again! show only when they can happen. Fighters lists the roster to send back in; Clear the
 * ring asks first.
 */

export type MenuState = { phase: RingPhase; fighting: number; joinShown: boolean; volume: number; muted: boolean };
export type MenuItem = { id: string; label: string; selected?: boolean; disabled?: boolean; aria?: string };
export type MenuRow = { id: 'ring' | 'fighters' | 'join' | 'volume' | 'clear' | 'resume'; title?: string; items: MenuItem[]; level?: number; off?: boolean };

export const CROWN_LABEL = '👑 Crown the champion!';
export const CLEAR_ASK = 'Clear the ring? Everyone goes back to the Fighters.';
export const NO_FIGHTERS = 'No fighters yet. Make one on a phone!';

/** The menu's rows for a state (pure: the page is drawn from it). */
export function menuModel(s: MenuState): MenuRow[] {
  const level = Math.round(s.volume * 10);
  const ring: MenuItem[] = [];
  if (s.phase === 'open' && s.fighting > 0) ring.push({ id: 'crown', label: CROWN_LABEL });
  if (s.phase === 'crowned') ring.push({ id: 'again', label: 'Again!' });
  return [
    ...(ring.length ? [{ id: 'ring' as const, items: ring }] : []),
    { id: 'fighters', items: [{ id: 'fighters', label: 'Fighters' }] },
    { id: 'join', items: [{ id: 'join', label: 'Show join code', selected: s.joinShown }] },
    { id: 'volume', title: 'Sound', level, off: s.muted, items: [
      { id: 'down', label: '−', aria: 'Quieter', disabled: level <= 0 },
      { id: 'up', label: '+', aria: 'Louder', disabled: level >= 10 },
      { id: 'mute', label: s.muted ? 'Sound on' : 'Sound off', selected: s.muted },
    ] },
    { id: 'clear', items: [{ id: 'clear', label: 'Clear the ring' }] },
    { id: 'resume', items: [{ id: 'resume', label: 'Back to the fight' }] },
  ];
}

/** One roster creature on the Fighters page. */
export type FighterRow = { id: string; name: string; maker: string; crowns: number; thumb: string | null; inRing: boolean };

export type MenuHandlers = {
  crown(): void;
  again(): void;
  fighters(): Promise<FighterRow[]>;
  sendBack(id: string): void;
  /** Show or hide the join card. */
  join(): void;
  volume(delta: number): void;
  mute(): void;
  clear(): void;
};

export type RumbleMenu = Menu & { el: HTMLElement; update(s: MenuState): void };

/** Opens the menu in `root`. `close` shuts it (the buttons that act on the ring close it, so the TV shows what they did). */
export function openMenu(root: HTMLElement, state: MenuState, on: MenuHandlers, close: () => void): RumbleMenu {
  const main = h('section', { class: 'rm-panel', role: 'dialog', 'aria-label': 'Rumble menu' });
  const fighters = h('section', { class: 'rm-panel rm-fighters', role: 'dialog', 'aria-label': 'Fighters', hidden: true });
  const ask = h('section', { class: 'rm-panel rm-ask', role: 'dialog', 'aria-label': 'Clear the ring', hidden: true },
    h('p', { class: 'rm-empty' }, CLEAR_ASK),
    h('div', { class: 'rm-items' },
      h('button', { class: 'rm-btn', type: 'button', 'data-focus': true, 'data-key': 'clear:yes', onclick: () => { on.clear(); close(); } }, 'Yes, clear it'),
      h('button', { class: 'rm-btn', type: 'button', 'data-focus': true, 'data-key': 'clear:no', onclick: () => showPage(null) }, 'No')));
  const pages = { fighters, ask };
  let page: keyof typeof pages | null = null;
  const screen = h('div', { class: 'rm-menu' }, main, fighters, ask);
  root.append(screen);
  const ring = new FocusRing(() => (page ? pages[page] : main));
  screen.addEventListener('focusin', (e) => e.target instanceof HTMLElement && e.target.dataset.focus !== undefined && ring.focus(e.target));

  let current: MenuRow[] = [];
  const act = (row: MenuRow['id'], id: string) => {
    if (id === 'crown') { on.crown(); close(); }
    else if (id === 'again') { on.again(); close(); }
    else if (id === 'fighters') showPage('fighters');
    else if (id === 'join') on.join();
    else if (row === 'volume') {
      if (id === 'mute') on.mute();
      else if (!current.find((r) => r.id === 'volume')?.items.find((i) => i.id === id)?.disabled) on.volume(id === 'up' ? 0.1 : -0.1);
    } else if (id === 'clear') showPage('ask');
    else if (id === 'resume') close();
  };

  const rowEl = (row: MenuRow) => {
    const buttons: HTMLElement[] = row.items.map((it) => h('button', {
      class: `rm-btn${it.selected ? ' on' : ''}${it.disabled ? ' dim' : ''}${row.id === 'ring' ? ' rm-big' : ''}`, type: 'button',
      'data-focus': true, 'data-key': `${row.id}:${it.id}`, 'aria-label': it.aria, 'aria-disabled': it.disabled ? 'true' : undefined,
      'aria-pressed': it.id === 'join' || it.id === 'mute' ? String(!!it.selected) : undefined,
      onclick: () => act(row.id, it.id),
    }, it.label));
    if (row.level !== undefined) {
      const pips = h('span', { class: `rm-level${row.off ? ' off' : ''}`, role: 'img', 'aria-label': row.off ? 'Sound off' : `Volume ${row.level} of 10` },
        ...Array.from({ length: 10 }, (_, i) => h('i', { class: i < row.level! ? 'lit' : '', style: `height: ${1 + i * 0.22}em` })));
      buttons.splice(1, 0, pips);
    }
    return h('div', { class: `rm-row rm-row-${row.id}` }, row.title ? h('div', { class: 'rm-title' }, row.title) : null, h('div', { class: 'rm-items' }, ...buttons));
  };

  const draw = (s: MenuState) => {
    const was = main.querySelector<HTMLElement>('.focused')?.dataset.key;
    current = menuModel(s);
    main.replaceChildren(h('h2', { class: 'rm-heading' }, 'The Rumble'), ...current.map(rowEl));
    if (page) return;
    const keep = was && main.querySelector<HTMLElement>(`[data-key="${was}"]`);
    if (keep) ring.focus(keep);
    else if (was || !main.querySelector('.focused')) ring.reset();
  };

  /** The Fighters page: every roster creature with Send back in! (those already in the ring say so). */
  let drawn = 0;
  const drawFighters = async () => {
    const mine = ++drawn;
    const back = h('button', { class: 'rm-btn rm-back', type: 'button', 'data-focus': true, 'data-key': 'back', onclick: () => showPage(null) }, 'Back');
    fighters.replaceChildren(h('h2', { class: 'rm-heading' }, 'Fighters'), h('p', { class: 'rm-empty' }, 'Loading…'), back);
    ring.focus(back);
    let rows: FighterRow[] = [];
    try {
      rows = await on.fighters();
    } catch (e) {
      console.warn('could not read the roster', e);
    }
    if (mine !== drawn || page !== 'fighters') return;
    const grid = h('ul', { class: 'rm-grid' }, ...rows.map((r) => h('li', { class: 'rm-fighter' },
      r.thumb ? h('img', { class: 'rm-thumb', src: r.thumb, alt: '' }) : h('span', { class: 'rm-thumb rm-nothumb', 'aria-hidden': 'true' }, '🥊'),
      h('b', { class: 'rm-name' }, r.name),
      h('small', { class: 'rm-maker' }, `by ${r.maker || 'a mystery maker'}${r.crowns ? `  👑×${r.crowns}` : ''}`),
      h('button', {
        class: `rm-btn${r.inRing ? ' dim' : ''}`, type: 'button', 'data-focus': true, 'data-key': `send:${r.id}`, 'aria-disabled': r.inRing ? 'true' : undefined,
        onclick: () => { if (!r.inRing) { on.sendBack(r.id); close(); } },
      }, r.inRing ? 'In the ring' : 'Send back in!'))));
    fighters.replaceChildren(h('h2', { class: 'rm-heading' }, 'Fighters'), rows.length ? grid : h('p', { class: 'rm-empty' }, NO_FIGHTERS), back);
    ring.focus(fighters.querySelector<HTMLElement>('.rm-fighter [data-focus]:not(.dim)') ?? back);
  };

  const showPage = (next: keyof typeof pages | null) => {
    const was = page;
    page = next;
    fighters.hidden = next !== 'fighters';
    ask.hidden = next !== 'ask';
    main.hidden = next !== null;
    if (next === 'fighters') void drawFighters();
    else if (next === 'ask') ring.focus(ask.querySelector<HTMLElement>('[data-key="clear:no"]'));
    else ring.focus(main.querySelector<HTMLElement>(`[data-key="${was === 'fighters' ? 'fighters:fighters' : 'clear:clear'}"]`));
  };

  draw(state);
  ring.reset();
  return {
    el: screen,
    update: draw,
    press(b: Button, repeat = false) {
      if (b === 'up' || b === 'down' || b === 'left' || b === 'right') return ring.move(b);
      if (repeat) return;
      if (b === 'a') return ring.activate();
      if (b === 'b') return page ? showPage(null) : close();
    },
    close() {
      screen.classList.add('closing');
      setTimeout(() => screen.remove(), 250);
    },
  };
}
