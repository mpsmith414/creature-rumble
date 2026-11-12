import type { DesignInput, Maker, PhoneCommand, PhoneMsg } from '../bring/protocol';

/** The phone's side of the relay: join or rejoin, one event stream that reconnects, and the POSTs (spec §4). */

export type PhoneClient = {
  /** 'badCode' when the TV does not know the code. Rejects only when the server cannot be reached. */
  join(code: string, maker: Maker): Promise<'ok' | 'badCode'>;
  /** The four actions answer with the relay's result word ('queued', 'sent', 'busy', ...), or 'offline' / 'unknown'. */
  submit(i: DesignInput): Promise<string>;
  tweak(words: string): Promise<string>;
  release(): Promise<string>;
  cancel(): Promise<string>;
  /** Ask the ring for something (crown, again, send a fighter back in): 'sent', 'noHost', 'slow' (too many at once),
   * 'offline' or 'unknown' (the TV does not know this phone: it asks for a rescan). */
  command(c: PhoneCommand): Promise<string>;
  /** Rejoin now and reopen the stream: after a screen lock the old stream can be dead without ever erroring. */
  reconnect(): void;
  close(): void;
};

type Session = { token: string; code: string; maker: Maker };
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const KEY = 'valley-phone';
const FIRST_WAIT = 1000;
const MAX_WAIT = 8000;

/** What the phone remembered from its last join (so a refreshed page knows its maker before the stream says hello). */
export function storedSession(store: Store): Session | null {
  try {
    const s = JSON.parse(store.getItem(KEY) ?? 'null') as Session | null;
    return s && typeof s.token === 'string' && typeof s.code === 'string' && s.maker && typeof s.maker.name === 'string' ? s : null;
  } catch { return null; }
}

/** Joins (or rejoins with the stored token), keeps one EventSource open with reconnect, and reports every PhoneMsg. */
export function connect(
  store: Store, onMsg: (m: PhoneMsg) => void, onRescan: () => void,
  fetchFn: typeof fetch = (...a) => fetch(...a), ES: typeof EventSource = EventSource,
): PhoneClient {
  let session = storedSession(store);
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wait = FIRST_WAIT;
  let closed = false;

  const post = (url: string, body?: unknown) =>
    fetchFn(url, { method: 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const stopStream = () => { es?.close(); es = null; };

  /** The TV no longer knows this phone (new code, restarted server): forget it and show "Scan the TV again". */
  function forget() {
    if (timer) clearTimeout(timer);
    timer = null;
    stopStream();
    session = null;
    store.removeItem(KEY);
    onRescan();
  }

  function open() {
    stopStream();
    if (closed || !session) return;
    const stream = new ES(`/api/relay/phone/events?t=${encodeURIComponent(session.token)}`);
    es = stream;
    stream.onopen = () => { wait = FIRST_WAIT; };
    stream.onmessage = (e) => {
      wait = FIRST_WAIT;
      try { onMsg(JSON.parse(e.data) as PhoneMsg); } catch { /* a garbled message is not worth a crash */ }
    };
    // not the browser's own retry: a dead token gives no status, so rejoin first and find out
    stream.onerror = () => { stopStream(); retryLater(); };
  }

  function retryLater() {
    if (closed || timer) return;
    const delay = wait;
    wait = Math.min(wait * 2, MAX_WAIT);
    timer = setTimeout(() => { timer = null; void rejoin(); }, delay);
  }

  /** Tell the relay we are back (it keeps our place and our creature), then open the stream. */
  async function rejoin() {
    if (closed || !session) return;
    const { token, code, maker } = session;
    let res: Response;
    try { res = await post('/api/relay/join', { code, name: maker.name, badge: maker.badge, token }); } catch { retryLater(); return; }
    if (closed) return;
    if (res.status === 404) return forget();
    if (!res.ok) return retryLater();
    const back = (await res.json().catch(() => null)) as { token?: string } | null;
    if (back?.token && back.token !== token) {
      session = { token: back.token, code, maker };
      store.setItem(KEY, JSON.stringify(session));
    }
    open();
  }

  async function act(name: string, body?: unknown): Promise<string> {
    if (!session) return 'unknown';
    let res: Response;
    try { res = await post(`/api/relay/phone/${name}?t=${encodeURIComponent(session.token)}`, body); } catch { return 'offline'; }
    if (res.status === 404) { forget(); return 'unknown'; }
    const out = (await res.json().catch(() => null)) as { result?: string } | null;
    return out?.result ?? 'error';
  }

  async function command(c: PhoneCommand): Promise<string> {
    if (!session) return 'unknown';
    let res: Response;
    try { res = await post('/api/phone/command', { token: session.token, command: c }); } catch { return 'offline'; }
    if (res.status === 401) { forget(); return 'unknown'; }
    if (res.status === 429) return 'slow';
    const out = (await res.json().catch(() => null)) as { result?: string } | null;
    return out?.result ?? 'error';
  }

  if (session) void rejoin();

  return {
    async join(code, maker) {
      const upper = code.trim().toUpperCase();
      const res = await post('/api/relay/join', { code: upper, name: maker.name, badge: maker.badge });
      const out = res.ok ? ((await res.json().catch(() => null)) as { token?: string } | null) : null;
      if (!out?.token) return 'badCode';
      session = { token: out.token, code: upper, maker };
      store.setItem(KEY, JSON.stringify(session));
      closed = false;
      wait = FIRST_WAIT;
      if (timer) clearTimeout(timer);
      timer = null;
      open();
      return 'ok';
    },
    submit: (i) => act('submit', i),
    tweak: (words) => act('tweak', { words }),
    release: () => act('release'),
    cancel: () => act('cancel'),
    command,
    reconnect() {
      if (closed || !session) return;
      if (timer) clearTimeout(timer);
      timer = null;
      wait = FIRST_WAIT;
      stopStream();
      void rejoin();
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      stopStream();
    },
  };
}
