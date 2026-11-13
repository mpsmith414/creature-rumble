// Dev only (`/?dev`, left out of the build): the spike's panel over the real TV. Add a fixture fighter by kind (keys
// 1–7, with its entrance), quick-fill 4 without entrances (F), crown (C), Again! (A), reset (X), fill the next fighter's
// special meter (S), tune sliders bound to TUNE, the freeze toggle; H hides the panel. `&shot=entrance|fight|crown|special`
// plays a short script and saves that moment as .shots/<name>.png (the dev server's /__shot): the solo show-off at the
// top of its jump, a busy fight, the champion, a special's impact.
import type { BodyData } from '../builder/build';
import type { Fighter } from '../fight/fighter';
import { TUNE } from '../fight/tune';
import type { Recipe } from '../recipe/schema';
import { entranceAt } from '../show/timeline';
import { fixtures } from '../dev/pose';
import type { RumbleApi } from './rumble';
import type { Card } from './show';

const KINDS = ['fists', 'legs', 'tiny', 'blob', 'wings', 'tail', 'horns'] as const;
const LABEL: Record<(typeof KINDS)[number], string> = {
  fists: '👊 Big fists', legs: '🦵 Long legs', tiny: '🐭 Tiny', blob: '🫧 Blob', wings: '🪽 Wings', tail: '🌀 Tail', horns: '🦏 Horns',
};
const MAKERS = ['Sam', 'Zig', 'Captain Doodle', null, 'Zag', 'Waffles', 'Pickle'];
type Slider = { key: 'knock' | 'flop' | 'bounce' | 'gravity' | 'build' | 'heal' | 'bumper'; label: string; min: number; max: number; step: number };
const SLIDERS: Slider[] = [
  { key: 'knock', label: 'Knockback', min: 0.1, max: 2, step: 0.05 },
  { key: 'flop', label: 'Flop time', min: 0.2, max: 3, step: 0.05 },
  { key: 'bounce', label: 'Bounciness', min: 0, max: 0.9, step: 0.05 },
  { key: 'gravity', label: 'Gravity', min: 8, max: 30, step: 1 },
  { key: 'build', label: 'Wobble build', min: 0, max: 0.3, step: 0.005 },
  { key: 'heal', label: 'Wobble heal', min: 0, max: 0.5, step: 0.01 },
  { key: 'bumper', label: 'Bumper height', min: 0, max: 1.2, step: 0.05 },
];
/** `&shot=entrance` saves the frame where the show-off jump is this near its top (0 … 1). */
const SHOT_AT = 0.985;
/**
 * `&shot=special` fills a meter again this often (s) until a special lands, gives up after this long (s), and saves the
 * frame this long (ms) after the impact.
 */
const SPECIAL_RETRY_S = 5, SPECIAL_GIVE_UP_S = 40, SPECIAL_SHOT_MS = 150;

/**
 * Dev: the next fighter in the ring (after `last`, round the ring) gets a full special meter, so it unleashes its
 * special as soon as it can (standing, not stunned). The fight reads the meter; this is the only place the dev panel
 * writes it. Returns who, or null when nobody is fighting.
 */
export function fillSpecial(fighters: readonly Fighter[], last: string | null): Fighter | null {
  const ring = fighters.filter((f) => f.state === 'fighting');
  if (!ring.length) return null;
  const i = ring.findIndex((f) => f.id === last);
  const f = ring[(i + 1) % ring.length];
  f.special.meter = 1;
  return f;
}

const CSS = `
.rm-dev { position: fixed; left: 12px; bottom: 12px; width: 310px; z-index: 40; background: #1a1030e6; color: #fff; padding: 12px;
  border-radius: 14px; font: 13px system-ui, sans-serif; }
.rm-dev[hidden] { display: none; }
.rm-dev h3 { margin: 0 0 6px; font: 16px 'Lilita One', system-ui; letter-spacing: 1px; }
.rm-dev button { margin: 2px; padding: 6px 9px; border: 0; border-radius: 8px; background: #ff4f8b; color: #fff; font: 13px system-ui; font-weight: 700; cursor: pointer; }
.rm-dev button.alt { background: #3ec7ff; color: #14304a; } .rm-dev button.gold { background: #ffc933; color: #3a2400; }
.rm-dev label { display: grid; grid-template-columns: 92px 1fr 40px; align-items: center; gap: 6px; margin: 3px 0; }
.rm-dev .row { margin: 6px 0; } .rm-dev .hint { opacity: 0.65; font-size: 11px; margin-top: 6px; }
.rm-dev .hud { font-weight: 700; margin-bottom: 4px; }
`;

