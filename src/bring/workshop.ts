import type { BodyData } from '../builder/build';
import type { DesignerApi } from '../designer/api';
import { imageUrl } from '../designer/image';
import type { designCreature, PassRecord, ProgressStep, tweakCreature } from '../designer/loop';
import type { ImageIn, KidCards, View } from '../designer/types';
import type { Recipe } from '../recipe/schema';
import { h } from '../shared/dom';
import type { Bring } from './bring';
import type { DesignInput, HostSend, Maker, StepMsg } from './protocol';
import type { Studio } from './studio';
import './bring.css';

/** What the TV and the phone say when the designer rests, answers badly twice or a body cannot be built (spec §6). */
export const TRY_AGAIN = "Hmm, let's try that one again!";
/** The TV's line when the designer finds no creature or declines (the phone gets the designer's own sentence). */
export const TRY_ANOTHER = "Let's try another drawing!";
const THUMB_VIEW: View = { angle: 'threeQuarter', facing: 'right' };

export type WorkshopUi = {
  open(maker: Maker, input: DesignInput): void;
  step(s: ProgressStep): void;
  reveal(cards: KidCards): void;
  note(n: string): void;
  /** A friendly failure, shown for a few seconds; the UI then closes by itself (unless a new turn opens it). */
  oops(text: string): void;
  close(): void;
  /** Resolves once the screen is free for a new turn: no "try again" still showing out its seconds. */
  idle?(): Promise<void>;
};
export type WorkshopDeps = {
  design: typeof designCreature; tweak: typeof tweakCreature; api: DesignerApi; build(r: Recipe): Promise<BodyData>;
  studio: Pick<Studio, 'show' | 'snapshot'>; send(token: string, m: HostSend): Promise<boolean>; ui: WorkshopUi; now(): number;
};
/** A creature the workshop made, for the release (or to keep). */
export type Made = {
  token: string; maker: Maker; input: DesignInput; recipe: Recipe; body: BodyData; cards: KidCards; history: PassRecord[]; thumb: ImageIn;
};

/** The phone's version of a step: `looking` without its picture, nothing for `done` (the preview follows). */
function stepMsg(s: ProgressStep): StepMsg | null {
  switch (s.kind) {
    case 'reading': case 'building': return { kind: s.kind };
    case 'looking': return { kind: 'looking', pass: s.pass };
    case 'fixing': return { kind: 'fixing', pass: s.pass, note: s.note };
    case 'done': return null;
  }
}

/**
 * Send a turn-ending message (`released`, `kept`, `failed`), once more after `retryMs` if the relay did not take it: the
 * relay waits for it before the line moves on, and it does not replay what it missed.
 */
export async function sendEnd(send: WorkshopDeps['send'], token: string, m: HostSend, retryMs = 1000): Promise<boolean> {
  if (await send(token, m).catch(() => false)) return true;
  await new Promise((go) => setTimeout(go, retryMs));
  return send(token, m).catch(() => false);
}

/** Thrown into the design loop when its turn was cancelled: what comes back after that goes no further. */
class Stopped extends Error {}

type Turn = {
  token: string; maker: Maker; input: DesignInput;
  phase: 'making' | 'preview' | 'tweaking';
  /** Cancelled, released or ended: nothing more is shown or sent for it. */
  stop: boolean;
  /** The read's cards, and the last body that built (a creature exists from the first build). */
  cards: KidCards | null;
  built: { recipe: Recipe; body: BodyData } | null;
  /** A build or a picture under way: a cancel waits for it (a build changes what there is to keep). */
  busyWith: Promise<unknown> | null;
  made: Made | null;
  /** The last message the phone was sent, to say again when the relay comes back (it does not replay them). */
  last: HostSend | null;
};

/**
 * The turn's controller (spec §3.2–§3.5): runs the design loop for the phone on stage, shows each step on the TV and
 * tells the phone, reveals the creature with its cards, rebuilds it for tweaks, and hands it over on release or cancel.
 * Pure logic: the designer, the builder, the studio, the relay and the screen are injected.
 */
export class Workshop {
  private cur: Turn | null = null;
  /** The phone's messages go one after another, so a late step never lands after the preview. */
  private out: Promise<unknown> = Promise.resolve();
  private readonly passes: number;
  private readonly retryMs: number;

