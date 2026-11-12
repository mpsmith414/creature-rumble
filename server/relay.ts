import {
  CODE_LETTERS, EMPTY_RING, ringRoster, type DesignInput, type HostMsg, type HostSend, type Maker, type PhoneCommand, type PhoneMsg, type PhoneSnapshot, type Ring,
} from '../src/bring/protocol';
import type { KidCards } from '../src/designer/types';

export type Sink<M> = (msg: M) => void;
export type RelayOptions = {
  now: () => number; id: () => string; code?: string; quietMs?: number; awayMs?: number; maxTweaks?: number;
  /** Ring commands one phone may send per second (kids mash buttons); more are refused as `slow`. Default 5. */
  commandsPerSecond?: number;
};

type Phone = {
  token: string; maker: Maker; sink: Sink<PhoneMsg> | null; phase: PhoneSnapshot['phase'];
  input?: DesignInput; cards?: KidCards; tweaksUsed: number;
  /** The host was told `cancel` and has not answered yet; the stage stays taken until it does. */
  closing: boolean;
  /** Its stream got `noHost`, so it needs a fresh `hello` once a TV registers. */
  noHostSent: boolean;
  lastActivity: number;
  /** Quiet with no stream for `awayMs` while not in the line or on stage: the host was told `left` (the card counts
   * who is here). The phone keeps its token and its screen; anything it does brings it back with `joined`. */
  away: boolean;
  /** When its last few ring commands were taken (at most `commandsPerSecond`, oldest first), for the rate limit. */
  commandTimes: number[];
};

/** A phone away this many times `awayMs` is forgotten by `tick`. */
const FORGET_AWAY = 10;

/** Phases where a phone is not waiting for anything from the TV, so it may go away. */
const RESTING_PHASES: ReadonlySet<PhoneSnapshot['phase']> = new Set(['idle', 'released', 'kept', 'resting']);

/** Who is in the line and who is on the TV, with no I/O and no timers (the routes call `tick` every 10 s). A phone
 * counts as active at every request and whenever its stream opens or closes, so `tick` can find a quiet preview, and a
 * phone that has gone (a closed tab, a phone put away) when it is between creatures. */
export class Relay {
  readonly code: string;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly quietMs: number;
  private readonly awayMs: number;
  private readonly maxTweaks: number;
  private readonly commandsPerSecond: number;
  /** The last ring the host sent (capped), so a phone that connects later hears it after its hello. */
  private lastRing: Ring | null = null;
  private host: { id: string; sink: Sink<HostMsg> | null; url: string } | null = null;
  /** Ids of hosts that were replaced (the last few): a page that finds its own id here must not take hosting back by itself. */
  private readonly replacedIds: string[] = [];
  private readonly phones = new Map<string, Phone>();
  private line: string[] = [];
  private onStage: string | null = null;
  /** Kept apart from `phones` because a phone that leaves while on stage is gone before the host answers. */
  private stageMaker: Maker | null = null;
  /** The on-stage turn reached a host (false while no host stream was attached to hear it). */
  private turnSent = false;

  constructor(opts: RelayOptions) {
    this.now = opts.now;
    this.id = opts.id;
    this.quietMs = opts.quietMs ?? 120000;
    this.awayMs = opts.awayMs ?? 180000;
    this.maxTweaks = opts.maxTweaks ?? 5;
    this.commandsPerSecond = opts.commandsPerSecond ?? 5;
    this.code = opts.code ?? Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join('');
  }

  /** A TV page becomes the host; a previous host is sent `replaced` and dropped. Returns the host id. Its match is new,
   * so the last ring is forgotten until it sends its own, and phones that heard one are told the ring is empty for now
   * (no stale Crown or roster buttons). */
  registerHost(sink: Sink<HostMsg>, url: string): string {
    this.host?.sink?.({ type: 'replaced' });
    if (this.lastRing) for (const p of this.phones.values()) this.toPhone(p, { type: 'ring', ...EMPTY_RING });
    this.lastRing = null;
    if (this.host) this.replacedIds.push(this.host.id);
    if (this.replacedIds.length > 50) this.replacedIds.shift();
    this.host = { id: this.id(), sink, url };
    sink({ type: 'hello', code: this.code, url });
    this.hostAttached(true);
    return this.host.id;
  }

