import { openDB } from 'idb';
import type { Maker, PhoneCommand, PhoneMsg } from '../bring/protocol';
import type { ImageIn } from '../designer/types';
import { clear } from '../shared/dom';
import { connect, storedSession } from './client';
import { encodeImage } from './image';
import { openPad, PadModel } from './pad';
import { screen, type Handlers, type RingUi, type View } from './screens';
import { draftSpent, initial, reduce, ringButtons, type Action, type Finished, type PhoneState } from './state';
import './phone.css';

/** The phone page: the reducer's state on screen, the relay client, the draft kept on the phone (spec §2), and the
 * ring's Fighters tab (crown, again, send back in). Storage keys keep their old `valley-phone` names so nothing is lost. */

const app = document.getElementById('app')!;
const SESSION = 'valley-phone';
/** Name and badge, kept apart from the session: a session dies with the server, the kid's name should not. */
const MAKER = 'valley-phone-maker';
/** The finished outcome the kid acknowledged (ruling R8), so a refresh does not show it again. */
const SEEN = 'valley-phone-seen';
const OFFLINE = "I can't reach the TV. Is this phone on the same Wi-Fi?";

// ---- the draft: words and the picture, kept in IndexedDB so a capped or failed creature can be tried again tomorrow ----
/** `sent`: this draft went to the TV and has not been changed since (so once it is released it is spent). */
type Draft = { words: string; image: ImageIn | null; sent?: boolean };
const db = openDB('valley-phone', 1, { upgrade: (d) => void d.createObjectStore('draft') }).catch(() => null);
const saveDraft = () => void db.then((d) => d?.put('draft', { words: state.draft.words, image, sent } satisfies Draft, 'draft')).catch(() => undefined);
const loadDraft = () => db.then((d) => (d?.get('draft', 'draft') as Promise<Draft | undefined> | undefined)).catch(() => undefined);

// ---- state ----
let urlCode = (new URLSearchParams(location.search).get('c') ?? '').trim().toUpperCase();
let stored = storedSession(localStorage);
/** A new QR (the server restarted, so a new code): join it as the same kid instead of rejoining the old one. If the
 * address is the stale one instead (an old tab), `join` puts the session back and reloads on the code that works. */
const rejoinNew = stored && urlCode && stored.code !== urlCode ? stored : null;
if (rejoinNew) { localStorage.removeItem(SESSION); stored = null; }

const savedMaker = ((): Maker | null => {
  try {
    const m = JSON.parse(localStorage.getItem(MAKER) ?? 'null') as Maker | null;
    return m && typeof m.name === 'string' && typeof m.badge === 'string' ? m : null;
  } catch { return null; }
})();
/** Scanning a QR on a phone that has joined before goes straight in with the same name and badge. */
const autoJoin = rejoinNew?.maker ?? (!stored && urlCode ? savedMaker : null);

let state: PhoneState = stored ? { ...initial, maker: stored.maker, screen: 'make' } : { ...initial, maker: savedMaker };
const seenAtLoad = localStorage.getItem(SEEN);
if (stored && (['released', 'kept', 'resting', 'failed'] as const).some((f) => f === seenAtLoad)) state = { ...state, seen: seenAtLoad as Finished };
let image: ImageIn | null = null;
let sent = false;
const pad = new PadModel();
/** What only the screen needs (a waiting button, a friendly line); reset whenever the screen changes. */
let ui: Pick<View, 'hint' | 'busy' | 'tweaking'> = {};
/** The Fighters tab's own waits and line: they outlive the making screens' changes (and those outlive a tab switch). */
let ringUi: RingUi = {};
let shown: PhoneState['screen'] | null = null;
let shownTab: PhoneState['tab'] = undefined;
/** A Crown hold is on: a redraw would drop it, so redraws wait until it ends. */
let holding = false;
let renderLater = false;

function render() {
  if (holding) { renderLater = true; return; }
  if (state.screen !== shown) { ui = {}; shown = state.screen; window.scrollTo(0, 0); }
  if (state.tab !== shownTab) { shownTab = state.tab; window.scrollTo(0, 0); }
  const thumb = image ? `data:${image.mediaType};base64,${image.base64}` : null;
  clear(app).append(screen({ state, thumb, needCode: !urlCode, ...ui, ringUi }, handlers));
}
function dispatch(a: Action) {
  const was = state.seen;
  state = reduce(state, a);
  if (state.seen !== was) { if (state.seen) localStorage.setItem(SEEN, state.seen); else localStorage.removeItem(SEEN); }
  if (a.type !== 'draft') render(); // typing does not rebuild the screen
}
const set = (patch: typeof ui) => { ui = { ...ui, ...patch }; render(); };
const setImage = (img: ImageIn | null) => {
  image = img;
  sent = false;
  state = reduce(state, { type: 'draft', hasImage: !!img });
  saveDraft();
  render();
};