  constructor(private readonly deps: WorkshopDeps, opts: { passes?: number; retryMs?: number } = {}) {
    this.passes = opts.passes ?? 3;
    this.retryMs = opts.retryMs ?? 1000;
  }

  /** A creature is on stage (being made, or at the preview). */
  get busy(): boolean {
    return this.cur !== null;
  }
  /** The phone on stage, or null. */
  get token(): string | null {
    return this.cur?.token ?? null;
  }
  /** Resolves once the screen is free for a new turn (a "try again" has had its seconds, spec §3.5). */
  idle(): Promise<void> {
    return this.deps.ui.idle?.() ?? Promise.resolve();
  }

  /** Run a turn: design (steps → phone `step` + ui), then reveal + phone `preview`. Failures → ui.oops + phone `failed`. */
  async turn(token: string, maker: Maker, input: DesignInput): Promise<void> {
    if (this.cur?.token === token) return; // already on stage
    if (this.cur) this.end(this.cur); // last resort: `connectWorkshop` closes an open turn (kept) before starting another
    const t: Turn = { token, maker, input, phase: 'making', stop: false, cards: null, built: null, busyWith: null, made: null, last: null };
    this.cur = t;
    const { ui, studio } = this.deps;
    const began = this.deps.now();
    ui.open(maker, input);

    /** One call of the loop's: none starts after a cancel, and what returns after one goes no further. */
    const call = async <T>(f: () => Promise<T>): Promise<T> => {
      if (t.stop) throw new Stopped();
      const r = await f();
      if (t.stop) throw new Stopped();
      return r;
    };
    /** A build or a picture: a cancel waits for it to return. */
    const held = <T>(f: () => Promise<T>) => call(() => {
      const p = f();
      t.busyWith = p;
      return p.finally(() => {
        if (t.busyWith === p) t.busyWith = null;
      });
    });
    const api: DesignerApi = {
      read: (r) => call(async () => {
        const res = await this.deps.api.read(r);
        if (res.status === 'ok') t.cards = res.cards;
        return res;
      }),
      lookAgain: (r) => call(() => this.deps.api.lookAgain(r)),
      tweak: (r) => call(() => this.deps.api.tweak(r)),
    };
    const build = (r: Recipe) => held(async () => {
      const body = await this.deps.build(r);
      t.built = { recipe: r, body };
      if (!t.stop) await studio.show(body, r); // each build appears on the stage
      return body;
    });
    const snapshot = (b: BodyData, r: Recipe, v: View) => held(() => studio.snapshot(b, r, v));
    const onStep = (s: ProgressStep) => {
      if (t.stop) return;
      ui.step(s);
      const m = stepMsg(s);
      if (m) void this.say(t, { type: 'step', step: m });
    };

    try {
      const out = await this.deps.design({ image: input.image, words: input.words }, { api, build, snapshot }, { passes: this.passes }, onStep);
      if (t.stop) return; // (a stop inside a fix's build ends the loop without a throw)
      if (out.status !== 'ok') {
        this.end(t);
        ui.oops(TRY_ANOTHER);
        await this.say(t, { type: 'failed', message: out.message, retry: true });
        return;
      }
      await held(async () => {
        const thumb = await studio.snapshot(out.body, out.recipe, THUMB_VIEW, 256);
        t.made = { token, maker, input, recipe: out.recipe, body: out.body, cards: out.cards, history: out.history, thumb };
      });
      t.phase = 'preview';
      ui.reveal(out.cards);
      console.info(`workshop: ${out.cards.name} made in ${((this.deps.now() - began) / 1000).toFixed(1)} s`);
      await this.say(t, { type: 'preview', cards: out.cards });
    } catch (e) {
      if (t.stop) return; // cancelled (`cancel` finishes it) or replaced by another turn
      console.error('workshop: the creature could not be made', e);
      this.end(t);
      ui.oops(TRY_AGAIN);
      await this.say(t, { type: 'failed', message: TRY_AGAIN, retry: true });
    }
  }