  /** What a host id is: the current host, one that a newer TV page replaced, or one this relay never knew (it restarted). */
  hostState(hostId: string): 'current' | 'replaced' | 'unknown' {
    if (this.host?.id === hostId) return 'current';
    return this.replacedIds.includes(hostId) ? 'replaced' : 'unknown';
  }

  /** Attach the host's SSE sink (replacing any earlier one); false if not the host. Sends `hello`. */
  hostStream(hostId: string, sink: Sink<HostMsg>): boolean {
    if (!this.host || this.host.id !== hostId) return false;
    this.host.sink = sink;
    sink({ type: 'hello', code: this.code, url: this.host.url });
    this.hostAttached(false);
    return true;
  }

  /** The stream that was attached with `sink` closed. A late close of an old stream must not detach a newer one,
   * so this only clears the host's sink while it is still that same sink. */
  detachHost(hostId: string, sink: Sink<HostMsg>): void {
    if (this.host?.id === hostId && this.host.sink === sink) this.host.sink = null;
  }

  /** A host is registered and listening. */
  hasHost(): boolean { return !!this.host?.sink; }

  join(code: string, maker: Maker, token?: string): { token: string } | { error: 'badCode' } {
    if (code.toUpperCase() !== this.code) return { error: 'badCode' };
    const known = token ? this.phones.get(token) : undefined;
    if (known) { this.touch(known); return { token: known.token }; }
    const phone: Phone = {
      token: this.id(), maker, sink: null, phase: 'idle', tweaksUsed: 0, closing: false, noHostSent: false, lastActivity: this.now(), away: false,
      commandTimes: [],
    };
    this.phones.set(phone.token, phone);
    this.toHost({ type: 'joined', token: phone.token, maker });
    return { token: phone.token };
  }

  /** Attach a phone's SSE sink (replacing any earlier one); false for an unknown token. Sends `hello` (and the last
   * ring, if the TV has sent one). */
  phoneStream(token: string, sink: Sink<PhoneMsg>): boolean {
    const p = this.phones.get(token);
    if (!p) return false;
    this.touch(p);
    p.sink = sink;
    sink({ type: 'hello', state: this.snapshotOf(p) });
    if (!this.hasHost()) { sink({ type: 'noHost' }); p.noHostSent = true; } else if (this.lastRing) sink({ type: 'ring', ...this.lastRing });
    return true;
  }

  /** The stream attached with `sink` closed. Only clears the phone's sink while it is still that same sink: a
   * phone that reconnects before the old half-open connection aborts must keep its new stream. */
  detachPhone(token: string, sink: Sink<PhoneMsg>): void {
    const p = this.phones.get(token);
    if (p && p.sink === sink) { p.sink = null; this.touch(p); }
  }

  submit(token: string, input: DesignInput, capFull: boolean): 'queued' | 'resting' | 'busy' | 'noHost' | 'unknown' {
    const p = this.phones.get(token);
    if (!p) return 'unknown';
    this.touch(p);
    if (!this.hasHost()) return 'noHost';
    // Still on stage counts as busy even when timed out (`kept`): the host has not answered yet.
    if (this.onStage === token || p.phase === 'waiting') return 'busy';
    if (capFull) {
      p.phase = 'resting';
      this.toPhone(p, { type: 'resting' });
      return 'resting';
    }
    p.input = input;
    p.phase = 'waiting';
    p.cards = undefined;
    p.tweaksUsed = 0;
    p.closing = false;
    this.line.push(token);
    if (this.onStage === null) this.pump();
    else { this.sendLine(p); this.toHost(this.lineMsg()); }
    return 'queued';
  }

  tweak(token: string, words: string): 'sent' | 'limit' | 'notOnStage' | 'unknown' {
    const p = this.phones.get(token);
    if (!p) return 'unknown';
    this.touch(p);
    if (!this.live(p)) return 'notOnStage';
    if (p.tweaksUsed >= this.maxTweaks) return 'limit';
    p.tweaksUsed++;
    this.toHost({ type: 'tweak', token, words });
    return 'sent';
  }

  release(token: string): 'sent' | 'notOnStage' | 'unknown' {
    const p = this.phones.get(token);
    if (!p) return 'unknown';
    this.touch(p);
    if (!this.live(p)) return 'notOnStage';
    this.toHost({ type: 'release', token });
    return 'sent';
  }

