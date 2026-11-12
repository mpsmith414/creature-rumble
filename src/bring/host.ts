import { ringEntry, ringRoster, type HostMsg, type HostSend, type PhoneCommand, type RingEntry, type RingPhase, type RingSend } from './protocol';

/**
 * The TV's side of the phone relay: register as the host, keep the event stream open, answer the phone on stage, hear
 * the phones' ring commands (`onCommand`) and tell every phone how the ring stands (`sendRing`). When the stream drops it
 * first asks the relay (`GET /api/relay/host/status`, since an EventSource cannot see a 404) whether its own host id
 * still stands: `current` reattaches with the same id (nobody is told anything), `unknown` (the server restarted)
 * registers afresh (and sends the last ring again), and `replaced` (a newer TV page took over) stops for good: a
 * replaced page only hosts again when asked to with `reclaim()`.
 */

export type HostInfo = { code: string; url: string; qrSvg: string };
export type HostEvents = {
  onMsg(m: HostMsg): void;
  /** `fresh` (with `hosting`): true for a new registration (the first, or after the relay restarted and forgot every
   * phone), false when the stream reattached to the same relay (which still knows the phone on stage). */
  onStatus(s: 'hosting' | 'reconnecting' | 'replaced', info?: HostInfo, fresh?: boolean): void;
};
type Deps = { fetch?: typeof fetch; EventSource?: typeof EventSource; port?: number; sleep?: (ms: number) => Promise<void> };

const FIRST_WAIT = 1000;
const MAX_WAIT = 30000;
const JSON_POST = { method: 'POST', headers: { 'content-type': 'application/json' } };

export class HostClient {
  /** The id of the open stream (null while it is down, so nothing is sent into a dead one). */
  private hostId: string | null = null;
  /** The id this page last registered or reattached with, and what the relay told us about it. */
  private lastId: string | null = null;
  private info: HostInfo | null = null;
  private es: EventSource | null = null;
  private stopped = false;
  private wait = FIRST_WAIT;
  /** Counts connection attempts: a stream or a sleep from an earlier attempt must not act. */
  private attempt = 0;
  private readonly commandListeners = new Set<(token: string, command: PhoneCommand) => void>();
  /** The last ring sent, sent again after a fresh registration (a new relay knows no ring). */
  private lastRing: RingSend | null = null;

  constructor(private readonly ev: HostEvents, private readonly deps: Deps = {}) {}

  /** Register and open the stream. Resolves once the first attempt has been made; if it fails, retrying carries on behind. */
  start(): Promise<void> {
    return this.connect();
  }