/** The sent creature is on the TV now: start fresh (the words, the picture and the pad's drawing). */
function clearDraft() {
  image = null;
  sent = false;
  pad.clear();
  state = reduce(state, { type: 'draft', hasImage: false, words: '' });
  saveDraft();
}

/** The ring's news: no screen changes, so the making screens are left alone (a redraw would drop the keyboard) unless
 * the Fighters tab shows or its Again! dot comes or goes. A new phase ends a Crown / Again wait. */
function onRing(m: Extract<PhoneMsg, { type: 'ring' }>) {
  const dotWas = ringButtons(state).again;
  if (state.ring?.phase !== m.phase) ringUi = { ...ringUi, asked: undefined, hint: undefined };
  state = reduce(state, m);
  if (state.tab === 'fighters' || ringButtons(state).again !== dotWas) render();
}

function onMsg(m: PhoneMsg) {
  if (m.type === 'ring') return onRing(m);
  if (draftSpent(reduce(state, { type: 'msg', msg: m }), sent)) clearDraft();
  // Every message ends a wait on the TV ("Changing it…", a busy button): after a lock or a blip the answer itself may
  // have been missed, and the rejoin's hello says where things really are.
  ui = {};
  dispatch({ type: 'msg', msg: m });
}

const client = connect(localStorage, onMsg, () => dispatch({ type: 'rescan' }));
// after a screen lock or a Wi-Fi blip the old stream can be silently dead: say hello again
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') client.reconnect(); });
window.addEventListener('online', () => client.reconnect());

async function join(name: string, badge: string, typed: string) {
  const code = (typed || urlCode).trim().toUpperCase();
  if (code.length !== 4) return set({ hint: 'Type the 4 letters on the TV.' });
  const maker: Maker = { name: [...name].slice(0, 12).join(''), badge };
  set({ busy: true, hint: undefined });
  let r: 'ok' | 'badCode';
  try { r = await client.join(code, maker); } catch { return set({ busy: false, hint: OFFLINE }); }
  if (r === 'ok') {
    // the address now carries the code that works, so a refresh does not try the old one again
    if (code !== urlCode) { urlCode = code; history.replaceState(null, '', `?c=${code}`); }
    localStorage.setItem(MAKER, JSON.stringify(maker));
    return dispatch({ type: 'joined', maker });
  }
  if (!typed && rejoinNew && code !== rejoinNew.code) {
    localStorage.setItem(SESSION, JSON.stringify(rejoinNew));
    return location.replace(`?c=${rejoinNew.code}`);
  }
  // an old QR code (the TV restarted since): the address's code will never work again
  if (!typed && state.screen === 'join') { state = { ...state, maker }; return dispatch({ type: 'rescan' }); }
  set({ busy: false, hint: "That code doesn't match the TV. Have a look and try again!" });
}

/** What a refused action tells the kid ('unknown' needs nothing: the client already asked for a rescan). */
const refusal = (r: string) =>
  r === 'offline' ? OFFLINE : r === 'limit' ? 'That was the last change for this one.' : r === 'unknown' ? undefined : "Hmm, that didn't work. Try again!";
/** The same for a ring command. */
const ringRefusal = (r: string) =>
  r === 'slow' ? 'Whoa, one at a time!' : r === 'noHost' ? 'Open Rumble on the TV first' : refusal(r);
const setRing = (patch: RingUi) => { ringUi = { ...ringUi, ...patch }; render(); };

/** Crown or Again: the button waits until the TV's ring changes phase (or, if the TV had nothing to do, a few seconds). */
async function ask(kind: 'crown' | 'again') {
  setRing({ asked: kind, hint: undefined });
  const r = await client.command({ kind } satisfies PhoneCommand);
  if (r !== 'sent') return setRing({ asked: undefined, hint: ringRefusal(r) });
  setTimeout(() => { if (ringUi.asked === kind) setRing({ asked: undefined }); }, 5000);
}