  /**
   * "Make it fluffier": rebuild on the stage → phone `tweaked` with the new cards and the note. A declined tweak or one
   * that fails keeps the creature as it was and answers `tweaked` with the unchanged cards and a kind note: a `failed`
   * would end the turn on the relay, and the kid is still at the preview.
   */
  async tweak(token: string, words: string): Promise<void> {
    const t = this.cur;
    if (!t || t.token !== token || t.phase !== 'preview' || !t.made) return;
    const made = t.made, { ui, studio } = this.deps;
    const live = () => this.cur === t && !t.stop;
    t.phase = 'tweaking';
    ui.step({ kind: 'fixing', pass: 0, note: `“${words}”` }); // the kid's words while the designer thinks (pass 0: a tweak)
    let moved = false; // the stage shows a new body
    const keep = async (note: string) => {
      if (moved) await studio.show(made.body, made.recipe).catch(() => {});
      if (!live()) return;
      t.phase = 'preview';
      ui.reveal(made.cards);
      ui.note(note);
      await this.say(t, { type: 'tweaked', cards: made.cards, note });
    };
    try {
      const out = await this.deps.tweak(made.recipe, made.cards, words, {
        api: this.deps.api,
        build: async (r) => {
          if (live()) ui.step({ kind: 'building' });
          const body = await this.deps.build(r);
          if (live()) {
            await studio.show(body, r);
            moved = true;
          }
          return body;
        },
      });
      if (!live()) return;
      if (out.status !== 'ok') return await keep(out.message);
      const thumb = await studio.snapshot(out.body, out.recipe, THUMB_VIEW, 256);
      if (!live()) return;
      t.made = { ...made, recipe: out.recipe, body: out.body, cards: out.cards, thumb };
      t.phase = 'preview';
      ui.reveal(out.cards);
      ui.note(out.note);
      await this.say(t, { type: 'tweaked', cards: out.cards, note: out.note });
    } catch (e) {
      if (!live()) return;
      console.error('workshop: the tweak could not be made', e);
      await keep(TRY_AGAIN);
    }
  }

  /** Hands the made creature to the release flow (Task 12): only at the preview (a tweak under way is dropped). */
  release(token: string): Made | null {
    const t = this.cur;
    if (!t || t.token !== token || t.stop || !t.made || t.phase === 'making') return null;
    this.end(t);
    return t.made;
  }

  /**
   * Back/Escape or the relay's cancel: stop the turn and close the UI. A build or a picture under way is waited for
   * (it may be the first body); a designer call is not (its answer could only change a creature we are not keeping).
   * Returns what was made, as it stands, for keeping; with nothing made the phone is told `failed` here.
   */
  async cancel(token: string): Promise<Made | null> {
    const t = this.cur;
    if (!t || t.token !== token || t.stop) return null;
    t.stop = true;
    if (t.busyWith) await t.busyWith.catch(() => {});
    let made = t.made;
    if (!made && t.built && t.cards) {
      try {
        const thumb = await this.deps.studio.snapshot(t.built.body, t.built.recipe, THUMB_VIEW, 256);
        made = { token, maker: t.maker, input: t.input, ...t.built, cards: t.cards, history: [], thumb };
      } catch (e) {
        console.error('workshop: the creature could not be kept', e);
      }
    }
    this.end(t);
    this.deps.ui.close();
    if (!made) await this.say(t, { type: 'failed', message: TRY_AGAIN, retry: true });
    return made;
  }

  /**
   * A turn cancelled before it was ever shown (it was waiting for the stage), or a cancel for a turn this page does not
   * have (its end was lost on the way): nothing is here to keep, so the phone hears `failed` and the line moves on.
   */
  dropped(token: string): Promise<boolean> {
    const p = this.out.then(() => sendEnd(this.deps.send, token, { type: 'failed', message: TRY_AGAIN, retry: true }, this.retryMs));
    this.out = p;
    return p;
  }

  /** Say the last message again (the relay came back: it does not replay what it missed). */
  resync(): void {
    const t = this.cur;
    if (t?.last && !t.stop) void this.say(t, t.last);
  }

  private end(t: Turn) {
    t.stop = true;
    if (this.cur === t) this.cur = null;
  }

