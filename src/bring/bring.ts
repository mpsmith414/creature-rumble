import { cardWanted, type CardMode, type JoinCard } from './card';
import { HostClient, type HostEvents, type HostInfo } from './host';
import type { HostMsg, HostSend, Maker, PhoneCommand, RingEntry, RingPhase } from './protocol';

/** What the bring-it-to-life wiring needs of the card and of the host client (so tests can fake them). */
export type CardView = Pick<JoinCard, 'show' | 'line' | 'hide' | 'visible'>;
type Client = Pick<HostClient, 'start' | 'stop' | 'send' | 'reclaim' | 'sendRing' | 'onCommand'>;
type Person = { token: string; maker: Maker };
type HostStatus = Parameters<HostEvents['onStatus']>[0];

/**
 * The TV's side of "bring it to life": hosts the phones, keeps the join card up to date and hands the relay's
 * messages (`turn`, `tweak`, `release`, `cancel` ...) to whoever listens with `on`. The workshop hooks in there (see
 * `connectWorkshop`), answers the phone with `send`, and calls `setMaking(false)` when the creature on the stage is done with.
 * The ring hooks in with `onCommand` (a phone's crown, again or send-back) and `sendRing` (the match phase and roster,
 * to every phone). While the stage or an arrival has the screen (`setStage`, Ruling R21) the card steps aside, whatever
 * its mode.
 */
export function createBring(card: CardView, makeClient: (ev: HostEvents) => Client = (ev) => new HostClient(ev)) {
  const phones = new Map<string, Maker>(); // everyone connected, in the order they came
  let info: HostInfo | null = null, line: Person[] = [];
  let mode: CardMode = 'auto', making = false, replaced = false, stage = false;
  const listeners = new Set<(m: HostMsg) => void>();
  const statusListeners = new Set<(s: HostStatus, fresh?: boolean) => void>();

  const wanted = () => cardWanted({ mode, phones: phones.size, making });
  /** What the menu marks: the card is showing (or about to, or will once the stage is clear), and this page is the host. */
  const shown = () => wanted() && !replaced;
  /** Show or hide the card, and tell it who is here (the line first, then the others). */
  const refresh = () => {
    const inLine = new Set(line.map((p) => p.token));
    card.line([...line, ...[...phones].filter(([t]) => !inLine.has(t)).map(([token, maker]) => ({ token, maker }))]);
    if (info && wanted() && !stage) card.show(info);
    else card.hide();
  };

  const client = makeClient({
    onMsg(m) {
      if (m.type === 'joined') phones.set(m.token, m.maker);
      else if (m.type === 'left') {
        phones.delete(m.token);
        line = line.filter((p) => p.token !== m.token);
      } else if (m.type === 'line') {
        line = m.line;
        for (const p of m.line) phones.set(p.token, p.maker); // a fresh host learns of them here
      } else if (m.type === 'turn') making = true;
      refresh();
      for (const fn of [...listeners]) fn(m);
    },
    onStatus(s, i, fresh) {
      if (s === 'hosting') {
        info = i ?? null;
        replaced = false;
      } else {
        replaced = s === 'replaced';
        info = null; // no stale address while the relay is away, and none at all once another page hosts
        phones.clear();
        line = [];
        making = false;
      }
      refresh();
      for (const fn of [...statusListeners]) fn(s, fresh);
    },
  });

  return {
    /** Register with the relay and open the stream (the TV is up; this never delays it). */
    start: () => client.start(),
    stop: () => client.stop(),
    send: (token: string, msg: HostSend) => client.send(token, msg),
    /** Tell every phone the match phase, how many are fighting and the roster (on every phase or roster change). */
    sendRing: (phase: RingPhase, fighting: number, roster: readonly RingEntry[]) => client.sendRing(phase, fighting, roster),
    /** Hear the phones' ring commands with the sending phone's token; returns the way to stop. */
    onCommand: (fn: (token: string, command: PhoneCommand) => void) => client.onCommand(fn),
    /** Hear every message from the relay; returns the way to stop. */
    on(fn: (m: HostMsg) => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    /** Hear the relay connection's state: `hosting` (also after a drop: `fresh` is true for a new registration, when a
     * restarted relay knows nothing of the phone on stage, false for a reattach), `reconnecting` (which clears "making"),
     * `replaced`. Returns the way to stop. */
    onStatus(fn: (s: HostStatus, fresh?: boolean) => void) {
      statusListeners.add(fn);
      return () => void statusListeners.delete(fn);
    },
    /** Is the card on (showing, or due to once the relay answers or the stage clears)? What the menu's "Add a creature" marks. */
    get cardShown() {
      return shown();
    },
    get mode() {
      return mode;
    },
    /**
     * The menu's "Add a creature": a card that is showing goes off (even with phones connected), a hidden one goes on
     * (even with nobody there) and stays until toggled off. On a page that a newer TV page replaced it also takes
     * hosting back. Returns whether the card is now shown.
     */
    toggle() {
      mode = shown() ? 'off' : 'on';
      if (replaced && mode === 'on') {
        replaced = false;
        void client.reclaim();
      }
      refresh();
      return shown();
    },
    /** The workshop: a creature is (or is no longer) being made, which keeps the card up. A `turn` sets it. */
    setMaking(b: boolean) {
      making = b;
      refresh();
    },
    /** The workshop or an arrival has the screen (Ruling R21): the card hides meanwhile, and comes back after if it is on. */
    setStage(on: boolean) {
      if (on === stage) return;
      stage = on;
      refresh();
    },
  };
}
export type Bring = ReturnType<typeof createBring>;
