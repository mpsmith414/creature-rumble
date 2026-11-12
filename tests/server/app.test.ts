import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createApp as createRawApp } from '../../server/app';
import { DailyCap } from '../../server/cap';
import { Declined, type DesignerModel } from '../../server/model';
import { MOVES } from '../../src/fight/types';
import type { Recipe } from '../../src/recipe/schema';
import { quadruped, snake } from '../fixtures/recipes';

type Opts = NonNullable<Parameters<typeof createRawApp>[1]>;
/** The TV on this PC (loopback) unless a test says otherwise. */
const createApp = (m: DesignerModel, o: Opts = {}) => createRawApp(m, { address: () => '127.0.0.1', ...o });

const cards = { name: 'Bob', eats: 'flowers 🌸', speed: 'slow 🐌', mood: 'shy 🙈', special: 'six legs' };
const goodRead = {
  status: 'ok', message: '', recipe: { ...quadruped, parts: quadruped.parts.map((p) => (p.id === 'tail' ? { ...p, length: 99 } : p)) },
  checklist: ['4 legs', 'spotted tail'], view: { angle: 'side', facing: 'left' }, cards,
};
const image = { base64: 'aGVsbG8=', mediaType: 'image/png' as const };

/** A model that answers from a queue of canned replies (or throws them), keeping every request it was sent. */
function fake(replies: Partial<Record<'read' | 'lookAgain' | 'tweak', unknown[]>>): DesignerModel & { calls: number; sent: unknown[] } {
  const m = {
    model: 'fake',
    calls: 0,
    sent: [] as unknown[],
    async next(kind: 'read' | 'lookAgain' | 'tweak', req: unknown) {
      m.calls++;
      m.sent.push(req);
      const r = replies[kind]!.shift();
      if (r instanceof Error) throw r;
      return r;
    },
    read(req: unknown) { return m.next('read', req); },
    lookAgain(req: unknown) { return m.next('lookAgain', req); },
    tweak(req: unknown) { return m.next('tweak', req); },
  };
  return m;
}
const snakeReadReply = () => ({ ...goodRead, recipe: structuredClone(snake), checklist: ['long body'] });

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('designer service', () => {
  it('reports its model', async () => {
    const res = await createApp(fake({})).request('/api/health');
    expect(await res.json()).toEqual({ ok: true, model: 'fake' });
  });

  it('reads a drawing into a normalised recipe, passing fixes along', async () => {
    const res = await post(createApp(fake({ read: [goodRead] })), '/api/read', { image, words: '' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.recipe.parts.find((p: { id: string }) => p.id === 'tail').length).toBe(6);
    expect(body.fixes.some((f: string) => f.includes('length'))).toBe(true);
    expect(body.cards.name).toBe('Bob');
  });

  it('retries once when the output is malformed', async () => {
    const m = fake({ read: [{ nonsense: true }, goodRead] });
    const res = await post(createApp(m), '/api/read', { image: null, words: 'a six legged snail' });
    expect(res.status).toBe(200);
    expect(m.calls).toBe(2);
  });

  it('gives up with 422 after two malformed answers', async () => {
    const res = await post(createApp(fake({ read: [{}, { status: 'ok', recipe: { parts: [] } }] })), '/api/read', { image, words: '' });
    expect(res.status).toBe(422);
  });

  it('is "resting" when Claude cannot be reached', async () => {
    const err = new Anthropic.APIConnectionError({ message: 'offline' });
    const res = await post(createApp(fake({ read: [err] })), '/api/read', { image, words: '' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'resting' });
  });

  it('says when it is resting because the API key was rejected (without the key)', async () => {
    const err = new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers());
    const res = await post(createApp(fake({ read: [err] })), '/api/read', { image, words: '' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'resting', reason: 'key' });
  });

  it('turns a refusal into a friendly decline', async () => {
    const res = await post(createApp(fake({ read: [new Declined('no')] })), '/api/read', { image, words: 'something unkind' });
    expect((await res.json()).status).toBe('declined');
  });

  it('passes "no creature here" through', async () => {
    const res = await post(createApp(fake({ read: [{ ...goodRead, status: 'noCreature', message: 'I couldn’t find a creature!', recipe: null }] })), '/api/read', { image, words: '' });
    expect(await res.json()).toEqual({ status: 'noCreature', message: 'I couldn’t find a creature!' });
  });

  it('rejects empty, oversized and over-long requests', async () => {
    const app = createApp(fake({}));
    expect((await post(app, '/api/read', { image: null, words: '  ' })).status).toBe(400);
    expect((await post(app, '/api/look-again', { image, words: '', render: image, recipe: quadruped, checklist: [], pass: 6 })).status).toBe(400);
    const huge = JSON.stringify({ image: { base64: 'a'.repeat(13 * 1024 * 1024), mediaType: 'image/png' }, words: '' });
    expect((await post(app, '/api/read', huge)).status).toBe(413);
  });

  it('looks again and returns edits', async () => {
    const edits = [{ op: 'set', path: 'parts.tail.length', valueJson: '0.5' }];
    const res = await post(createApp(fake({ lookAgain: [{ verdict: 'edits', edits, note: 'Longer tail!' }] })), '/api/look-again', {
      image, words: '', render: image, recipe: quadruped, checklist: ['long tail'], pass: 1,
    });
    expect(await res.json()).toEqual({ status: 'ok', verdict: 'edits', edits, note: 'Longer tail!' });
  });

  it('tweaks with edits and new cards', async () => {
    const reply = { status: 'ok', message: '', edits: [{ op: 'set', path: 'life.sizeM', valueJson: '2' }], cards: { ...cards, name: 'Big Bob' }, note: 'Now it’s huge!' };
    const res = await post(createApp(fake({ tweak: [reply] })), '/api/tweak', { recipe: quadruped, cards, words: 'make it bigger' });
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.cards.name).toBe('Big Bob');
  });
});