  private say(t: Turn, m: HostSend): Promise<boolean> {
    if (m.type !== 'failed') t.last = m;
    const go = () => (m.type === 'failed' ? sendEnd(this.deps.send, t.token, m, this.retryMs) : this.deps.send(t.token, m));
    const p = this.out.then(go).catch(() => false);
    this.out = p;
    return p;
  }
}

/**
 * What the TV does with a finished creature (saves it and sends it to the ring, or keeps it; either may return a promise of
 * when it is done), `ready`: resolves when the stage is free for a new turn (Ruling R17: not during an arrival's camera
 * hold), and `opening`: the workshop is about to take the screen (the menu closes, the mouse is let go).
 */
export type WorkshopHooks = { onRelease(made: Made): unknown; onKept(made: Made): unknown; ready?(): Promise<void>; opening?(): void };

/**
 * Route the relay's messages to the workshop and keep the join card's "making" in step with it. Returns `back` for the
 * TV's Back/Escape (the same outcome as the relay's cancel), and `waiting`: a turn waits for the stage.
 */
export function connectWorkshop(bring: Pick<Bring, 'on' | 'onStatus' | 'setMaking'>, ws: Workshop, hooks: WorkshopHooks) {
  const idle = () => {
    if (!ws.busy) bring.setMaking(false);
  };
  /** Turns ended here whose outcome is still on its way to the relay (a release or a keep saving): a cancel waits for it. */
  const handing = new Set<string>();
  const handOver = (token: string, f: () => unknown) => {
    handing.add(token);
    void new Promise((go) => go(f())).catch(() => {}).finally(() => handing.delete(token)); // (f starts at once)
  };
  /** Close the turn on stage as a cancel: what was made goes to be kept. */
  const keep = async (token: string, after = idle) => {
    if (handing.has(token)) return; // already being kept (Back and the relay's cancel together)
    handing.add(token);
    try {
      const made = await ws.cancel(token);
      after();
      if (made) await hooks.onKept(made);
    } finally {
      handing.delete(token);
    }
  };
  /** A turn the relay gave while the stage was not free yet (Ruling R17): it starts when it is, unless cancelled meanwhile. */
  let deferred: string | null = null;
  bring.on((m) => {
    if (m.type === 'turn') {
      void (async () => {
        deferred = m.token;
        await Promise.all([hooks.ready?.(), ws.idle()]);
        if (deferred !== m.token) return; // cancelled while it waited (or the relay forgot it)
        // another turn still open (the relay moved on without hearing from us): keep what it made before starting
        const open = ws.token;
        if (open && open !== m.token) await keep(open, () => bring.setMaking(true));
        if (deferred !== m.token) return; // cancelled meanwhile
        deferred = null;
        hooks.opening?.();
        await ws.turn(m.token, m.maker, m.input);
        idle();
      })();
    }
    else if (m.type === 'tweak') void ws.tweak(m.token, m.words);
    else if (m.type === 'cancel' && deferred === m.token) {
      // never shown: as a cancel with nothing made
      deferred = null;
      idle();
      void ws.dropped(m.token);
    } else if (m.type === 'cancel') {
      if (handing.has(m.token)) return; // its answer is on its way
      if (ws.token === m.token) void keep(m.token);
      // a turn this page does not have (its answer was lost, or the page reloaded): say so, or the line stalls
      else void ws.dropped(m.token);
    } else if (m.type === 'release') {
      const made = ws.release(m.token);
      if (!made) return;
      idle();
      handOver(m.token, () => hooks.onRelease(made));
    }
  });
  bring.onStatus((s, fresh) => {
    if (deferred && (s === 'replaced' || (s === 'hosting' && fresh))) deferred = null; // nobody to make it for now
    else if (deferred && s === 'hosting') bring.setMaking(true); // still waiting for the stage: the drop cleared it
    const token = ws.token;
    if (!token) return;
    if (s === 'hosting' && fresh) void keep(token); // a restarted relay forgot the phone: nobody can release it now
    else if (s === 'hosting') {
      bring.setMaking(true); // the same relay, reattached: the drop cleared it, and it does not replay the turn
      ws.resync();
    } else if (s === 'replaced') void ws.cancel(token); // the newer page makes it again
  });
  return {
    back: async () => {
      const token = ws.token;
      if (token) await keep(token);
    },
    /** A turn came and waits for the stage (an arrival's hold, a "try again"): the menu stays shut meanwhile. */
    get waiting() {
      return deferred !== null;
    },
  };
}

