/**
 * The announcer's voice in the browser: lines are fetched from the home server (`POST /api/voice`), decoded ahead of time and
 * played through the page's Web Audio graph. A line speaks only if its audio is already decoded when it is wanted; otherwise
 * the caller shows words only. `out` is the mixer's voice bus, which runs through the arena chain (PA squash, reverb, slapback).
 * Without the server (a friend's static site) or without sound, every line is words only.
 */

/** How many decoded lines are kept (the least recently used go first). */
const KEEP = 64;
/** Milliseconds a request may take before it is abandoned. */
const TIMEOUT_MS = 8000;
/**
 * The announcer's voice and pace, sent with every request. These repeat ANNOUNCER_VOICE and ANNOUNCER_SPEED in server/voice.ts
 * (the owner's pick, by ear): that file imports Node's crypto and cannot be bundled for the browser. Change both together.
 */
export const VOICE = 'am_michael';
export const SPEED = 1.12;
/** While the server's model is still loading (503), a line is tried again after these waits (ms); then it is words only. */
export const LOADING_RETRY_MS = [2000, 4000, 8000, 16000] as const;
/** While the server has no voice (it may simply not be up yet), `check()` runs again after 2 s, then 4 s, doubling up to this cap. */
export const RECHECK_MAX_MS = 30000;

type Playing = { source: AudioBufferSourceNode; buffer: AudioBuffer; startedAt: number; offset: number; onEnd: () => void; paused: boolean };

export class VoiceClient {
  /** Whether the home server has a voice: unknown until `check()` has answered. */
  available: 'unknown' | 'yes' | 'no' = 'unknown';
  private readonly fetchFn: typeof fetch;
  private readonly ctx: BaseAudioContext | null;
  private readonly out: AudioNode | null;
  private readonly timeoutMs: number;
  private readonly ready = new Map<string, AudioBuffer>();
  private readonly pending = new Set<string>();
  private readonly retrying = new Set<string>();
  private current: Playing | null = null;
  private recheck: ReturnType<typeof setTimeout> | undefined;
  private rechecks = 0;

  constructor(o: { fetch: typeof fetch; ctx: BaseAudioContext | null; out: AudioNode | null; timeoutMs?: number }) {
    this.fetchFn = o.fetch;
    this.ctx = o.ctx;
    this.out = o.out;
    this.timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  }

  /** Ask the server whether it can speak: `yes` only on a 200 saying ok; any failure or a missing route is `no`. */
  async check(): Promise<void> {
    try {
      const r = await this.fetchFn('/api/voice');
      this.available = r.ok && (await r.json())?.ok === true ? 'yes' : 'no';
    } catch {
      this.available = 'no';
    }
    if (this.available === 'yes') this.rechecks = 0;
    else this.recheckLater();
  }

  /** The server may not be up yet: ask again after a growing wait (capped), until it answers. */
  private recheckLater(): void {
    if (this.recheck) return;
    const wait = Math.min(RECHECK_MAX_MS, 2000 * 2 ** this.rechecks++);
    this.recheck = setTimeout(() => {
      this.recheck = undefined;
      void this.check();
    }, wait);
  }

  /** Start fetching and decoding a line so it is ready when wanted. Never throws; a failure only means that line is words only. */
  prefetch(text: string, attempt = 0): void {
    if (!this.ctx || !this.out || this.available === 'no' || this.ready.has(text) || this.pending.has(text)) return;
    this.pending.add(text);
    this.load(text)
      .then((b) => {
        if (b === 'loading') return this.retryLater(text, attempt);
        if (!b) return;
        this.ready.set(text, b);
        if (this.ready.size > KEEP) this.ready.delete(this.ready.keys().next().value!);
      }, () => {})
      .finally(() => this.pending.delete(text));
  }

  /** Whether this line's audio is decoded and would speak now. */
  isReady(text: string): boolean {
    const b = this.ready.get(text);
    if (!b || !this.ctx || !this.out) return false;
    this.ready.delete(text); // asked about: about to be wanted, so keep it
    this.ready.set(text, b);
    return true;
  }

  /** The server is still loading its model: ask again after a growing wait (a few times), so the line may speak next time. */
  private retryLater(text: string, attempt: number): void {
    const wait = LOADING_RETRY_MS[attempt];
    if (wait === undefined || this.retrying.has(text)) return;
    this.retrying.add(text);
    setTimeout(() => {
      this.retrying.delete(text);
      this.prefetch(text, attempt + 1);
    }, wait);
  }

  private async load(text: string): Promise<AudioBuffer | 'loading' | null> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((res) => {
      timer = setTimeout(() => {
        abort.abort();
        res(null);
      }, this.timeoutMs);
    });
    const work = (async () => {
      const r = await this.fetchFn('/api/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, voice: VOICE, speed: SPEED }), signal: abort.signal });
      if (r.status === 503) return 'loading' as const;
      if (!r.ok) return null;
      return await this.ctx!.decodeAudioData(await r.arrayBuffer());
    })();
    work.catch(() => {}); // a late failure after the timeout is not news
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Speak a line if its audio is ready now (`onEnd` fires once when it ends or is stopped); else `spoken: false` and it never starts later. */
  play(text: string, onEnd: () => void): { spoken: boolean; seconds: number } {
    const buffer = this.ready.get(text);
    if (!buffer || !this.ctx || !this.out) return { spoken: false, seconds: 0 };
    this.ready.delete(text); // used just now: the newest
    this.ready.set(text, buffer);
    this.stop();
    let done = false;
    const once = () => {
      if (!done) {
        done = true;
        onEnd();
      }
    };
    this.current = { source: this.start(buffer, 0, once), buffer, startedAt: this.ctx.currentTime, offset: 0, onEnd: once, paused: false };
    return { spoken: true, seconds: buffer.duration };
  }

  private start(buffer: AudioBuffer, offset: number, onEnd: () => void): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = buffer;
    s.connect(this.out!);
    s.onended = () => {
      this.current = null;
      onEnd();
    };
    s.start(0, offset);
    return s;
  }

  private silence(c: Playing): void {
    c.source.onended = null;
    try {
      c.source.stop();
    } catch {
      /* already ended */
    }
    c.source.disconnect();
  }

  /** End the current line now (its `onEnd` fires). */
  stop(): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    if (!c.paused) this.silence(c);
    c.onEnd();
  }

  /** Hold the current line where it is (`true`) or carry on from there (`false`). */
  pause(on: boolean): void {
    const c = this.current;
    if (!c || !this.ctx || c.paused === on) return;
    if (on) {
      c.offset = Math.min(c.buffer.duration, c.offset + this.ctx.currentTime - c.startedAt);
      this.silence(c);
    } else {
      c.source = this.start(c.buffer, c.offset, c.onEnd);
      c.startedAt = this.ctx.currentTime;
    }
    c.paused = on;
  }
}
