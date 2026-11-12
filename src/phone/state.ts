import type { Maker, PhoneMsg, Ring, StepMsg } from '../bring/protocol';
import type { KidCards } from '../designer/types';

/** The phone page's screen flow as a pure reducer (types only from shared modules: the phone bundle loads no three.js). */

export type Screen = 'join' | 'make' | 'waiting' | 'making' | 'preview' | 'released' | 'kept' | 'resting' | 'failed' | 'noHost' | 'rescan';
/** A finished outcome the kid can acknowledge (Make another, Try again, OK). */
export type Finished = 'released' | 'kept' | 'resting' | 'failed';
/** `flow`: the making screens; `fighters`: the roster, with Crown / Again on top. */
export type Tab = 'flow' | 'fighters';
export type PhoneState = {
  screen: Screen; maker: Maker | null; place?: number; ahead?: Maker[]; step?: StepMsg;
  cards?: KidCards; tweaksLeft?: number; note?: string; message?: string; retry?: boolean;
  /** What the kid has picked or typed so far; it survives every screen change, so "Try again" keeps it. */
  draft: { hasImage: boolean; words: string };
  /** The finished outcome the kid already acknowledged; the relay keeps reporting it until the next submit, so a
   * rejoin's `hello` with that phase means "idle" (stay on make), not news. Cleared by a submit or a new turn. */
  seen?: Finished;
  /** How the ring stands (the TV's last word): it survives every screen change but `noHost` (the TV may come back new). */
  ring?: Ring;
  /** Which tab shows (absent: `flow`). News that changes the screen brings the kid back to `flow`. */
  tab?: Tab;
};
/** The relay's ring news: as a `msg`, or on its own (the same thing). */
export type RingNews = Extract<PhoneMsg, { type: 'ring' }>;
export type Action =
  | { type: 'msg'; msg: PhoneMsg } | { type: 'joined'; maker: Maker } | { type: 'rescan' }
  | { type: 'draft'; hasImage?: boolean; words?: string } | { type: 'submitted' } | { type: 'again' }
  | RingNews | { type: 'tab'; tab: Tab };

export const initial: PhoneState = { screen: 'join', maker: null, draft: { hasImage: false, words: '' } };

/** A fresh screen: only the maker, the draft, the acknowledged outcome and the ring carry over, so nothing stale (a
 * place, a note) leaks into it. The tab stays only while the screen does (news of a new screen is worth seeing). */
const to = (s: PhoneState, screen: Screen, extra: Partial<PhoneState> = {}): PhoneState => ({
  screen, maker: s.maker, draft: s.draft, ...(s.seen ? { seen: s.seen } : {}), ...(s.ring ? { ring: s.ring } : {}),
  ...(s.tab && screen === s.screen ? { tab: s.tab } : {}), ...extra,
});
/** The same without the acknowledged outcome: a new turn has begun. */
const fresh = (s: PhoneState, screen: Screen, extra: Partial<PhoneState> = {}): PhoneState => to({ ...s, seen: undefined }, screen, extra);
const finished = (x: Screen): x is Finished => x === 'released' || x === 'kept' || x === 'resting' || x === 'failed';

function onMsg(s: PhoneState, m: PhoneMsg): PhoneState {
  switch (m.type) {
    case 'hello': { // restores a rejoined phone to where the relay says it is
      const h = m.state;
      switch (h.phase) {
        case 'idle': return to(s, s.maker ? 'make' : 'join');
        case 'waiting': return fresh(s, 'waiting', { place: h.place });
        case 'making': return fresh(s, 'making');
        case 'preview': return fresh(s, 'preview', { cards: h.cards, tweaksLeft: h.tweaksLeft });
        case 'released': case 'kept': case 'resting':
          return to(s, s.seen === h.phase ? 'make' : h.phase); // already acknowledged: not news
      }
      return s;
    }
    // live news is a turn in progress or its outcome: whatever was acknowledged before is history
    case 'line':
      if (m.place >= 1) return fresh(s, 'waiting', { place: m.place, ahead: m.ahead });
      return s.screen === 'making' ? s : fresh(s, 'making');
    case 'step': return fresh(s, 'making', { step: m.step });
    case 'preview': return fresh(s, 'preview', { cards: m.cards, tweaksLeft: m.tweaksLeft });
    case 'tweaked': return fresh(s, 'preview', { cards: m.cards, tweaksLeft: m.tweaksLeft, note: m.note });
    case 'released': return fresh(s, 'released');
    case 'kept': return fresh(s, 'kept');
    case 'failed': return fresh(s, 'failed', { message: m.message, retry: m.retry });
    case 'resting': return fresh(s, 'resting');
    // not news of a turn: the acknowledgement stands. The ring goes: the TV that comes back may have a new match
    case 'noHost': return to({ ...s, ring: undefined }, 'noHost');
    case 'ring': return { ...s, ring: { phase: m.phase, fighting: m.fighting, roster: m.roster } }; // no screen change
  }
}

/** The next state for an action. */
export function reduce(s: PhoneState, a: Action): PhoneState {
  switch (a.type) {
    case 'msg': return onMsg(s, a.msg);
    case 'joined': return fresh({ ...s, maker: a.maker }, 'make');
    case 'rescan': return to(s, 'rescan');
    case 'draft': return { ...s, draft: { hasImage: a.hasImage ?? s.draft.hasImage, words: a.words ?? s.draft.words } };
    case 'submitted': return fresh(s, 'waiting');
    case 'again': return to(s, 'make', finished(s.screen) ? { seen: s.screen } : {});
    case 'ring': return onMsg(s, a);
    case 'tab': return { ...s, tab: a.tab };
  }
}

/** Screens with the Make / Fighters tabs: everywhere once the phone has joined and the TV is there. */
export const showsTabs = (s: PhoneState): boolean => s.screen !== 'join' && s.screen !== 'rescan' && s.screen !== 'noHost';

/** What the ring offers a phone: Crown while the match is open with someone fighting, Again once crowned. */
export function ringButtons(s: PhoneState): { crown: boolean; again: boolean } {
  const r = s.ring;
  return { crown: r?.phase === 'open' && r.fighting >= 1, again: r?.phase === 'crowned' };
}

/** Crowning is for grown-ups: the button must be held this long (letting go sooner cancels). */
export const CROWN_HOLD_S = 2;
/** How full the Crown button's ring is after holding it `seconds` (0..1; 1 crowns). */
export const holdProgress = (seconds: number): number => Math.min(1, Math.max(0, seconds / CROWN_HOLD_S));

/** The draft that was sent is on the TV now, so the page clears it: told live (`released`) or by the rejoin's
 * `hello` after a lock, a blip or a refresh missed that. `sent` is false once the kid has changed the draft since
 * sending it (a new creature on the way), and that one is kept. */
export const draftSpent = (next: PhoneState, sent: boolean): boolean => sent && next.screen === 'released';