// ---------- the screen: the dimmed ring, the stage, the drawing, the captions and the cards ----------

const OOPS_MS = 3000;
const FADE_MS = 600;
const CARD_ROWS: [keyof KidCards, string][] = [['eats', 'Eats'], ['speed', 'Speed'], ['mood', 'Mood'], ['special', 'Special']];

export type WorkshopView = WorkshopUi & {
  /** The workshop is on the screen (it takes Back/Escape, and the menu stays shut). */
  readonly showing: boolean;
  /** The studio of the turn on screen (calls wait for it to be ready; none after it closes). */
  studio: Pick<Studio, 'show' | 'snapshot'>;
  /** The TV's frame: step the studio (a no-op: the TV shows no turntable, see `studio.ts`), and draw the stage. */
  turn(dt: number): void;
  render(): void;
  /** Dev: draw the stage now and pin it as a still picture (a page shot copies pictures, not a WebGPU canvas); `false` lets go. */
  still(on: boolean): void;
};

/**
 * The workshop's DOM half: a dim layer over the whole ring, the studio's canvas centred at 60 % of the height (16:10),
 * the drawing (or the words in large type) pinned on the left, the maker's badge and name above, the caption below; on
 * the reveal the name in large type and the cards in a row. Sized in vh so it reads the same on any TV.
 */