describe('fighters', () => {
  const fists = { move: 'punch', weapons: ['foot_f'], weight: 'a feathery two pounds', intro: 'From the bedroom of {maker}! It’s... QUADRUPED!' };
  const readWith = async (fight: unknown) => {
    const recipe: Record<string, unknown> = { ...structuredClone(quadruped) };
    if (fight === undefined) delete recipe.fight;
    else recipe.fight = fight;
    const res = await post(createApp(fake({ read: [{ ...goodRead, recipe }] })), '/api/read', { image, words: '' });
    return (await res.json()) as { recipe: Recipe; fixes: string[] };
  };

  it('read result is made a fighter', async () => {
    const app = createApp(fake({ read: [snakeReadReply()] }));
    const res = await (await post(app, '/api/read', { image: null, words: 'a snake' })).json();
    expect(res.recipe.parts.some((p: { role: string }) => p.role === 'arm')).toBe(true);
    expect(res.recipe.fight).not.toBeNull();
    expect(res.fixes.some((f: string) => f.includes('stood up'))).toBe(true);
  });

  it('keeps the model’s own fight plan when it names real parts', async () => {
    expect((await readWith(fists)).recipe.fight).toEqual(fists);
  });

  it('fills the fight plan from the body when it is missing, null or unusable', async () => {
    for (const fight of [undefined, null, { move: 'karate', weapons: ['foot_f'], weight: '', intro: '' }, { ...fists, weapons: ['nope'] }]) {
      const { recipe, fixes } = await readWith(fight);
      expect(MOVES).toContain(recipe.fight!.move);
      expect(recipe.fight!.weapons.length).toBeGreaterThan(0);
      for (const w of recipe.fight!.weapons) expect(recipe.parts.some((p) => p.id === w)).toBe(true);
      expect(fixes.some((f) => f.startsWith('fight plan'))).toBe(true);
    }
  });

  it('looks again at a fighter and hands a changed fight plan back as an edit', async () => {
    const m = fake({ lookAgain: [{ verdict: 'edits', edits: [], note: 'Bigger fists!', fight: fists }] });
    const res = await post(createApp(m), '/api/look-again', { image, words: '', render: image, recipe: snake, checklist: [], pass: 1 });
    const body = await res.json();
    expect(body).toEqual({ status: 'ok', verdict: 'edits', edits: [{ op: 'set', path: 'fight', valueJson: JSON.stringify(fists) }], note: 'Bigger fists!' });
    const seen = (m.sent[0] as { recipe: Recipe }).recipe;
    expect(seen.parts.some((p) => p.role === 'arm')).toBe(true);
    expect(seen.fight).not.toBeNull();
  });

  it('tweaks a fighter and hands a changed fight plan back as an edit', async () => {
    const reply = { status: 'ok', message: '', edits: [{ op: 'set', path: 'life.sizeM', valueJson: '2' }], cards, note: 'Now it kicks!', fight: { ...fists, move: 'kick' } };
    const m = fake({ tweak: [reply] });
    const body = await (await post(createApp(m), '/api/tweak', { recipe: snake, cards, words: 'make it kick' })).json();
    expect(body.edits).toEqual([reply.edits[0], { op: 'set', path: 'fight', valueJson: JSON.stringify(reply.fight) }]);
    expect(body).not.toHaveProperty('fight');
    expect((m.sent[0] as { recipe: Recipe }).recipe.parts.some((p) => p.role === 'arm')).toBe(true);
  });

  it('leaves the fight plan alone when looking again or tweaking says nothing (or nonsense) about it', async () => {
    const m = fake({ lookAgain: [{ verdict: 'matches', edits: [], note: 'Looks right!', fight: null }, { verdict: 'matches', edits: [], note: 'Yes!', fight: { move: 'karate' } }] });
    for (let i = 0; i < 2; i++) {
      const body = await (await post(createApp(m), '/api/look-again', { image, words: '', render: image, recipe: quadruped, checklist: [], pass: 1 })).json();
      expect(body.edits).toEqual([]);
      expect(body).not.toHaveProperty('fight');
    }
  });
});

