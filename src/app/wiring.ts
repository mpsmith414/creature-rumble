/**
 * The TV's small, pure pieces of wiring between the phones, the roster, the announcer's voice and the ring, kept out of
 * main.ts and rumble.ts so they can be tested: phase-gated phone commands, the ring broadcast, sending a roster
 * fighter back in, the "coming soon" capsule as the workshop's screen, and stores that never throw.
 */
import type { BodyData } from '../builder/build';
import type { Studio } from '../bring/studio';
import type { WorkshopUi } from '../bring/workshop';
import type { Made } from '../bring/workshop';
import type { Maker, PhoneCommand, RingEntry, RingPhase } from '../bring/protocol';
import type { Recipe } from '../recipe/schema';
import type { RosterItem, RosterSummary } from '../roster/roster';

// ---------- phone commands ----------

/** What a phone's command may do, and when: the TV decides. */
export type CommandDeps = {
  phase(): RingPhase;
  /** How many are fighting in the ring now. */
  fighting(): number;
  crown(): void;
  again(): void;
  sendBack(id: string): unknown;
};

/**
 * A phone's crown, again or send-back, if the ring allows it now: Crown only while the ring is open with someone in it,
 * Again! only after a crowning (so a second press, or two phones at once, does nothing). Returns what was done.
 */
export function handleCommand(cmd: PhoneCommand, d: CommandDeps): 'crown' | 'again' | 'sendBack' | 'ignored' {
  if (cmd.kind === 'crown') {
    if (d.phase() !== 'open' || d.fighting() < 1) return 'ignored';
    d.crown();
    return 'crown';
  }
  if (cmd.kind === 'again') {
    if (d.phase() !== 'crowned') return 'ignored';
    d.again();
    return 'again';
  }
  void Promise.resolve(d.sendBack(cmd.id)).catch((e) => console.warn('send back failed', e));
  return 'sendBack';
}

// ---------- the ring broadcast ----------

/**
 * Tells every phone how the ring stands (`bring.sendRing`) whenever the match phase or the number fighting changes
 * (`watch`, every frame), the roster changes (`push`) or the relay is new (`push` on a fresh `hosting`). Pushes never
 * overlap: one asked for while another is on its way goes once after it, with the state as it is then.
 */
export class RingBroadcast {
  private last: { phase: RingPhase; fighting: number } | null = null;
  private busy: Promise<void> | null = null;
  private again = false;
  /** The roster as last read: a ring change sends it again; only `push(true)` (the roster changed) reads it afresh. */
  private entries: readonly RingEntry[] | null = null;
  private stale = true;

  constructor(private readonly o: {
    state(): { phase: RingPhase; fighting: number };
    roster(): Promise<readonly RingEntry[]>;
    send(phase: RingPhase, fighting: number, roster: readonly RingEntry[]): unknown;
  }) {}

  /** Push if the phase or the fighting count changed since the last push (cheap; call it every frame). */
  watch(): void {
    const s = this.o.state();
    if (this.last && s.phase === this.last.phase && s.fighting === this.last.fighting) return;
    void this.push(false);
  }

  /** Push now: the roster changed (`rosterChanged`, the default: it is read again), or the relay is new (`false`). */
  push(rosterChanged = true): Promise<void> {
    if (rosterChanged) this.stale = true;
    if (this.busy) {
      this.again = true;
      return this.busy;
    }
    this.busy = (async () => {
      do {
        this.again = false;
        const s = this.o.state();
        this.last = s;
        try {
          if (this.stale || !this.entries) {
            this.stale = false;
            try {
              this.entries = await this.o.roster();
            } catch (e) {
              this.stale = true; // read it again next time
              throw e;
            }
          }
          await this.o.send(s.phase, s.fighting, this.entries);
        } catch (e) {
          console.warn('could not tell the phones about the ring', e);
        }
      } while (this.again);
      this.busy = null;
    })();
    return this.busy;
  }
}

// ---------- send back in ----------

export type SendBackDeps = {
  /** Already in the ring, entering or on deck: nothing to load. */
  known?(id: string): boolean;
  get(id: string): Promise<RosterItem | undefined>;
  /** The saved body of a recipe, or null (the builder cache: `loadBody(bodyCacheKey(recipe))`). */
  cached(recipe: Recipe): Promise<BodyData | null>;
  build(recipe: Recipe): Promise<BodyData>;
  /** Into the ring: register the fighter and call `match.arrive` (an entrance follows). */
  arrive(item: RosterItem, body: BodyData): void;
};

/**
 * Sends a roster creature back into the ring: its body from the builder cache, or built again on a miss, then `arrive`.
 * An unknown id, or one already in the ring or on deck, does nothing (no body is loaded or built). True when it was sent.
 */
export async function sendBack(id: string, d: SendBackDeps): Promise<boolean> {
  if (d.known?.(id)) return false;
  const item = await d.get(id);
  if (!item) return false;
  const body = (await d.cached(item.recipe).catch(() => null)) ?? (await d.build(item.recipe));
  d.arrive(item, body);
  return true;
}

// ---------- a phone's creature, kept and sent in ----------

/**
 * "Send to the ring!" (`enter` true) or "Save for later": the creature is checked first (it must make a fighter), so a
 * recipe that cannot fight never leaves a broken roster entry; then it is kept, then (on a release) sent in. Throws
 * when it cannot be checked or kept.
 */
export async function keepMade<T>(made: Made, d: {
  check(made: Made): void;
  add(made: Made): Promise<T>;
  enter?(item: T, made: Made): void;
}): Promise<T> {
  d.check(made);
  const item = await d.add(made);
  d.enter?.(item, made);
  return item;
}

