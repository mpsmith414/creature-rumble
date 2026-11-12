import {
  ENTRANCE_S,
  GROUP_ENTRANCE_S,
  MAX_IN_RING,
  SHARE_WINDOW_S,
  type MatchEvent,
} from './rules';

export type { MatchEvent } from './rules';
export { ENTRANCE_S, GROUP_ENTRANCE_S, MAX_IN_RING, SHARE_WINDOW_S, isOut } from './rules';

const EPS = 1e-9;

/**
 * Who is fighting, entering and waiting. Pure logic: no physics, no rendering.
 * One entrance runs at a time; arrivals within SHARE_WINDOW_S of its start join it.
 */
export class Match {
  private readonly maxInRing: number;
  private readonly freeze: boolean;

  private _fighting: string[] = [];
  private _entering: string[] = [];
  private _waiting: string[] = [];
  private _phase: 'open' | 'crowned' = 'open';
  private cast: string[] = [];
  private champion: string | null = null;

  private entranceRunning = false;
  private entranceLeft = 0;
  private entranceElapsed = 0;
  private pending: MatchEvent[] = [];
  private loneSpent = false;

  constructor(o?: { maxInRing?: number; freeze?: boolean }) {
    this.maxInRing = o?.maxInRing ?? MAX_IN_RING;
    this.freeze = o?.freeze ?? true;
  }

  get fighting(): readonly string[] {
    return this._fighting;
  }
  get onDeck(): readonly string[] {
    return this._waiting;
  }
  get entering(): readonly string[] {
    return this._entering;
  }
  get phase(): 'open' | 'crowned' {
    return this._phase;
  }
  /** Everyone who fought this round, champion last once crowned. */
  get lastCast(): readonly string[] {
    if (this.champion === null) return this.cast;
    return [...this.cast.filter((id) => id !== this.champion), this.champion];
  }
  /** An entrance is running (or about to start on the next tick) while someone is fighting. */
  get frozen(): boolean {
    return this.freeze && this._fighting.length >= 1 && (this.entranceRunning || this.canStart());
  }

  private get room(): number {
    return this.maxInRing - this._fighting.length - this._entering.length;
  }

  private canStart(): boolean {
    return this._phase === 'open' && !this.entranceRunning && this._waiting.length > 0 && this.room > 0;
  }

  private known(id: string): boolean {
    return this._fighting.includes(id) || this._entering.includes(id) || this._waiting.includes(id);
  }

  arrive(ids: string[]): void {
    for (const id of ids) {
      if (this.known(id)) continue;
      const canJoin =
        this._phase === 'open' &&
        this.entranceRunning &&
        this.entranceElapsed <= SHARE_WINDOW_S &&
        this.room > 0 &&
        this._waiting.length === 0;
      if (!canJoin) {
        this._waiting.push(id);
        continue;
      }
      this._entering.push(id);
      this.entranceLeft = GROUP_ENTRANCE_S;
      // one announcement per tick, naming everyone now entering
      this.pending = this.pending.filter((e) => e.type !== 'entranceStart');
      this.pending.push({ type: 'entranceStart', ids: [...this._entering], group: true });
    }
  }

  private startEntrance(events: MatchEvent[]): boolean {
    if (!this.canStart()) return false;
    this._entering = this._waiting.splice(0, this.room);
    this.entranceRunning = true;
    this.entranceElapsed = 0;
    const group = this._entering.length > 1;
    this.entranceLeft = group ? GROUP_ENTRANCE_S : ENTRANCE_S;
    events.push({ type: 'entranceStart', ids: [...this._entering], group });
    return true;
  }

  tick(dt: number): MatchEvent[] {
    const events: MatchEvent[] = this.pending;
    this.pending = [];
    let rem = Math.max(0, dt);
    for (;;) {
      if (!this.entranceRunning && !this.startEntrance(events)) break;
      if (this.entranceLeft - rem <= EPS) {
        rem = Math.max(0, rem - this.entranceLeft);
        const ids = this._entering;
        this._entering = [];
        this.entranceRunning = false;
        this.entranceLeft = 0;
        this._fighting.push(...ids);
        for (const id of ids) if (!this.cast.includes(id)) this.cast.push(id);
        events.push({ type: 'entranceEnd', ids: [...ids] });
        continue;
      }
      this.entranceLeft -= rem;
      this.entranceElapsed += rem;
      break;
    }
    this.checkLone(events);
    return events;
  }

  private checkLone(events: MatchEvent[]): void {
    const f = this._fighting;
    if (f.length !== 1) this.loneSpent = false;
    if (
      f.length === 1 &&
      this._phase === 'open' &&
      this._entering.length === 0 &&
      this._waiting.length === 0 &&
      !this.loneSpent
    ) {
      this.loneSpent = true;
      events.push({ type: 'lone', id: f[0] });
    }
  }

  ringOut(ids: string[]): MatchEvent[] {
    const gone = this._fighting.filter((id) => ids.includes(id));
    if (gone.length === 0) return [];
    this._fighting = this._fighting.filter((id) => !gone.includes(id));
    if (this._fighting.length === 0) this.loneSpent = false;
    const events: MatchEvent[] = [{ type: 'ringOut', ids: gone }];
    if (this._phase !== 'open') return events;
    const nobodyNext = this._entering.length === 0 && this._waiting.length === 0;
    if (this._fighting.length === 0 && gone.length >= 2) {
      events.push({ type: 'tie', ids: gone });
    } else if (this._fighting.length === 1 && nobodyNext) {
      this.loneSpent = true; // holdsRing is the announcement for this spell
      events.push({ type: 'holdsRing', id: this._fighting[0] });
    }
    return events;
  }

  crown(hits: ReadonlyMap<string, number>): MatchEvent[] {
    if (this._fighting.length === 0) return [];
    let best = this._fighting[0];
    for (const id of this._fighting) {
      if ((hits.get(id) ?? 0) > (hits.get(best) ?? 0)) best = id;
    }
    // anyone mid-entrance goes back on deck, first in line
    if (this._entering.length > 0) {
      this._waiting.unshift(...this._entering);
      this._entering = [];
    }
    this.entranceRunning = false;
    this.entranceLeft = 0;
    this.pending = [];
    this._phase = 'crowned';
    this.champion = best;
    return [{ type: 'crowned', id: best, others: this.cast.filter((id) => id !== best) }];
  }

  again(): MatchEvent[] {
    if (this._phase !== 'crowned') return [];
    // the champion walks in last and always gets a place (spec §2.11): anyone past the ring's room waits on deck after it
    const champ = this.champion;
    const others = [...new Set([...this.cast, ...this._waiting])].filter((id) => id !== champ);
    const room = this.maxInRing - 1;
    const ids = champ === null ? others : [...others.slice(0, room), champ, ...others.slice(room)];
    this._phase = 'open';
    this.champion = null;
    this.cast = [];
    this._fighting = [];
    this._entering = [];
    this._waiting = ids;
    this.loneSpent = false;
    const events: MatchEvent[] = [{ type: 'again', ids: [...ids] }];
    this.startEntrance(events);
    return events;
  }

  reset(): void {
    this._fighting = [];
    this._entering = [];
    this._waiting = [];
    this._phase = 'open';
    this.cast = [];
    this.champion = null;
    this.entranceRunning = false;
    this.entranceLeft = 0;
    this.entranceElapsed = 0;
    this.pending = [];
    this.loneSpent = false;
  }
}