  /** Answer the phone on stage (the relay adds what it knows). False when the relay did not take it. */
  async send(token: string, msg: HostSend): Promise<boolean> {
    if (!this.hostId) return false;
    try {
      const res = await this.fetch(`/api/relay/host/send?h=${encodeURIComponent(this.hostId)}`, { ...JSON_POST, body: JSON.stringify({ token, ...msg }) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Tell every phone how the ring stands: the match phase, how many are fighting, and the roster to send back in (the
   * roster's newest-first summaries; at most 60 go, champions first). Call it on every match phase change and roster
   * change. Each entry is checked first: a bad thumb is dropped, an entry that cannot be sent is left out, so one bad
   * entry does not get the whole ring refused. False when the relay did not take it (it is still sent again after the
   * next fresh registration).
   */
  async sendRing(phase: RingPhase, fighting: number, roster: readonly RingEntry[]): Promise<boolean> {
    const fit = roster.map(ringEntry).filter((e): e is RingEntry => e !== null);
    this.lastRing = { type: 'ring', phase, fighting: Math.max(0, Math.floor(fighting)), roster: ringRoster(fit) };
    return this.postRing(this.lastRing);
  }

  /** Hear the phones' ring commands (crown, again, sendBack) with the token of the phone that sent it. They do not go to
   * `onMsg`. Returns the way to stop. */
  onCommand(fn: (token: string, command: PhoneCommand) => void): () => void {
    this.commandListeners.add(fn);
    return () => void this.commandListeners.delete(fn);
  }

  private async postRing(ring: RingSend): Promise<boolean> {
    if (!this.hostId) return false;
    try {
      const res = await this.fetch(`/api/relay/host/send?h=${encodeURIComponent(this.hostId)}`, { ...JSON_POST, body: JSON.stringify(ring) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** A replaced page takes hosting back: register afresh (the explicit "Add a creature" in the menu). */
  reclaim(): Promise<void> {
    this.stopped = false;
    this.wait = FIRST_WAIT;
    this.lastId = null;
    return this.connect();
  }

  /** Stop for good: the stream closes and nothing registers again (a newer TV page took over, or the page is going). */
  stop(): void {
    this.stopped = true;
    this.attempt++;
    this.es?.close();
    this.es = null;
    this.hostId = null;
    this.lastId = null;
  }

  private fetch(url: string, init: RequestInit) {
    return (this.deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)))(url, init);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const mine = ++this.attempt;
    this.es?.close();
    this.es = null;
    let info: HostInfo & { hostId: string };
    try {
      const res = await this.fetch('/api/relay/host', { ...JSON_POST, body: JSON.stringify({ port: this.deps.port ?? (Number(location.port) || 80) }) });
      if (!res.ok) throw new Error(`register ${res.status}`);
      info = (await res.json()) as HostInfo & { hostId: string };
    } catch {
      return void this.retry(mine);
    }
    if (mine !== this.attempt) return;
    this.info = { code: info.code, url: info.url, qrSvg: info.qrSvg };
    this.ev.onStatus('hosting', this.info, true);
    this.open(info.hostId, mine); // straight away: the relay holds the host's messages only until its stream attaches
    if (this.lastRing) void this.postRing(this.lastRing); // a new relay knows no ring: the phones hear the last one again
  }

  /** Open the event stream for a host id. */
  private open(id: string, mine: number): void {
    this.hostId = this.lastId = id;
    const stream = new (this.deps.EventSource ?? EventSource)(`/api/relay/host/events?h=${encodeURIComponent(id)}`);
    this.es = stream;
    stream.onmessage = (e) => {
      if (mine !== this.attempt) return;
      this.wait = FIRST_WAIT; // the stream works
      let m: HostMsg;
      try { m = JSON.parse(e.data) as HostMsg; } catch { return; } // a garbled message is not worth a crash
      if (m.type === 'replaced') {
        this.stop(); // a newer TV page hosts now: this one stays quiet
        this.ev.onStatus('replaced');
      } else if (m.type === 'command') {
        for (const fn of [...this.commandListeners]) fn(m.token, m.command);
      } else this.ev.onMsg(m);
    };
    // not the browser's own retry: ask the relay what became of our host id first (see `check`)
    stream.onerror = () => {
      if (mine !== this.attempt) return;
      stream.close();
      this.es = null;
      this.hostId = null;
      void this.retry(mine);
    };
  }

  /** Wait 1, 2, 4 ... up to 30 s, then find out whether we are still the host (or register, if we have no id). */
  private async retry(mine: number): Promise<void> {
    if (this.stopped || mine !== this.attempt) return;
    this.ev.onStatus('reconnecting');
    const delay = this.wait;
    this.wait = Math.min(this.wait * 2, MAX_WAIT);
    await (this.deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(delay);
    if (this.stopped || mine !== this.attempt) return;
    if (this.lastId) void this.check(mine, this.lastId);
    else void this.connect();
  }

  /** After a drop: our id is `current` (reattach), `unknown` (the relay restarted: register again) or `replaced` (stay quiet). */
  private async check(mine: number, id: string): Promise<void> {
    let state: string | null = null;
    try {
      const res = await this.fetch(`/api/relay/host/status?h=${encodeURIComponent(id)}`, { method: 'GET' });
      if (res.ok) state = ((await res.json()) as { state?: string }).state ?? null;
    } catch { /* the relay is not there: try again */ }
    if (this.stopped || mine !== this.attempt) return;
    if (state === 'current' && this.info) {
      this.attempt++;
      this.ev.onStatus('hosting', this.info, false);
      this.open(id, this.attempt);
    } else if (state === 'replaced') {
      this.stop();
      this.ev.onStatus('replaced');
    } else if (state === 'unknown') {
      this.lastId = null;
      void this.connect();
    } else void this.retry(mine);
  }
}

/** Today's count and the daily limit (`GET /api/cap`), or null when the server cannot say. */
export type CapNow = { count: number; limit: number };
export async function getCap(fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<CapNow | null> {
  try {
    const res = await fetchFn('/api/cap');
    return res.ok ? ((await res.json()) as CapNow) : null;
  } catch {
    return null;
  }
}
/** Choose the daily limit (`POST /api/cap`); the answer is the new state, or null when it was not taken. */
export async function setCap(limit: number, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<CapNow | null> {
  try {
    const res = await fetchFn('/api/cap', { ...JSON_POST, body: JSON.stringify({ limit }) });
    return res.ok ? ((await res.json()) as CapNow) : null;
  } catch {
    return null;
  }
}
