/** Controller first, keyboard and mouse too: one stream of orbit/zoom/button events. */

export const BUTTONS = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'start', 'select', 'up', 'down', 'left', 'right'] as const;
export type Button = (typeof BUTTONS)[number];
export type PadState = { lx: number; ly: number; rx: number; ry: number } & Record<Button, boolean>;

const DEADZONE = 0.15;
const dz = (v: number) => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));

export const EMPTY_PAD: PadState = { lx: 0, ly: 0, rx: 0, ry: 0, ...(Object.fromEntries(BUTTONS.map((b) => [b, false])) as Record<Button, boolean>) };

/** Read a standard-mapping gamepad (Xbox / PlayStation layout) into a tidy state. */
export function readPad(gp: { axes: readonly number[]; buttons: readonly { pressed: boolean }[] } | null): PadState {
  if (!gp) return { ...EMPTY_PAD };
  const b = (i: number) => !!gp.buttons[i]?.pressed;
  return {
    lx: dz(gp.axes[0] ?? 0), ly: dz(gp.axes[1] ?? 0), rx: dz(gp.axes[2] ?? 0), ry: dz(gp.axes[3] ?? 0),
    a: b(0), b: b(1), x: b(2), y: b(3), lb: b(4), rb: b(5), lt: b(6), rt: b(7),
    select: b(8), start: b(9), up: b(12), down: b(13), left: b(14), right: b(15),
  };
}

/** Buttons that went down between two states. */
export function edges(prev: PadState, next: PadState): Button[] {
  return BUTTONS.filter((k) => next[k] && !prev[k]);
}

const KEYS: Record<string, Button> = {
  Enter: 'a', ' ': 'a', Escape: 'b', Backspace: 'b', x: 'x', X: 'x', y: 'y', Y: 'y', '[': 'lb', ']': 'rb', n: 'start', N: 'start',
  '`': 'select', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};

/**
 * Polls the first gamepad every frame and listens to the keyboard.
 * Emits presses (repeating d-pad/stick moves for menus) and continuous orbit/zoom.
 */
export class Input {
  private prev: PadState = { ...EMPTY_PAD };
  private keys = new Set<string>();
  private last: PadState = { ...EMPTY_PAD };
  private mx = 0;
  private my = 0;
  private repeatAt = 0;
  /** `repeat` is true for a held key's auto-repeat (keyboard only). */
  onPress: (b: Button, repeat?: boolean) => void = () => {};
  /** Set by the gamepad hook in dev checks to stand in for a real controller. */
  padStub: PadState | null = null;
  /** Which the player used last: the controller (a button or a stick) or the keyboard (a key), for hints that name a button. */
  using: 'pad' | 'keys' = 'keys';

  constructor(target: EventTarget = window) {
    target.addEventListener('keydown', (ev) => {
      const e = ev as KeyboardEvent;
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (typing && e.key !== 'Escape') return;
      this.keys.add(e.key.toLowerCase());
      this.using = 'keys';
      const b = KEYS[e.key];
      if (b) {
        e.preventDefault();
        this.onPress(b, e.repeat);
      }
    });
    target.addEventListener('keyup', (e) => this.keys.delete((e as KeyboardEvent).key.toLowerCase()));
    target.addEventListener('blur', () => this.keys.clear());
    target.addEventListener('mousemove', (ev) => {
      if (typeof document === 'undefined' || !document.pointerLockElement) return;
      const e = ev as MouseEvent;
      this.mx += e.movementX;
      this.my += e.movementY;
    });
  }

  /** The gamepad state from the last poll. */
  pad(): PadState {
    return this.last;
  }

  /** Is this key down right now (case-insensitive)? */
  held(key: string): boolean {
    return this.keys.has(key.toLowerCase());
  }

  /** Mouse movement since the last call; only counts while the pointer is locked. */
  mouse(): { dx: number; dy: number } {
    const m = { dx: this.mx, dy: this.my };
    this.mx = this.my = 0;
    return m;
  }

  /** Call once per frame; returns how far to orbit (radians) and zoom (factor change) this frame. */
  poll(dt: number, menuOpen: boolean): { orbitX: number; orbitY: number; zoom: number } {
    const pad = this.padStub ?? readPad(navigator.getGamepads?.()[0] ?? null);
    const pressed = edges(this.prev, pad);
    if (pressed.length || pad.lx || pad.ly || pad.rx || pad.ry) this.using = 'pad';
    for (const b of pressed) this.onPress(b);
    // a held stick in a menu repeats like a d-pad
    const now = performance.now();
    if (menuOpen && (Math.abs(pad.lx) > 0.6 || Math.abs(pad.ly) > 0.6) && now > this.repeatAt) {
      this.repeatAt = now + 220;
      this.onPress(Math.abs(pad.lx) > Math.abs(pad.ly) ? (pad.lx > 0 ? 'right' : 'left') : pad.ly > 0 ? 'down' : 'up');
    }
    this.prev = this.last = pad;
    const k = (key: string) => (this.keys.has(key) ? 1 : 0);
    const stickX = menuOpen ? 0 : pad.lx, stickY = menuOpen ? 0 : pad.ly;
    return {
      orbitX: (stickX + k('d') - k('a')) * 1.8 * dt,
      orbitY: (stickY + k('s') - k('w')) * 1.2 * dt,
      zoom: (pad.ry + k('e') - k('q')) * 1.5 * dt,
    };
  }
}
