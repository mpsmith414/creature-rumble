import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import QRCode from 'qrcode';
import { z } from 'zod';
import { BADGES, DesignInputSchema, HostSendSchema, PhoneCommandSchema, type HostMsg } from '../src/bring/protocol';
import type { DailyCap } from './cap';
import { phoneUrl } from './net';
import type { Relay, Sink } from './relay';

const HostBody = z.object({ port: z.number().int().min(1).max(65535) });
const JoinBody = z.object({ code: z.string().max(16), name: z.string().max(200), badge: z.string().max(16), token: z.string().max(100).optional() });
const TweakBody = z.object({ words: z.string().max(500) });
/** A stage message needs the token of the phone on stage; a ring is for every phone and needs none. */
const HostSendBody = HostSendSchema.and(z.object({ token: z.string().optional() }));
/** A phone's ring command: its token and a strictly shaped command (unknown kinds and long ids are refused). */
const CommandBody = z.object({ token: z.string().min(1).max(100), command: PhoneCommandSchema });

const body = (c: Context) => c.req.json().catch(() => null);

/** Messages for a host that has registered but not yet opened its event stream; they are flushed once it does. */
type Pending = { id: string; msgs: HostMsg[] };

/**
 * The phone relay's HTTP face: JSON posts in, Server-Sent Events out. `attach` hands the relay a sink and says whether
 * the stream is wanted (false → 404); anything sent before the response is open waits in a queue, so nothing is lost.
 * A `: ping` comment every `heartbeatMs` keeps Wi-Fi and proxies from closing an idle stream.
 */
function sse<M>(c: Context, heartbeatMs: number, attach: (sink: Sink<M>) => boolean, detach: (sink: Sink<M>) => void, notFound: () => Response, onOpen?: () => void) {
  const queue: M[] = [];
  let write: ((m: M) => void) | null = null;
  const sink: Sink<M> = (m) => (write ? write(m) : queue.push(m));
  if (!attach(sink)) return notFound();
  return streamSSE(c, async (stream) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
    write = (m) => { void stream.writeSSE({ data: JSON.stringify(m) }).catch(() => undefined); };
    for (const m of queue.splice(0)) write(m);
    onOpen?.();
    timer = setInterval(() => { void stream.write(': ping\n\n').catch(() => undefined); }, heartbeatMs);
    try { await closed; } finally {
      clearInterval(timer);
      write = () => undefined;
      detach(sink);
    }
  });
}

/** Mount the relay's routes (spec §4). `host()` is the address phones can reach this PC at. */
export function relayRoutes(app: Hono, relay: Relay, cap: DailyCap, opts: { host: () => string; heartbeatMs?: number }): void {
  const heartbeatMs = opts.heartbeatMs ?? 15000;
  let pending: Pending | null = null;
  const bad = (c: Context) => c.json({ error: 'bad request' }, 400);
  const unknown = (c: Context) => c.json({ error: 'unknown' }, 404);

  app.post('/api/relay/host', async (c) => {
    const req = HostBody.safeParse(await body(c));
    if (!req.success) return bad(c);
    const url = phoneUrl(opts.host(), req.data.port, relay.code);
    const msgs: HostMsg[] = [];
    const hostId = relay.registerHost((m) => msgs.push(m), url);
    pending = { id: hostId, msgs };
    const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1 });
    return c.json({ hostId, code: relay.code, url, qrSvg });
  });

  app.get('/api/relay/host/events', (c) => {
    const h = c.req.query('h') ?? '';
    // the registering sink is replaced by the stream; what it heard in between (a turn, say) goes out first
    // (the stream announces `hello`, the phones and the line itself, so those are not repeated)
    const heard = pending?.id === h ? pending.msgs.splice(0).filter((m) => m.type !== 'hello' && m.type !== 'joined' && m.type !== 'line') : [];
    if (pending?.id === h) pending = null;
    return sse<HostMsg>(c, heartbeatMs, (sink) => {
      if (!relay.hostStream(h, sink)) return false;
      for (const m of heard) sink(m);
      return true;
    }, (sink) => relay.detachHost(h, sink), () => c.json({ error: relay.hostState(h) === 'replaced' ? 'replaced' : 'unknown' }, 404));
  });

  /** Is this host id still the host? ('replaced': a newer TV page took over; 'unknown': the relay restarted.) */
  app.get('/api/relay/host/status', (c) => c.json({ state: relay.hostState(c.req.query('h') ?? '') }));

  app.post('/api/relay/host/send', async (c) => {
    const req = HostSendBody.safeParse(await body(c));
    if (!req.success || (req.data.type !== 'ring' && req.data.token === undefined)) return bad(c);
    return relay.fromHost(c.req.query('h') ?? '', req.data) ? c.json({ ok: true }) : c.json({ error: 'unknown' }, 404);
  });

  app.post('/api/relay/join', async (c) => {
    const req = JoinBody.safeParse(await body(c));
    if (!req.success) return bad(c);
    const { code, name, badge, token } = req.data;
    const maker = { name: [...name.trim()].slice(0, 12).join(''), badge: (BADGES as readonly string[]).includes(badge) ? badge : BADGES[0] };
    const r = relay.join(code, maker, token);
    return 'error' in r ? c.json({ error: 'badCode' }, 404) : c.json({ token: r.token });
  });

  app.get('/api/relay/phone/events', (c) => {
    const t = c.req.query('t') ?? '';
    return sse(c, heartbeatMs, (sink) => relay.phoneStream(t, sink), (sink) => relay.detachPhone(t, sink), () => c.json({ error: 'unknown' }, 404));
  });

  /** A phone's action: parse (if it has a body), run it on the relay, and say what happened. */
  const phone = <B>(name: string, parse: (raw: unknown) => B | null, run: (t: string, b: B) => string) =>
    app.post(`/api/relay/phone/${name}`, async (c) => {
      const b = parse(await body(c));
      if (b === null) return bad(c);
      const result = run(c.req.query('t') ?? '', b);
      return result === 'unknown' ? unknown(c) : c.json({ result });
    });
  const noBody = () => ({});
  phone('submit', (raw) => { const r = DesignInputSchema.safeParse(raw); return r.success ? r.data : null; }, (t, input) => relay.submit(t, input, cap.full()));
  phone('tweak', (raw) => { const r = TweakBody.safeParse(raw); return r.success ? r.data : null; }, (t, b) => relay.tweak(t, b.words));
  phone('release', noBody, (t) => relay.release(t));
  phone('cancel', noBody, (t) => relay.cancel(t));
  phone('leave', noBody, (t) => {
    if (!relay.snapshot(t)) return 'unknown';
    relay.leave(t);
    return 'ok';
  });

  /**
   * A phone asks the ring for something: crown the champion, again, or send a roster creature back in. Only a phone the
   * relay knows may (401 otherwise), a few times a second at most (429). What it does is the TV's call.
   */
  app.post('/api/phone/command', async (c) => {
    const req = CommandBody.safeParse(await body(c));
    if (!req.success) return bad(c);
    const result = relay.command(req.data.token, req.data.command);
    if (result === 'unknown') return c.json({ error: 'unknown' }, 401);
    if (result === 'slow') return c.json({ error: 'slow' }, 429);
    return c.json({ result });
  });
}
