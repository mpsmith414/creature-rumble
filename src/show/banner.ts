import './show.css';

/**
 * The big banner for names and big calls (the spike's Fx.show): a fat cartoon title with an optional line under it,
 * springing in at the top of the screen. Every announcer line is shown here too, so the show works with the sound off.
 * Text only (never HTML): names come from kids' phones.
 */
export class Banner {
  readonly el: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly sub: HTMLDivElement;
  private timer = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'show-banner';
    this.el.setAttribute('role', 'status');
    this.title = document.createElement('div');
    this.title.className = 'show-banner-title';
    this.sub = document.createElement('div');
    this.sub.className = 'show-banner-sub';
    this.el.append(this.title, this.sub);
    parent.append(this.el);
  }

  /** Shows `title` (and `sub` under it) for `seconds`; 0 keeps it up until the next `show` or `hide`. */
  show(title: string, sub = '', seconds = 3): void {
    this.title.textContent = title;
    this.sub.textContent = sub;
    this.sub.hidden = !sub;
    this.el.classList.remove('on');
    void this.el.offsetWidth; // restart the spring-in
    this.el.classList.add('on');
    clearTimeout(this.timer);
    if (seconds > 0) this.timer = window.setTimeout(() => this.hide(), seconds * 1000);
  }

  hide(): void {
    clearTimeout(this.timer);
    this.el.classList.remove('on');
  }

  /** Where it is on the screen while it is up (fractions; for pops to keep clear of), or null when it is down. */
  band(): { top: number; bottom: number; left: number; right: number } | null {
    if (!this.el.classList.contains('on')) return null;
    const r = this.el.getBoundingClientRect(), w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
    return { top: r.top / h, bottom: r.bottom / h, left: r.left / w, right: r.right / w };
  }

  /** Takes it off the page (and stops its timer). */
  dispose(): void {
    clearTimeout(this.timer);
    this.el.remove();
  }
}
