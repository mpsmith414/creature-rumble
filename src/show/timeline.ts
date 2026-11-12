import { ENTRANCE_S, GROUP_ENTRANCE_S } from '../match/rules';

/**
 * The entrance's clock (the spike's updateEntrance, spike/main.ts, stretched to the brief's 8.5 s): bounce down the
 * bridge, show off at its ring end (spin and jump), hop over the bumper into the ring, stand there until the match's
 * entrance ends. A group entrance runs the same steps in 5 s. Pure: no physics, no scene.
 */

export type EntrancePhase = 'walk' | 'showOff' | 'hopIn' | 'done';
export type EntranceBanner = 'maker' | 'name' | null;

export type EntranceAt = {
  phase: EntrancePhase;
  /** 0 … 1 along the bridge (eased). */
  walk: number;
  /** 0 … 1 through the hop over the bumper (eased); 1 once landed. */
  hop: number;
  /** Lift (m) of the walking bounce. */
  bob: number;
  /** Turn (rad) of the show-off spin, on top of the facing. */
  spin: number;
  /** The show-off jump, 0 … 1 … 0: × SHOW_JUMP × the fighter's ring height gives the lift. */
  jump: number;
  banner: EntranceBanner;
};

type Steps = { walk: number; showOff: number; hopIn: number; done: number; name: number; nameOff: number };
/** When each step ends (s); the name banner shows from `name` to `nameOff`. */
const SOLO: Steps = { walk: 4.5, showOff: 6, hopIn: 7.5, done: ENTRANCE_S, name: 1.6, nameOff: 6.2 };
const GROUP: Steps = { walk: 2.5, showOff: 3.5, hopIn: 4.5, done: GROUP_ENTRANCE_S, name: 0, nameOff: 4.5 };

/** The walking bounce: |sin(WALK_HOP_RATE × t)| × WALK_BOB m, settling over the walk's last WALK_SETTLE s. */
export const WALK_BOB = 0.35, WALK_HOP_RATE = 9, WALK_SETTLE = 0.3;
/** The show-off jump's height, × the fighter's ring height. */
export const SHOW_JUMP = 1.4;
/** Group members' bounces are this far (rad of the bounce) out of step, one to the next. */
const BOB_STAGGER = 1.1;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => { const k = clamp01(x); return k * k * (3 - 2 * k); };

/** A blank EntranceAt, for `entranceAt`'s `out`. */
export const entranceState = (): EntranceAt => ({ phase: 'walk', walk: 0, hop: 0, bob: 0, spin: 0, jump: 0, banner: null });

/**
 * Where an entrance is `t` s in. `member` (0 = the front of a group) only puts its bounce out of step with the others.
 * Writes into `out` when given (no new object each frame).
 */
export function entranceAt(t: number, group: boolean, member = 0, out: EntranceAt = entranceState()): EntranceAt {
  const s = group ? GROUP : SOLO;
  out.banner = t < s.name ? 'maker' : t < s.nameOff && t < s.done ? 'name' : null;
  out.walk = 1; out.hop = 0; out.bob = 0; out.spin = 0; out.jump = 0;
  if (t >= s.done) {
    out.phase = 'done';
    out.hop = 1;
  } else if (t < s.walk) {
    out.phase = 'walk';
    out.walk = smooth(t / s.walk);
    out.bob = Math.abs(Math.sin(WALK_HOP_RATE * t + member * BOB_STAGGER)) * WALK_BOB * clamp01((s.walk - t) / WALK_SETTLE);
  } else if (t < s.showOff) {
    const k = (t - s.walk) / (s.showOff - s.walk);
    out.phase = 'showOff';
    out.spin = smooth(k) * Math.PI * 2;
    out.jump = Math.sin(Math.PI * k);
  } else {
    out.phase = 'hopIn';
    out.hop = smooth((t - s.showOff) / (s.hopIn - s.showOff));
  }
  return out;
}

// ---- where everyone walks and lands (metres out from the ring's edge along the entry) ----

/** Group members walk in single file this far apart (m). */
export const MEMBER_GAP = 1.2;
/** The walk starts this far past the ring's edge (near the bridge's far end) and ends this far (just past the bumper). */
export const WALK_FROM = 8, WALK_TO = 1.3;
/** Everyone lands this far inside the ring's edge; a group fans out round the ring about this far apart (m). */
export const LAND_IN = 1.8, LAND_GAP = 1.3;

/**
 * A line of `n` on the bridge: `gap` between members (1.2 m, closer only when the line would not fit) and how far
 * (`travel`, m) everyone walks. The last one starts at WALK_FROM and the front one ends at WALK_TO.
 */
export function column(n: number): { gap: number; travel: number } {
  const room = WALK_FROM - WALK_TO;
  const gap = n > 1 ? Math.min(MEMBER_GAP, room / (n - 1)) : MEMBER_GAP;
  return { gap, travel: Math.max(0, room - (n - 1) * gap) };
}

/** The order a group walks in: as given, with the champion (if there is one among them) moved to the back. */
export function marchOrder<T>(members: readonly T[], champion: T | null | undefined): T[] {
  const out = members.filter((m) => m !== champion);
  if (out.length < members.length) out.push(champion as T);
  return out;
}

/** Where member `i` of `n` lands: radians round the ring from the entry, the group fanned out centred on it. */
export function landingAngle(i: number, n: number, ringRadius: number): number {
  return (i - (n - 1) / 2) * (LAND_GAP / (ringRadius - LAND_IN));
}