  /** Leave the line, or drop the creature on stage: the host gets `cancel` and decides (it answers `kept`/`failed`). */
  cancel(token: string): 'ok' | 'unknown' {
    const p = this.phones.get(token);
    if (!p) return 'unknown';
    this.touch(p);
    if (p.phase === 'waiting') {
      this.line = this.line.filter((t) => t !== token);
      p.phase = 'idle';
      this.broadcastLine();
    } else if (this.live(p)) {
      p.closing = true;
      this.toHost({ type: 'cancel', token });
    }
    return 'ok';
  }

  /**
   * A phone asks the ring for something (crown, again, send a roster creature back in). It goes to the host as it is;
   * the TV decides what it means right now. `slow` once this phone has sent `commandsPerSecond` in the last second.
   */
  command(token: string, command: PhoneCommand): 'sent' | 'slow' | 'noHost' | 'unknown' {
    const p = this.phones.get(token);
    if (!p) return 'unknown';
    this.touch(p);
    const now = this.now();
    p.commandTimes = p.commandTimes.filter((t) => now - t < 1000);
    if (p.commandTimes.length >= this.commandsPerSecond) return 'slow';
    if (!this.hasHost()) return 'noHost';
    p.commandTimes.push(now);
    this.toHost({ type: 'command', token, command });
    return 'sent';
  }

  /** The host's ring (on every match phase or roster change) goes to every phone, its roster capped by `ringRoster`.
   * False when `hostId` is not the host. */
  ring(hostId: string, ring: Ring): boolean {
    if (!this.host || this.host.id !== hostId) return false;
    this.lastRing = { phase: ring.phase, fighting: ring.fighting, roster: ringRoster(ring.roster) };
    for (const p of this.phones.values()) this.toPhone(p, { type: 'ring', ...this.lastRing });
    return true;
  }

  /** Forget the phone entirely (cancel first). */
  leave(token: string): void {
    const p = this.phones.get(token);
    if (!p) return;
    this.cancel(token);
    p.sink = null;
    this.phones.delete(token);
    this.toHost({ type: 'left', token });
  }

  /** The TV host reports on the phone on stage; `released`, `kept` and `failed` end the turn. A `ring` is for every
   * phone (see `ring`; its token is not needed). */
  fromHost(hostId: string, msg: HostSend & { token?: string }): boolean {
    if (msg.type === 'ring') return this.ring(hostId, msg);
    if (msg.token === undefined) return false;
    if (!this.host || this.host.id !== hostId || this.onStage !== msg.token) return false;
    const p = this.phones.get(msg.token);
    if (msg.type === 'step') {
      if (p && !p.closing) { p.phase = 'making'; this.toPhone(p, { type: 'step', step: msg.step }); }
    } else if (msg.type === 'preview' || msg.type === 'tweaked') {
      if (p && !p.closing) {
        p.phase = 'preview';
        p.cards = msg.cards;
        this.touch(p); // the quiet timeout runs from the moment the kid can see the card
        const tweaksLeft = this.maxTweaks - p.tweaksUsed;
        this.toPhone(p, msg.type === 'preview' ? { type: 'preview', cards: msg.cards, tweaksLeft } : { type: 'tweaked', cards: msg.cards, note: msg.note, tweaksLeft });
      }
    } else {
      if (p) {
        const told = p.phase === msg.type; // a timed-out phone already heard `kept`
        p.phase = msg.type === 'failed' ? 'idle' : msg.type;
        p.closing = false;
        if (!told) this.toPhone(p, msg.type === 'failed' ? { type: 'failed', message: msg.message, retry: msg.retry } : { type: msg.type });
      }
      this.endTurn();
    }
    return true;
  }

  /**
   * A preview nobody has touched for `quietMs`: the host gets `cancel` (it answers `kept`), the phone `kept`. A phone
   * between creatures with no stream for `awayMs` is away: the host hears `left`. One in the line or on stage never is
   * (a locked screen or a refresh keeps its place). One away for `FORGET_AWAY` times `awayMs` is forgotten, so the
   * relay does not keep every phone that ever joined (if it comes back, it simply joins again with a new token).
   */
  tick(): void {
    for (const q of [...this.phones.values()]) {
      if (q.away && this.now() - q.lastActivity > FORGET_AWAY * this.awayMs) this.phones.delete(q.token);
    }
    for (const q of this.phones.values()) {
      if (q.away || q.sink || !RESTING_PHASES.has(q.phase) || q.token === this.onStage || this.now() - q.lastActivity <= this.awayMs) continue;
      q.away = true;
      this.toHost({ type: 'left', token: q.token });
    }
    const p = this.onStage ? this.phones.get(this.onStage) : undefined;
    if (!p || p.phase !== 'preview' || p.closing || this.now() - p.lastActivity <= this.quietMs) return;
    p.closing = true;
    p.phase = 'kept';
    this.toHost({ type: 'cancel', token: p.token });
    this.toPhone(p, { type: 'kept' });
  }

