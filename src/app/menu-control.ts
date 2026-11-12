import type { Button } from '../shared/input';

/** An open menu, as the control drives it: it takes the controller's presses until it is closed. */
export type Menu = { press(b: Button, repeat?: boolean): void; close(): void };

export type MenuDeps = {
  ui: HTMLElement;
  /** Draw the menu into `ui`; `close` shuts it (a button that leaves the menu calls it). */
  open(ui: HTMLElement, close: () => void): Menu;
  /** Is the start screen still up? It comes first. */
  waiting(): boolean;
  /** Does something else have the screen (the workshop)? Then Esc is its Back and the menu stays shut. */
  busy?(): boolean;
  /** The menu has opened. */
  opened?(): void;
  /** Esc with the menu shut, for something on the screen that takes it first: true when it did. */
  escape?(): boolean;
};

/**
 * The pause menu's wiring: Start or Esc opens and closes it, and while it is open it takes every controller press (B goes
 * back inside it). `press` takes the controller's presses first (true when it used one).
 */
export function menuControl(d: MenuDeps) {
  let menu: Menu | null = null;
  const close = () => {
    menu?.close();
    menu = null;
  };
  const show = () => {
    if (menu || d.waiting() || d.busy?.()) return;
    if (document.pointerLockElement) document.exitPointerLock(); // hand the mouse back for the buttons
    menu = d.open(d.ui, close);
    d.opened?.();
  };
  const toggle = () => (menu ? close() : show());

  // Esc toggles the menu (like Start). `Input` maps Esc to B, so it is caught first, in the capture phase, and goes no further.
  // Something on the screen that takes Esc first (`escape`) gets it while the menu is shut.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || d.waiting() || d.busy?.()) return; // the start screen's own handler takes it, or the workshop's Back
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat || (!menu && d.escape?.())) return;
    toggle();
  }, true);
  // The browser keeps Esc for itself while the mouse is captured (it lets the mouse go and the page never sees the key), so
  // losing the capture opens the menu, as the press meant. (Opening the menu lets go of it too, with the menu already up.)
  // A quiet release (for something that wants a free mouse) lets go without the menu.
  let quiet = false;
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement) return;
    if (quiet) return void (quiet = false);
    if (!menu && !d.waiting()) show();
  });

  return {
    /** The open menu, or null. */
    get open() {
      return menu;
    },
    show,
    close,
    /** Let go of the captured mouse without the menu opening (for something that needs a free mouse). */
    quietRelease() {
      if (!document.pointerLockElement) return;
      quiet = true;
      document.exitPointerLock();
    },
    /** A controller press: while the menu is open it takes them all (Start closes it); otherwise Start opens it. */
    press(b: Button, repeat = false): boolean {
      if (menu) {
        if (b === 'start') {
          if (!repeat) close();
        } else menu.press(b, repeat);
        return true;
      }
      if (b !== 'start') return false;
      if (!repeat) show();
      return true;
    },
  };
}
export type MenuControl = ReturnType<typeof menuControl>;
