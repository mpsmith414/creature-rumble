import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_LIMIT, LIMITS } from '../src/bring/protocol';

export { DEFAULT_LIMIT, LIMITS };

export type CapState = { day: string; count: number; limit: number };

const pad = (n: number) => String(n).padStart(2, '0');
/** The local calendar day (the cap resets at local midnight, not UTC). */
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isLimit = (v: unknown): v is (typeof LIMITS)[number] => (LIMITS as readonly unknown[]).includes(v);

/** How many creatures the designer may read today; optionally kept in a small JSON file so a restart does not reset it. */
export class DailyCap {
  private s: CapState;
  private readonly file?: string;
  private readonly now: () => Date;

  constructor(opts: { file?: string; now?: () => Date }) {
    this.file = opts.file;
    this.now = opts.now ?? (() => new Date());
    this.s = { day: localDay(this.now()), count: 0, limit: DEFAULT_LIMIT };
    if (this.file) this.load(this.file);
  }

  /** Today's state; a new local day starts at count 0 with the same limit. */
  state(): CapState {
    const day = localDay(this.now());
    if (day !== this.s.day) {
      this.s = { day, count: 0, limit: this.s.limit };
      this.save();
    }
    return { ...this.s };
  }

  full(): boolean {
    const s = this.state();
    return s.count >= s.limit;
  }

  /** Use one creature of today's allowance; false (and nothing counted) when it is used up. */
  take(): boolean {
    if (this.full()) return false;
    this.s.count++;
    this.save();
    return true;
  }

  setLimit(limit: number): CapState {
    if (!isLimit(limit)) throw new RangeError(`limit must be one of ${LIMITS.join(', ')}`);
    this.state();
    this.s.limit = limit;
    this.save();
    return this.state();
  }

  /** A missing, unreadable or odd file leaves the fresh default state. */
  private load(file: string): void {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CapState>;
      if (isLimit(j.limit)) this.s.limit = j.limit;
      if (typeof j.day === 'string' && Number.isInteger(j.count) && j.count! >= 0) {
        this.s.day = j.day;
        this.s.count = j.count!;
      }
    } catch {
      /* start fresh */
    }
  }

  /** Write a temp file then rename it over the real one, so a crash never leaves half a file. */
  private save(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.s));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.warn(`could not save the daily cap: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