export function workshopView(root: HTMLElement, makeStudio: (parent: HTMLElement) => Studio, passes = 3): WorkshopView {
  let el: HTMLElement | null = null, studio: Studio | null = null;
  let parts: ReturnType<typeof build> | null = null;
  let oopsTimer = 0;
  /** Who waits for the "try again" to have its seconds (`idle`). */
  let oopsWaiting: (() => void)[] = [];
  const oopsOver = () => {
    const w = oopsWaiting;
    oopsWaiting = [];
    w.forEach((go) => go());
  };
  /** A closing one fading out, with its studio still drawing until it has gone. */
  let fading: { el: HTMLElement; studio: Studio | null; timer: number } | null = null;

  const finishFade = () => {
    if (!fading) return;
    clearTimeout(fading.timer);
    fading.el.remove();
    fading.studio?.dispose();
    fading = null;
  };

  function build(maker: Maker, input: DesignInput) {
    const who = h('span', { class: 'ws-who' }, maker.name ? `${maker.name}’s creature` : 'A new creature');
    const name = h('h1', { class: 'ws-name' });
    const words = input.words.trim();
    const paper = h('figure', { class: `ws-paper${input.image ? '' : ' words-only'}` },
      input.image ? h('img', { src: imageUrl(input.image), alt: 'The drawing' }) : null,
      words ? h('blockquote', { class: 'ws-words' }, `“${words}”`) : null,
      h('figcaption', {}, `${maker.name || 'Your'}${maker.name ? '’s' : ''} ${input.image ? 'drawing' : 'words'}`));
    const bubble = h('div', { class: 'ws-bubble', hidden: true });
    const oops = h('div', { class: 'ws-oops', hidden: true });
    const stage = h('div', { class: 'ws-stage' }, bubble, oops);
    const text = h('span', { class: 'ws-text' });
    const dots = h('span', { class: 'ws-dots', hidden: true }, ...Array.from({ length: passes }, () => h('i', {})));
    const caption = h('div', { class: 'ws-caption' }, h('span', { class: 'ws-spin', 'aria-hidden': 'true' }), text, dots);
    const cards = h('ul', { class: 'ws-cards', hidden: true });
    const box = h('section', { class: 'ws', 'aria-label': 'Making a creature', 'aria-live': 'polite' },
      h('header', { class: 'ws-head' }, h('div', { class: 'ws-maker' }, h('span', { class: 'ws-badge' }, maker.badge), who), name),
      stage, paper, h('footer', { class: 'ws-foot' }, caption, cards));
    return { box, name, stage, bubble, oops, text, dots, caption, cards, hasImage: !!input.image };
  }

  const say = (text: string, working: boolean, pass = 0) => {
    if (!parts) return;
    const p = parts;
    if (p.box.classList.contains('revealed')) {
      // after the reveal the cards stay; the stage's bubble says what is happening
      p.bubble.textContent = text;
      p.bubble.classList.toggle('working', working);
      p.bubble.hidden = false;
      return;
    }
    p.text.textContent = text;
    p.caption.classList.toggle('working', working);
    p.dots.hidden = pass < 1;
    [...p.dots.children].forEach((d, i) => d.classList.toggle('on', i < pass));
  };

  const view: WorkshopView = {
    get showing() {
      return el !== null;
    },
    open(maker, input) {
      view.close();
      finishFade();
      clearTimeout(oopsTimer);
      parts = build(maker, input);
      el = parts.box;
      root.append(el);
      studio = makeStudio(parts.stage);
      studio.ready.catch((e) => console.error('workshop: the studio could not start', e));
      say(parts.hasImage ? 'Reading the drawing…' : 'Reading the words…', true);
    },
    step(s) {
      if (!parts) return;
      const p = parts, making = !p.box.classList.contains('revealed');
      // while it is made, the designer's note stays up in the stage's bubble through the rebuild that follows at once
      if (making && s.kind !== 'building') p.bubble.hidden = true;
      if (s.kind === 'reading') say(p.hasImage ? 'Reading the drawing…' : 'Reading the words…', true);
      else if (s.kind === 'building') say('Building…', true);
      else if (s.kind === 'looking') say('Looking again…', true, s.pass);
      else if (s.kind === 'fixing') {
        say(s.note || 'Fixing a few things…', true, s.pass);
        if (making && s.note) {
          p.bubble.textContent = s.note;
          p.bubble.classList.remove('working');
          p.bubble.hidden = false;
        }
      } else say('Ta-da!', false, passes);
    },
    reveal(cards) {
      if (!parts) return;
      const p = parts;
      p.name.textContent = cards.name;
      p.cards.replaceChildren(...CARD_ROWS.map(([k, label]) =>
        h('li', { class: `ws-card ws-card-${k}` }, h('span', { class: 'ws-card-label' }, label), h('span', { class: 'ws-card-value' }, cards[k]))));
      p.cards.hidden = false;
      p.caption.hidden = true;
      p.bubble.hidden = true;
      p.box.classList.add('revealed');
    },
    note(n) {
      if (parts && n) say(n, false);
    },
    oops(text) {
      if (!parts) return;
      parts.oops.textContent = text;
      parts.oops.hidden = false;
      parts.caption.hidden = parts.bubble.hidden = true;
      parts.box.classList.add('failed');
      clearTimeout(oopsTimer);
      oopsTimer = window.setTimeout(() => view.close(), OOPS_MS);
    },
    idle() {
      return parts?.box.classList.contains('failed') ? new Promise<void>((go) => oopsWaiting.push(go)) : Promise.resolve();
    },
    close() {
      oopsOver();
      if (!el) return;
      clearTimeout(oopsTimer);
      finishFade();
      el.classList.add('closing');
      fading = { el, studio, timer: window.setTimeout(finishFade, FADE_MS) };
      el = null;
      studio = null;
      parts = null;
    },
    studio: {
      show: (b, r) => (studio ? studio.show(b, r) : Promise.resolve()),
      snapshot: (b, r, v, size) => (studio ? studio.snapshot(b, r, v, size) : Promise.reject(new Error('the workshop has closed'))),
    },
    turn(dt) {
      studio?.turn(dt);
      fading?.studio?.turn(dt);
    },
    render() {
      studio?.render();
      fading?.studio?.render();
    },
    still(on) {
      if (!studio || !parts) return;
      parts.box.classList.toggle('ws-still', on); // a copied page starts its animations over: show them finished
      if (on) {
        studio.render();
        parts.stage.style.backgroundImage = `url(${studio.canvas.toDataURL('image/png')})`; // same task as the render
        studio.canvas.remove(); // out of the page meanwhile: copying a WebGPU canvas hangs while the window is hidden
      } else {
        parts.stage.style.backgroundImage = '';
        parts.stage.prepend(studio.canvas);
      }
    },
  };
  return view;
}