describe('the daily cap', () => {
  const today = () => new Date(2026, 9, 14, 12, 0);

  it('answers 429 "resting" without calling the model once the day is full', async () => {
    const cap = new DailyCap({ now: today });
    cap.setLimit(5);
    for (let i = 0; i < 5; i++) cap.take();
    const m = fake({ read: [goodRead] });
    const res = await post(createApp(m, { cap }), '/api/read', { image, words: '' });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'resting' });
    expect(m.calls).toBe(0);
  });

  it('counts each read, even one that then fails, but not a bad request', async () => {
    const cap = new DailyCap({ now: today });
    const app = createApp(fake({ read: [goodRead, {}, {}] }), { cap });
    await post(app, '/api/read', { image, words: '' });
    expect(cap.state().count).toBe(1);
    expect((await post(app, '/api/read', { image, words: '' })).status).toBe(422);
    expect(cap.state().count).toBe(2);
    expect((await post(app, '/api/read', { image: null, words: ' ' })).status).toBe(400);
    expect(cap.state().count).toBe(2);
  });

  it('is uncapped when no cap is passed', async () => {
    const app = createApp(fake({ read: [goodRead] }));
    expect((await post(app, '/api/read', { image, words: '' })).status).toBe(200);
    expect((await app.request('/api/cap')).status).toBe(404);
  });

  it('reads and sets the limit over /api/cap', async () => {
    const cap = new DailyCap({ now: today });
    const app = createApp(fake({}), { cap, address: () => '127.0.0.1' }); // the TV on this PC
    expect(await (await app.request('/api/cap')).json()).toEqual({ day: '2026-10-14', count: 0, limit: 10 });
    const res = await post(app, '/api/cap', { limit: 20 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ day: '2026-10-14', count: 0, limit: 20 });
    expect((await (await app.request('/api/cap')).json()).limit).toBe(20);
    expect((await post(app, '/api/cap', { limit: 7 })).status).toBe(400);
    expect((await post(app, '/api/cap', 'nope')).status).toBe(400);
    expect(cap.state().limit).toBe(20);
  });

  it('only the PC itself may set the limit (a phone on the Wi-Fi gets 403, and so does an unknown address)', async () => {
    const cap = new DailyCap({ now: today });
    for (const address of ['192.168.1.44', undefined]) {
      const app = createApp(fake({}), { cap, address: () => address });
      expect((await post(app, '/api/cap', { limit: 20 })).status).toBe(403);
      expect((await app.request('/api/cap')).status).toBe(200); // reading it is fine
    }
    expect(cap.state().limit).toBe(10);
  });
});

describe('designer routes are local-only', () => {
  it('a LAN address gets 403 on read, look-again and tweak', async () => {
    const app = createRawApp(fake({}), { address: () => '192.168.1.44' });
    for (const path of ['/api/read', '/api/look-again', '/api/tweak']) expect((await post(app, path, { image, words: 'x' })).status).toBe(403);
  });
});

describe('extractJson', () => {
  it('finds the object in a reply, with or without fences', async () => {
    const { extractJson } = await import('../../server/model');
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":{"b":[1,2]}}\n```')).toEqual({ a: { b: [1, 2] } });
    expect(extractJson('Here you go: {"a":1} hope it helps')).toEqual({ a: 1 });
    expect(extractJson('no json here')).toBeUndefined();
    expect(extractJson('{broken')).toBeUndefined();
  });
});