export function devPanel(ui: HTMLElement, canvas: HTMLCanvasElement, rumble: RumbleApi, o: { shot: string | null; build(r: Recipe): Promise<BodyData> }): void {
  const recipes = fixtures().slice(0, KINDS.length);
  const bodies = new Map<number, Promise<BodyData>>();
  const body = (i: number) => {
    let b = bodies.get(i);
    if (!b) bodies.set(i, (b = o.build(recipes[i])));
    return b;
  };
  recipes.forEach((_, i) => void body(i).catch(() => bodies.delete(i))); // built ahead, so a key press enters at once
  let n = 0;
  const cardFor = async (i: number): Promise<Card> => ({
    id: `dev-${KINDS[i]}-${++n}`, recipe: structuredClone(recipes[i]), body: await body(i), maker: MAKERS[i], name: recipes[i].name,
  });
  const add = async (i: number) => rumble.enter(await cardFor(i));
  const quickFill = async () => {
    const picks = [...KINDS.keys()].sort(() => Math.random() - 0.5).slice(0, 4);
    rumble.quickFill(await Promise.all(picks.map(cardFor)));
  };
  let charged: string | null = null;
  const special = () => {
    const f = fillSpecial(rumble.loop.all(), charged);
    charged = f?.id ?? null;
    if (f) console.info(`dev: ${rumble.show.card(f.id)?.name ?? f.id} has a full special meter`);
  };
  const fail = (e: unknown) => console.error('dev panel:', e);

  // ---------- the panel ----------
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const panel = document.createElement('div');
  panel.className = 'rm-dev';
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, text = '', cls = ''): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    e.textContent = text;
    if (cls) e.className = cls;
    parent.append(e);
    return e;
  };
  const button = (parent: HTMLElement, text: string, fn: () => unknown, cls = '') => {
    const b = el('button', parent, text, cls);
    b.type = 'button';
    b.tabIndex = -1; // never keeps the focus: Enter is the TV menu's
    b.onclick = () => { b.blur(); void Promise.resolve(fn()).catch(fail); };
  };
  el('h3', panel, 'RUMBLE DEV');
  const hud = el('div', panel, '', 'hud');
  const kinds = el('div', panel, '', 'row');
  KINDS.forEach((k, i) => button(kinds, `${i + 1} ${LABEL[k]}`, () => add(i)));
  const acts = el('div', panel, '', 'row');
  button(acts, 'Quick-fill 4 (F)', quickFill, 'alt');
  button(acts, '👑 Crown (C)', () => rumble.crown(), 'gold');
  button(acts, 'Again! (A)', () => rumble.again(), 'gold');
  button(acts, 'Reset (X)', () => rumble.reset(), 'alt');
  button(acts, '⚡ Special (S)', special, 'gold');
  for (const s of SLIDERS) {
    const row = el('label', panel, s.label);
    const input = el('input', row);
    Object.assign(input, { type: 'range', min: String(s.min), max: String(s.max), step: String(s.step), value: String(TUNE[s.key]) });
    input.tabIndex = -1;
    const out = el('span', row, String(TUNE[s.key]));
    input.oninput = () => {
      TUNE[s.key] = Number(input.value);
      out.textContent = input.value;
      if (s.key === 'bounce') for (const f of rumble.loop.all()) f.ragdoll.setBounce(TUNE.bounce);
      if (s.key === 'gravity') rumble.world.gravity = { x: 0, y: -TUNE.gravity, z: 0 };
    };
  }
  const freezeRow = el('label', panel);
  freezeRow.style.gridTemplateColumns = 'auto 1fr';
  const freeze = el('input', freezeRow);
  freeze.type = 'checkbox';
  freeze.checked = rumble.loop.freeze;
  freeze.tabIndex = -1;
  el('span', freezeRow, 'Freeze the fight during entrances');
  freeze.onchange = () => { rumble.loop.freeze = freeze.checked; };
  el('div', panel, 'Keys 1–7 add a fighter of that kind (with its entrance). S fills the next fighter’s special meter. H hides this panel. Enter opens the TV menu.', 'hint');
  ui.append(panel);

  window.addEventListener('keydown', (e) => {
    if (rumble.menuOpen() || e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase(), num = Number(e.key);
    if (num >= 1 && num <= KINDS.length) void add(num - 1).catch(fail);
    else if (k === 'f') void quickFill().catch(fail);
    else if (k === 'c') rumble.crown();
    else if (k === 'a') rumble.again();
    else if (k === 'x') rumble.reset();
    else if (k === 's') special();
    else if (k === 'h') panel.hidden = !panel.hidden;
  });
  rumble.onFrame(() => {
    const m = rumble.match;
    hud.textContent = `In the ring: ${m.fighting.length} · Entering: ${m.entering.length} · On deck: ${m.onDeck.length}` +
      `${m.frozen && rumble.loop.freeze ? ' · FROZEN' : ''}${m.phase === 'crowned' ? ' · CROWNED' : ''} · ragdolls ${rumble.loop.size}`;
  });
  Object.assign(window, { __rumble: rumble });

  if (o.shot) {
    panel.hidden = true;
    void script(o.shot, rumble, ui, canvas, { add, quickFill, special }).catch(fail);
  }
}