  snapshot(token: string): PhoneSnapshot | null {
    const p = this.phones.get(token);
    return p ? this.snapshotOf(p) : null;
  }

  private snapshotOf(p: Phone): PhoneSnapshot {
    if (p.phase === 'waiting') return { phase: 'waiting', place: this.line.indexOf(p.token) + 1 };
    if (p.phase === 'preview') return { phase: 'preview', cards: p.cards, tweaksLeft: this.maxTweaks - p.tweaksUsed };
    return { phase: p.phase };
  }

  /** On the stage and not already being closed. */
  private live(p: Phone): boolean { return this.onStage === p.token && !p.closing; }

  /** The phone did something (or its stream opened or closed); one that was away is back. */
  private touch(p: Phone): void {
    p.lastActivity = this.now();
    if (!p.away) return;
    p.away = false;
    this.toHost({ type: 'joined', token: p.token, maker: p.maker });
  }

  private toHost(msg: HostMsg): void { this.host?.sink?.(msg); }
  private toPhone(p: Phone, msg: PhoneMsg): void { p.sink?.(msg); }

  private lineMsg(): HostMsg {
    return { type: 'line', line: this.line.map((t) => ({ token: t, maker: this.phones.get(t)!.maker })) };
  }

  /** A waiting phone's place (1 = next) and the makers ahead of it, the one on stage first. */
  private sendLine(p: Phone): void {
    const i = this.line.indexOf(p.token);
    const ahead = [...(this.stageMaker ? [this.stageMaker] : []), ...this.line.slice(0, i).map((t) => this.phones.get(t)!.maker)];
    this.toPhone(p, { type: 'line', place: i + 1, ahead });
  }

  private broadcastLine(): void {
    for (const t of this.line) this.sendLine(this.phones.get(t)!);
    this.toHost(this.lineMsg());
  }

  private endTurn(): void {
    this.onStage = null;
    this.stageMaker = null;
    this.turnSent = false;
    this.pump();
  }

  /** When the stage is free and someone waits, the first in line goes on stage. */
  private pump(): void {
    if (this.onStage !== null || !this.line.length || !this.hasHost()) return;
    const p = this.phones.get(this.line.shift()!)!;
    this.onStage = p.token;
    this.stageMaker = p.maker;
    p.phase = 'making';
    p.closing = false;
    this.touch(p);
    this.sendTurn(p);
    this.toPhone(p, { type: 'line', place: 0, ahead: [] });
    this.broadcastLine();
  }

  private sendTurn(p: Phone): void {
    this.toHost({ type: 'turn', token: p.token, maker: p.maker, input: p.input! });
    this.turnSent = true;
  }

  /** A host stream is live: wake phones that heard `noHost`, tell the host who is connected (it may have just
   * reloaded or lost its stream), resume the turn on stage, start the next. */
  private hostAttached(registered: boolean): void {
    for (const p of this.phones.values()) {
      if (!p.noHostSent) continue;
      p.noHostSent = false;
      this.toPhone(p, { type: 'hello', state: this.snapshotOf(p) });
      if (this.lastRing) this.toPhone(p, { type: 'ring', ...this.lastRing });
    }
    for (const p of this.phones.values()) if (!p.away) this.toHost({ type: 'joined', token: p.token, maker: p.maker });
    if (this.line.length) this.toHost(this.lineMsg());
    const p = this.onStage ? this.phones.get(this.onStage) : undefined;
    if (this.onStage !== null && (!p || p.closing) && !registered) {
      // the same host, back on a new stream: it may have missed the cancel, so it hears it again (it answers it)
      this.toHost({ type: 'cancel', token: this.onStage });
    } else if (this.onStage !== null && (!p || p.closing)) {
      // The host that was cancelling this one is gone, so nobody will answer: it is kept.
      if (p) { p.phase = 'kept'; p.closing = false; this.toPhone(p, { type: 'kept' }); }
      this.endTurn();
    } else if (p && (registered || !this.turnSent)) {
      this.sendTurn(p); // a reloaded TV makes it again from the start
    } else if (this.onStage === null) this.pump();
  }
}
