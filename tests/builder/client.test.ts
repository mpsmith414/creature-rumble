import { describe, expect, it } from 'vitest';
import type { BodyData } from '../../src/builder/build';
import { BuilderClient, type WorkerLike } from '../../src/builder/client';
import type { BuildRequest, BuildResponse } from '../../src/builder/worker';
import { biped, bird, hexapod, quadruped, snake } from '../fixtures/recipes';

class FakeWorker implements WorkerLike {
  onmessage: ((e: { data: BuildResponse }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: BuildRequest[] = [];
  postMessage(m: BuildRequest) { this.posted.push(m); }
  terminate() {}
  reply(r: BuildResponse) { this.onmessage!({ data: r }); }
}
const body = (key: string) => ({ key }) as unknown as BodyData;

function setup(opts: { workers?: number; cacheSize?: number } = {}) {
  const made: FakeWorker[] = [];
  const client = new BuilderClient({ ...opts, spawn: () => { const w = new FakeWorker(); made.push(w); return w; } });
  return { client, made };
}

describe('BuilderClient pool', () => {
  it('starts the asked-for number of workers', () => {
    expect(setup({ workers: 3 }).made.length).toBe(3);
    expect(setup().made.length).toBeGreaterThanOrEqual(1);
    expect(setup({ workers: 0 }).made.length).toBe(1);
  });

  it('gives requests to the least busy worker, ties to the lowest index', () => {
    const { client, made } = setup({ workers: 3 });
    [quadruped, snake, hexapod, biped, bird].forEach((r) => void client.build(r));
    expect(made.map((w) => w.posted.length)).toEqual([2, 2, 1]);
    expect(made[0].posted.map((p) => p.recipe.id)).toEqual(['quadruped', 'biped']);
    // worker 0 finishes one; the next request goes to it
    made[0].reply({ id: made[0].posted[0].id, body: body('a'), ms: 5 });
    void client.build({ ...quadruped, id: 'other', parts: quadruped.parts.map((p) => ({ ...p, length: p.length * 1.1 })) });
    expect(made[0].posted.length).toBe(3);
  });

  it('resolves each request from whichever worker answers, and records lastMs', async () => {
    const { client, made } = setup({ workers: 2 });
    const a = client.build(quadruped), b = client.build(snake);
    made[1].reply({ id: made[1].posted[0].id, body: body('snake'), ms: 7, cached: true });
    expect((await b).key).toBe('snake');
    expect(client.lastMs).toBe(7);
    made[0].reply({ id: made[0].posted[0].id, body: body('quad'), ms: 9 });
    expect((await a).key).toBe('quad');
    expect(client.lastMs).toBe(9);
  });

  it('keeps the in-memory cache in front: one request per body, and a failure is not remembered', async () => {
    const { client, made } = setup({ workers: 2 });
    const a = client.build(quadruped);
    expect(client.build(quadruped)).toBe(a);
    expect(made.flatMap((w) => w.posted).length).toBe(1);
    made[0].reply({ id: made[0].posted[0].id, error: 'boom' });
    await expect(a).rejects.toThrow('boom');
    void client.build(quadruped);
    expect(made.flatMap((w) => w.posted).length).toBe(2);
  });

  it('an error rejects only its own request', async () => {
    const { client, made } = setup({ workers: 2 });
    const a = client.build(quadruped), b = client.build(snake);
    made[0].reply({ id: made[0].posted[0].id, error: 'bad recipe' });
    made[1].reply({ id: made[1].posted[0].id, body: body('ok'), ms: 1 });
    await expect(a).rejects.toThrow('bad recipe');
    expect((await b).key).toBe('ok');
  });

  it('a failing worker rejects its pending requests only', async () => {
    const { client, made } = setup({ workers: 2 });
    const a = client.build(quadruped), b = client.build(snake);
    made[0].onerror!({ message: 'worker died' });
    await expect(a).rejects.toThrow('worker died');
    made[1].reply({ id: made[1].posted[0].id, body: body('ok'), ms: 1 });
    expect((await b).key).toBe('ok');
  });

  it('stops giving a dead worker requests (error or messageerror)', async () => {
    const { client, made } = setup({ workers: 3 });
    const a = client.build(quadruped);
    made[0].onerror!({ message: 'died' });
    await expect(a).rejects.toThrow('died');
    made[1].onmessageerror!();
    [snake, hexapod, biped].forEach((r) => void client.build(r));
    expect(made.map((w) => w.posted.length)).toEqual([1, 0, 3]);
  });

  it('rejects at once when every worker is dead, without remembering the failure', async () => {
    const { client, made } = setup({ workers: 2 });
    made.forEach((w) => w.onerror!({ message: 'gone' }));
    await expect(client.build(quadruped)).rejects.toThrow(/no builder worker/i);
    await expect(client.build(quadruped)).rejects.toThrow(/no builder worker/i);
    expect(made.flatMap((w) => w.posted).length).toBe(0);
  });
});