/** A roster creature goes back in: its button says "On its way!" for a moment. */
async function sendBack(id: string) {
  const drop = () => setRing({ sentBack: (ringUi.sentBack ?? []).filter((x) => x !== id) });
  setRing({ sentBack: [...(ringUi.sentBack ?? []), id], hint: undefined });
  const r = await client.command({ kind: 'sendBack', id });
  if (r !== 'sent') { drop(); return setRing({ hint: ringRefusal(r) }); }
  setTimeout(drop, 4000);
}

const handlers: Handlers = {
  join: (name, badge, code) => void join(name, badge, code),
  async photo(file) {
    set({ hint: 'Opening your picture…' });
    const img = await encodeImage(file, 'photo');
    if (!img) return set({ hint: "Hmm, I can't open that picture. Try another!" });
    ui.hint = undefined;
    setImage(img);
  },
  draw: () => openPad(pad, (img) => { if (img) setImage(img); }),
  dropPicture: () => setImage(null),
  words(text) {
    sent = false;
    dispatch({ type: 'draft', words: text });
    saveDraft();
  },
  async bring() {
    set({ busy: true, hint: undefined });
    const r = await client.submit({ image, words: state.draft.words.trim() });
    if (r === 'queued' || r === 'busy') { sent = true; saveDraft(); }
    if (state.screen !== 'make') return; // the stream already moved on (straight onto the TV)
    if (r === 'queued' || r === 'busy') return dispatch({ type: 'submitted' });
    if (r === 'resting' || r === 'noHost') return dispatch({ type: 'msg', msg: { type: r } });
    set({ busy: false, hint: refusal(r) });
  },
  async leaveLine() {
    const r = await client.cancel();
    if (r === 'ok') dispatch({ type: 'again' });
    else set({ hint: refusal(r) });
  },
  async tweak(words) {
    set({ tweaking: true, hint: undefined });
    const r = await client.tweak(words);
    if (r !== 'sent' && state.screen === 'preview') set({ tweaking: false, hint: refusal(r) });
  },
  async release() {
    set({ busy: true, hint: undefined });
    const r = await client.release();
    if (r !== 'sent' && state.screen === 'preview') set({ busy: false, hint: refusal(r) });
  },
  async saveForLater() {
    const r = await client.cancel(); // the TV keeps the creature and answers `kept`
    if (r !== 'ok') set({ hint: refusal(r) });
  },
  again: () => dispatch({ type: 'again' }),
  tab: (t) => dispatch({ type: 'tab', tab: t }),
  crown: () => void ask('crown'),
  ringAgain: () => void ask('again'),
  sendBack: (id) => void sendBack(id),
  holding(on) {
    holding = on;
    if (!on && renderLater) { renderLater = false; render(); }
  },
};

render();
void loadDraft().then((d) => {
  if (!d) return;
  if (d.sent && draftSpent(state, true)) return clearDraft(); // the hello said "released" before the draft loaded
  sent = !!d.sent;
  image = d.image;
  state = reduce(state, { type: 'draft', hasImage: !!d.image, words: d.words });
  render();
});
if (autoJoin) void join(autoJoin.name, autoJoin.badge, '');

if (import.meta.env.DEV) {
  /** Dev: the page as it looks now, saved as .shots/<name>.png. */
  const shot = async (name: string) => {
    const { toCanvas } = await import('html-to-image');
    // the library waits on frames and on image decode(), which both stall while the pane is hidden: stand in for them
    const raf = window.requestAnimationFrame;
    const decode = HTMLImageElement.prototype.decode;
    window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 0);
    HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
      return this.complete ? Promise.resolve() : new Promise<void>((ok, fail) => { this.addEventListener('load', () => ok(), { once: true }); this.addEventListener('error', fail, { once: true }); });
    };
    let c: HTMLCanvasElement;
    try {
      c = await toCanvas(document.body, { width: innerWidth, height: innerHeight, pixelRatio: 2, skipFonts: true, backgroundColor: getComputedStyle(document.body).backgroundColor,
        filter: (n) => !(n instanceof HTMLInputElement && n.type === 'file') });
    } finally { window.requestAnimationFrame = raf; HTMLImageElement.prototype.decode = decode; }
    await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: c.toDataURL('image/png') });
    return name;
  };
  (window as unknown as { __phone: object }).__phone = { shot, state: () => state, msg: onMsg }; // msg: screens the fake host cannot reach (resting)
}
