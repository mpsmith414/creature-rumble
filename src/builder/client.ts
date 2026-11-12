import type { Recipe } from '../recipe/schema';
import { bodyKey, type BodyData } from './build';
import { pickWorker } from './pool';
import type { BuildRequest, BuildResponse } from './worker';

/** What the client needs of a worker (a real `Worker`, or a stand-in in tests). */
export interface WorkerLike {
  onmessage: ((e: { data: BuildResponse }) => void) | null;
  onerror: ((e: { message: string }) => void) | null;
  onmessageerror?: (() => void) | null;
  postMessage(m: BuildRequest): void;
  terminate(): void;
}
export type BuilderOptions = { workers?: number; cacheSize?: number; spawn?: () => WorkerLike };

const spawnWorker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
/** One less than the logical cores (the page keeps one), 1 to 4. */
const defaultWorkers = () => Math.max(1, Math.min(4, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2) - 1));

/**
 * Builds bodies in a small pool of background workers, so making a creature never freezes the screen. Each worker looks
 * a body up in the saved-bodies cache before building it, and saves what it builds.
 */
export class BuilderClient {
  private workers: WorkerLike[];
  private busy: number[];
  private dead: boolean[];
  private next = 1;
  private pending = new Map<number, { worker: number; resolve: (b: BodyData) => void; reject: (e: Error) => void }>();
  private cache = new Map<string, Promise<BodyData>>();
  private cacheSize: number;
  /** Milliseconds the last finished build (or cache read) took in its worker. */
  lastMs = 0;
  /** Bodies that came from the saved-bodies cache and bodies built, since this client started. */
  stats = { cached: 0, built: 0 };

  constructor({ workers = defaultWorkers(), cacheSize = 16, spawn = spawnWorker }: BuilderOptions = {}) {
    this.cacheSize = cacheSize;
    this.workers = Array.from({ length: Math.max(1, Math.round(workers)) }, (_, i) => {
      const w = spawn();
      w.onmessage = ({ data }) => this.settle(i, data);
      w.onerror = (e) => this.failWorker(i, new Error(e.message || 'builder worker failed'));
      w.onmessageerror = () => this.failWorker(i, new Error('a builder reply could not be read'));
      return w;
    });
    this.busy = this.workers.map(() => 0);
    this.dead = this.workers.map(() => false);
  }

  private settle(worker: number, data: BuildResponse) {
    const p = this.pending.get(data.id);
    if (!p) return;
    this.pending.delete(data.id);
    this.busy[worker]--;
    if (data.body) {
      this.lastMs = data.ms ?? 0;
      this.stats[data.cached ? 'cached' : 'built']++;
      p.resolve(data.body);
    } else p.reject(new Error(data.error ?? 'build failed'));
  }

  /** A worker died: it gets no more requests and its pending ones fail (the others carry on). */
  private failWorker(worker: number, error: Error) {
    this.dead[worker] = true;
    for (const [id, p] of this.pending) if (p.worker === worker) { this.pending.delete(id); this.busy[worker]--; p.reject(error); }
  }

  build(recipe: Recipe): Promise<BodyData> {
    const key = bodyKey(recipe);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit); // most recently used last
      return hit;
    }
    const worker = pickWorker(this.busy.map((n, i) => (this.dead[i] ? Infinity : n)));
    if (worker < 0) return Promise.reject(new Error('no builder worker is running')); // not remembered
    const promise = new Promise<BodyData>((resolve, reject) => {
      const id = this.next++;
      this.pending.set(id, { worker, resolve, reject });
      this.busy[worker]++;
      this.workers[worker].postMessage({ id, recipe } satisfies BuildRequest);
    });
    promise.catch(() => this.cache.delete(key));
    this.cache.set(key, promise);
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
    return promise;
  }
}
