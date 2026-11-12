import type RAPIER from '@dimforge/rapier3d-compat';
import type { Fighter, FightCtx, Hit } from '../fight/fighter';
import type { Tune } from '../fight/tune';
import { isOut, type Match, type MatchEvent } from '../match/match';
import { setFrozen } from '../show/entrance';
import type { SlowMo } from '../show/slowmo';

/** One physics step (s). */
export const DT = 1 / 60;
/** At most this many physics steps in one frame (a stalled frame drops the rest rather than spiral). */
export const MAX_STEPS = 4;
/**
 * The most ragdolls one world may hold: each takes one of Rapier's 16 collision-group bits (so its own pieces never
 * collide, Ruling in Task 6). Past 16 two creatures would share a bit and pass through each other.
 */
export const MAX_RAGDOLLS = 16;
/** A fallen fighter is let go this long (s) after it went out, or as soon as it is this far down (the ball pit). */
export const GONE_AFTER_S = 5, GONE_BELOW_Y = -11;
/** A fresh random stream for the fight (the dev panel may reseed it). */
type Rng = () => number;

/** What the loop asks of an entrance: posing its walkers once per physics step, before anyone thinks. */
export type EntranceStep = { update(dt: number): void };

/**
 * The ring's fight loop (spec §3): fixed 1/60 s physics steps, at most four a frame, scaled by the slow-mo; the match
 * ticks every step (its events go to `onEvents` at once, so an entrance starts before the next step). While the match
 * is frozen for an entrance the fighting fighters are held mid-flail (`setFrozen`) and do not think; the world steps
 * only while someone is entering (the entrance poses them and their show-off limbs swing). Fighters that leave the ring
 * (`isOut`) are ruled out with the match, then let go 5 s later or once they reach the ball pit.
 */
export class RingLoop {
  /** Called with the match's events, inside the step that made them. */
  onEvents: (events: MatchEvent[]) => void = () => {};
  /** A fighter was disposed (its ragdoll is gone): take its picture, stars and crown away. */
  onGone: (f: Fighter) => void = () => {};
  /** The crowned champion struts (boasts) and is never frozen; null before a crowning. */
  champion: Fighter | null = null;
  /** The dev panel's "freeze fight during entrances". */
  freeze = true;
  /** Physics seconds simulated so far (the fighters' brains read it). */
  sim = 0;
  private readonly world: RAPIER.World;
  private readonly match: Match;
  private readonly slowmo: SlowMo;
  private readonly tune: Tune;
  private readonly entrance: EntranceStep | null;
  private readonly fighters = new Map<string, Fighter>();
  /** When (real s) each fallen fighter went out. */
  private readonly outAt = new Map<Fighter, number>();
  private readonly tally = new Map<string, number>();
  private acc = 0;
  private rng: Rng;
  private readonly ring: Fighter[] = [];
  private readonly ctx: FightCtx;
  private readonly boastCtx: FightCtx;

  constructor(o: { world: RAPIER.World; match: Match; slowmo: SlowMo; tune: Tune; entrance?: EntranceStep | null; rng?: Rng }) {
    this.world = o.world;
    this.match = o.match;
    this.slowmo = o.slowmo;
    this.tune = o.tune;
    this.entrance = o.entrance ?? null;
    this.rng = o.rng ?? Math.random;
    this.ctx = { others: this.ring, boast: false, tune: this.tune, rng: (() => this.rng()) };
    this.boastCtx = { ...this.ctx, boast: true };
  }

  /** How many fighters (ragdolls) it holds, fallen ones included. */
  get size(): number {
    return this.fighters.size;
  }

  get(id: string): Fighter | undefined {
    return this.fighters.get(id);
  }

  all(): Fighter[] {
    return [...this.fighters.values()];
  }

  /**
   * Is there room for one more ragdoll? When the world is full the earliest fallen fighters are let go now to make it.
   * False only when every ragdoll is still in play (never with at most 8 in the ring).
   */
  makeRoom(): boolean {
    if (this.fighters.size < MAX_RAGDOLLS) return true;
    const fallen = [...this.fighters.values()].filter((f) => f.state === 'out' || f.state === 'gone')
      .sort((a, b) => (this.outAt.get(a) ?? -Infinity) - (this.outAt.get(b) ?? -Infinity));
    for (const f of fallen) {
      this.let(f);
      if (this.fighters.size < MAX_RAGDOLLS) return true;
    }
    return false;
  }

  /** Takes a fighter into the ring loop (made just now, for its entrance). Throws past MAX_RAGDOLLS: call `makeRoom` first. */
  add(f: Fighter): void {
    if (this.fighters.get(f.id) === f) return;
    const old = this.fighters.get(f.id);
    if (old) this.let(old);
    if (this.fighters.size >= MAX_RAGDOLLS) throw new Error(`too many ragdolls in one world (${MAX_RAGDOLLS} at most)`);
    this.fighters.set(f.id, f);
  }

  /** Lets a fighter go now: its ragdoll leaves the world. */
  remove(id: string): void {
    const f = this.fighters.get(id);
    if (f) this.let(f);
  }