/** The shot scripts: set the moment up, then save the frame right after it is drawn. */
async function script(name: string, rumble: RumbleApi, ui: HTMLElement, canvas: HTMLCanvasElement,
  a: { add(i: number): Promise<void>; quickFill(): Promise<void>; special(): void }): Promise<void> {
  const wait = (s: number) => new Promise((go) => setTimeout(go, s * 1000));
  const at = (moment: () => boolean) => new Promise<void>((go) => {
    const stop = rumble.onFrame(() => {
      if (!moment()) return;
      stop();
      void saveShot(name, canvas.toDataURL('image/png'), ui, canvas).finally(go); // read in the same task as the render
    });
  });
  if (name === 'entrance') {
    await a.add(KINDS.indexOf('horns'));
    const e = rumble.entrance;
    return at(() => e.active && !e.group && e.phase === 'showOff' && entranceAt(e.t, false).jump > SHOT_AT);
  }
  if (name === 'fight') {
    await a.quickFill();
    await wait(7);
    return at(() => rumble.match.fighting.length >= 2);
  }
  if (name === 'crown') {
    await a.quickFill();
    await wait(6);
    rumble.crown();
    await wait(2.5);
    return at(() => true);
  }
  if (name === 'special') {
    // saved a moment after a special's impact: its shockwave out on the floor and its big word up
    let landedAt = -1;
    const prev = rumble.show.onCue;
    rumble.show.onCue = (c) => {
      prev(c);
      if (c.phase === 'impact' && landedAt < 0) landedAt = performance.now();
    };
    const shot = at(() => landedAt >= 0 && performance.now() - landedAt >= SPECIAL_SHOT_MS);
    await a.quickFill();
    await wait(3);
    for (let t = 0; landedAt < 0; t += SPECIAL_RETRY_S) {
      if (t >= SPECIAL_GIVE_UP_S) {
        console.warn('shot "special": no special landed');
        return;
      }
      a.special();
      await wait(SPECIAL_RETRY_S);
    }
    return shot;
  }
  console.warn(`unknown shot "${name}" (entrance, fight, crown or special)`);
}

/** The frame with the page's words over it (banners, pops), posted to the dev server's /__shot. */
async function saveShot(name: string, frame: string, ui: HTMLElement, canvas: HTMLCanvasElement): Promise<void> {
  const { toCanvas } = await import('html-to-image');
  // the library waits on frames, which stall while the pane is hidden: stand in for them
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 0);
  let over: HTMLCanvasElement;
  try {
    over = await toCanvas(ui, { width: innerWidth, height: innerHeight, pixelRatio: canvas.width / Math.max(1, innerWidth), skipFonts: true });
  } finally { window.requestAnimationFrame = raf; }
  const img = new Image();
  await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = fail; img.src = frame; });
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const g = out.getContext('2d')!;
  g.drawImage(img, 0, 0);
  g.drawImage(over, 0, 0, out.width, out.height);
  await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: out.toDataURL('image/png') });
  console.info(`saved .shots/${name}.png`);
}