// ---------- the workshop's screen on the TV: the "coming soon" capsule ----------

/** How long (ms) the TV says "try again" after a turn fails. */
export const OOPS_MS = 3000;

export type CapsuleUi = WorkshopUi & {
  /** The workshop's off-screen studio (look-again pictures and thumbnails); none between turns. */
  studio: Pick<Studio, 'show' | 'snapshot'>;
  /** A turn is on (someone is making a creature). */
  readonly making: boolean;
};

/**
 * The workshop's TV screen in the Rumble (spec §2.12): the fight stays full-screen and only the capsule by the ramp
 * shows who is making one, with the bouncing silhouette once its shape exists. The studio still renders the designer's
 * look-again pictures, off-screen. A failure ("the designer is resting") hides the capsule and shows `oops` words.
 */
export function capsuleUi(capsule: { set(maker: Maker | null, silhouette: boolean): void }, o: {
  makeStudio(): Studio;
  oops(text: string): void;
  later?: (fn: () => void, ms: number) => unknown;
}): CapsuleUi {
  const later = o.later ?? ((fn, ms) => setTimeout(fn, ms));
  let maker: Maker | null = null, studio: Studio | null = null, failing = false;
  let waiting: (() => void)[] = [];
  const settle = () => {
    failing = false;
    const w = waiting;
    waiting = [];
    w.forEach((go) => go());
  };
  const close = () => {
    maker = null;
    capsule.set(null, false);
    studio?.dispose();
    studio = null;
  };
  return {
    get making() { return maker !== null; },
    open(m) {
      close();
      settle();
      maker = m;
      capsule.set(m, false);
      studio = o.makeStudio();
      studio.ready.catch((e) => console.error('workshop: the studio could not start', e));
    },
    step(s) {
      if (maker && (s.kind === 'building' || s.kind === 'looking' || s.kind === 'fixing' || s.kind === 'done')) capsule.set(maker, true);
    },
    reveal() {
      if (maker) capsule.set(maker, true);
    },
    note() {},
    oops(text) {
      close();
      failing = true;
      o.oops(text);
      later(settle, OOPS_MS);
    },
    close,
    idle: () => (failing ? new Promise<void>((go) => waiting.push(go)) : Promise.resolve()),
    studio: {
      show: (b, r) => (studio ? studio.show(b, r) : Promise.resolve()),
      snapshot: (b, r, v, size) => (studio ? studio.snapshot(b, r, v, size) : Promise.reject(new Error('the workshop has closed'))),
    },
  };
}

// ---------- stores and stand-ins that never throw ----------

/** The announcer's recently-said line ids in localStorage; a storage that throws (private mode, quota) just forgets. */
export function localStore(key: string, storage: () => Storage | undefined = () => globalThis.localStorage): { get(): string[]; set(ids: string[]): void } {
  return {
    get() {
      try {
        const v = JSON.parse(storage()?.getItem(key) ?? '[]');
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        return [];
      }
    },
    set(ids) {
      try {
        storage()?.setItem(key, JSON.stringify(ids));
      } catch { /* a nicety only */ }
    },
  };
}

/** What the TV uses of the roster (the IndexedDB `Roster`, or `memoryRoster` where that cannot open). */
export type RosterLike = {
  add(made: Made, now: number): Promise<RosterItem>;
  get(id: string): Promise<RosterItem | undefined>;
  list(): Promise<RosterItem[]>;
  summaries(): Promise<RosterSummary[]>;
  crowned(id: string): Promise<void>;
  fought(ids: string[]): Promise<void>;
};

/** A roster kept only in memory (no IndexedDB here): tonight's creatures still go round, they are just not kept. */
export function memoryRoster(): RosterLike {
  const items = new Map<string, RosterItem>();
  let n = 0;
  const list = async () => [...items.values()].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  const bump = (ids: string[], k: 'crowns' | 'bouts') => {
    for (const id of new Set(ids)) {
      const it = items.get(id);
      if (it) items.set(id, { ...it, [k]: it[k] + 1 });
    }
  };
  return {
    async add(made, now) {
      const item: RosterItem = { id: `m${++n}`, recipe: made.recipe, cards: made.cards, maker: made.maker, thumb: null, createdAt: now, crowns: 0, bouts: 0 };
      items.set(item.id, item);
      return item;
    },
    get: async (id) => items.get(id),
    list,
    summaries: async () => (await list()).map((i) => ({ id: i.id, name: i.cards.name, maker: i.maker.name, crowns: i.crowns, thumb: null })),
    crowned: async (id) => bump([id], 'crowns'),
    fought: async (ids) => bump(ids, 'bouts'),
  };
}

// ---------- the voice waits for the audio to be unlocked ----------

type VoiceLike = { prefetch(text: string): void; isReady(text: string): boolean; play(text: string, onEnd: () => void): { spoken: boolean; seconds: number }; stop(): void };

/**
 * The announcer's voice, silent until the browser lets sound play (`live`: the first key, remote press or click): lines
 * still fetch and decode meanwhile, but none is spoken (a suspended audio context would play them late, all at once),
 * so the show runs on words only and nothing waits for audio.
 */
export function gatedVoice(v: VoiceLike, live: () => boolean): VoiceLike {
  return {
    prefetch: (t) => v.prefetch(t),
    isReady: (t) => live() && v.isReady(t),
    play: (t, onEnd) => (live() ? v.play(t, onEnd) : { spoken: false, seconds: 0 }),
    stop: () => v.stop(),
  };
}