  /** Lets every fighter go (Clear the ring). */
  clear(): void {
    for (const f of [...this.fighters.values()]) this.let(f);
    this.champion = null;
    this.tally.clear();
    this.acc = 0;
  }

  /** Hits landed this round, by fighter id (fallen fighters' too), for `Match.crown`. */
  hits(): Map<string, number> {
    return new Map(this.tally);
  }

  /** A new round: nobody has landed anything yet. */
  resetHits(): void {
    this.tally.clear();
    for (const f of this.fighters.values()) f.hits = 0;
  }

  /** One frame of `realDt` s at real time `now` (s): the hits landed and the fighters ruled out, with the match's events. */
  step(realDt: number, now: number): { hits: Hit[]; outs: string[]; events: MatchEvent[] } {
    const hits: Hit[] = [], outs: string[] = [], events: MatchEvent[] = [];
    this.acc += Math.max(0, realDt) * this.slowmo.timeScale(now);
    let n = 0;
    while (this.acc >= DT - 1e-9 && n < MAX_STEPS) {
      this.physicsStep(now, hits, outs, events);
      this.acc -= DT;
      n++;
    }
    if (n === MAX_STEPS) this.acc = 0;
    this.dropFallen(now);
    return { hits, outs, events };
  }

  private emit(evs: MatchEvent[], into: MatchEvent[]): void {
    if (!evs.length) return;
    into.push(...evs);
    this.onEvents(evs);
  }

  private physicsStep(now: number, hits: Hit[], outs: string[], events: MatchEvent[]): void {
    this.emit(this.match.tick(DT), events);
    const ring = this.ring;
    ring.length = 0;
    for (const f of this.fighters.values()) if (f.state === 'fighting' || f.state === 'entering') ring.push(f);
    const frozen = this.freeze && this.match.frozen;
    let entering = false;
    for (const f of ring) {
      if (f.state === 'entering') entering = true;
      setFrozen([f], frozen && f.state === 'fighting' && f !== this.champion);
    }
    if (frozen && !entering) return; // nothing moves: the fight waits mid-flail
    this.entrance?.update(DT);
    const m = this.match;
    const fighting = ring.filter((f) => f.state === 'fighting');
    const alone = fighting.length === 1 && m.entering.length === 0 && m.onDeck.length === 0 && m.phase === 'open';
    let broken: Fighter[] | null = null;
    for (const f of ring) {
      if (frozen && f.state === 'fighting' && f !== this.champion) continue;
      const boast = f === this.champion || (alone && !this.champion && f.state === 'fighting');
      let landed: Hit[];
      try {
        landed = f.think(DT, this.sim, boast ? this.boastCtx : this.ctx);
      } catch (e) {
        console.error(`fighter ${f.id} failed to think: it leaves the ring`, e);
        (broken ??= []).push(f);
        continue;
      }
      for (const h of landed) {
        hits.push(h);
        this.tally.set(h.attacker.id, (this.tally.get(h.attacker.id) ?? 0) + 1);
      }
    }
    if (broken) this.dropBroken(broken, outs, events);
    this.world.step();
    this.sim += DT;
    const R = this.tune.ringRadius;
    const out: string[] = [];
    for (const f of ring) {
      if (f.state !== 'fighting' || !isOut(f.ragdoll.pos(), R)) continue;
      f.state = 'out';
      this.outAt.set(f, now);
      if (f === this.champion) this.champion = null;
      out.push(f.id);
    }
    if (out.length) {
      outs.push(...out);
      this.emit(this.match.ringOut(out), events);
    }
  }

  /**
   * Fighters whose brain threw: one bad creature must never stop the night. Each is ruled out (as if it fell) and let
   * go at once, so the world keeps stepping for everyone else.
   */
  private dropBroken(broken: Fighter[], outs: string[], events: MatchEvent[]): void {
    const out = broken.filter((f) => f.state === 'fighting').map((f) => f.id);
    for (const f of broken) if (f.state === 'fighting') f.state = 'out';
    if (out.length) {
      outs.push(...out);
      this.emit(this.match.ringOut(out), events);
    }
    for (const f of broken) this.let(f);
  }

  /** Fallen fighters 5 s after they went out, or once in the pit, leave the world. */
  private dropFallen(now: number): void {
    for (const f of this.fighters.values()) {
      if (f.state === 'gone') { this.let(f); continue; }
      if (f.state !== 'out') continue;
      const at = this.outAt.get(f) ?? now;
      if (now - at >= GONE_AFTER_S - 1e-9 || !(f.ragdoll.pos().y > GONE_BELOW_Y)) this.let(f);
    }
  }

  private let(f: Fighter): void {
    if (this.fighters.get(f.id) === f) this.fighters.delete(f.id);
    this.outAt.delete(f);
    if (this.champion === f) this.champion = null;
    const had = f.state !== 'gone' || f.ragdoll.pieces.length > 0;
    f.dispose();
    if (had) this.onGone(f);
  }
}
