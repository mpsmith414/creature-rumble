import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app';
import type { DesignerModel } from '../../server/model';
import { ANNOUNCER_VOICES, cacheKey, splitForPauses, VoiceCache, type Synth } from '../../server/voice';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A synthesiser that never loads a model: counts calls and in-flight work, answers after a tick. */
function fakeSynth(o: { ready?: boolean; fail?: () => boolean } = {}) {
  const s = { isReady: o.ready ?? true, calls: [] as string[], inFlight: 0, maxInFlight: 0,
    ready: () => s.isReady,
    async speak(text: string): Promise<Uint8Array> {
      s.calls.push(text);
      s.maxInFlight = Math.max(s.maxInFlight, ++s.inFlight);
      await new Promise((r) => setTimeout(r, 5));
      s.inFlight--;
      if (o.fail?.()) throw new Error('boom');
      return new TextEncoder().encode(`RIFF:${text}`);
    } };
  return s satisfies Synth & Record<string, unknown>;
}

function setup(synth: Synth | ((voice: string) => Synth)) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-'));
  dirs.push(dir);
  const app = createApp({ model: 'fake' } as DesignerModel, { voice: { synth, cache: new VoiceCache(dir) }, address: () => '127.0.0.1' });
  const say = (text: unknown, extra: Record<string, unknown> = {}) => app.request('/api/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, ...extra }) });
  return { app, say };
}

it('POST /api/voice is for the PC itself: a LAN address gets 403', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-'));
  dirs.push(dir);
  const app = createApp({ model: 'fake' } as DesignerModel, { voice: { synth: fakeSynth(), cache: new VoiceCache(dir) }, address: () => '192.168.1.44' });
  const res = await app.request('/api/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
  expect(res.status).toBe(403);
});

describe('voice service', () => {
  it('answers WAV for a line', async () => {
    const { say } = setup(fakeSynth());
    const res = await say('Dawn, in the valley.');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe('RIFF:Dawn, in the valley.');
  });

  it('a second request for the same text is a cache hit', async () => {
    const synth = fakeSynth();
    const { say } = setup(synth);
    await say('Same line.');
    const again = await say('Same line.');
    expect(again.status).toBe(200);
    expect(new TextDecoder().decode(await again.arrayBuffer())).toBe('RIFF:Same line.');
    expect(synth.calls).toHaveLength(1);
  });

  it('400 for empty and for 301 characters', async () => {
    const { say } = setup(fakeSynth());
    for (const t of ['', '   ', undefined]) {
      const res = await say(t);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'empty' });
    }
    const long = await say('a'.repeat(301));
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({ error: 'too long' });
    expect((await say('a'.repeat(300))).status).toBe(200);
  });

  it('503 while loading', async () => {
    const synth = fakeSynth({ ready: false });
    const { say } = setup(synth);
    const res = await say('Hello.');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'loading' });
    expect(synth.calls).toHaveLength(0);
  });

  it('one synthesis at a time', async () => {
    const synth = fakeSynth();
    const { say } = setup(synth);
    const [a, b, c] = await Promise.all([say('One.'), say('Two.'), say('Three.')]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(synth.calls).toHaveLength(3);
    expect(synth.maxInFlight).toBe(1);
  });

  it('500 when the synth throws, and the next request still works', async () => {
    let fail = true;
    const { say } = setup(fakeSynth({ fail: () => fail }));
    const bad = await say('Broken.');
    expect(bad.status).toBe(500);
    expect(await bad.json()).toEqual({ error: 'failed' });
    fail = false;
    expect((await say('Fine.')).status).toBe(200);
    expect((await say('Broken.')).status).toBe(200);
  });

  it('GET /api/voice reports ready', async () => {
    const synth = fakeSynth({ ready: false });
    const { app } = setup(synth);
    expect(await (await app.request('/api/voice')).json()).toEqual({ ok: true, ready: false });
    synth.isReady = true;
    expect(await (await app.request('/api/voice')).json()).toEqual({ ok: true, ready: true });
  });
});

describe('voice service limits', () => {
  it('503 busy past 8 waiting, but cached lines are still served', async () => {
    const synth = fakeSynth();
    const { say } = setup(synth);
    await say('Cached.');
    const all = await Promise.all([...Array.from({ length: 10 }, (_, i) => say(`Line ${i}.`)), say('Cached.')]);
    const codes = all.map((r) => r.status);
    expect(codes.filter((s) => s === 503)).toHaveLength(2);
    expect(codes.filter((s) => s === 200)).toHaveLength(9);
    expect(codes[10]).toBe(200);
    const busy = all.find((r) => r.status === 503)!;
    expect(await busy.json()).toEqual({ error: 'busy' });
  });

  it('413 for a body over 4 KB', async () => {
    const { say } = setup(fakeSynth());
    const res = await say('a'.repeat(5000));
    expect(res.status).toBe(413);
  });
});

describe('pacing', () => {
  it('splits the owner’s sample line into three parts', () => {
    expect(splitForPauses('Dawn, in the valley. And down at the water’s edge... the deer have come to drink.')).toEqual([
      { text: 'Dawn, in the valley.', pauseAfter: 0.3 },
      { text: 'And down at the water’s edge...', pauseAfter: 0.45 },
      { text: 'the deer have come to drink.', pauseAfter: 0 },
    ]);
  });
  it('splits two sentences, and treats … like ...', () => {
    expect(splitForPauses('Not today, hunter. Not today.')).toEqual([{ text: 'Not today, hunter.', pauseAfter: 0.3 }, { text: 'Not today.', pauseAfter: 0 }]);
    expect(splitForPauses('So… quiet!')[0]).toEqual({ text: 'So…', pauseAfter: 0.45 });
  });
  it('a line with no breaks is one part; a trailing ellipsis has no pause', () => {
    expect(splitForPauses('Just one thing, really')).toEqual([{ text: 'Just one thing, really', pauseAfter: 0 }]);
    expect(splitForPauses('Wait...')).toEqual([{ text: 'Wait...', pauseAfter: 0 }]);
    expect(splitForPauses('  ')).toEqual([]);
  });
  it('the cache key differs from the pre-pacing key', () => {
    const old = createHash('sha256').update('bm_daniel|0.88|Hello.').digest('hex');
    expect(new VoiceCache('x').key('Hello.')).not.toBe(old);
  });
});

describe('announcer voices', () => {
  it('voice route rejects a voice outside the allowlist', async () => {
    const synth = fakeSynth();
    const { say } = setup(synth);
    const res = await say('Hi', { voice: 'xx_nope' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad voice' });
    expect(synth.calls).toHaveLength(0);
    expect((await say('Hi', { voice: 'am_fenrir' })).status).toBe(200);
  });
  it('voice and speed are part of the cache key', () => {
    expect(cacheKey('Hi', 'am_michael', 1.1)).not.toBe(cacheKey('Hi', 'am_fenrir', 1.1));
    expect(cacheKey('Hi', 'am_michael', 1.1)).not.toBe(cacheKey('Hi', 'am_michael', 1.2));
    expect(cacheKey('Hi', 'am_michael', 1.1)).toBe(cacheKey('Hi', 'am_michael', 1.1));
  });
  it('one synth per voice, created lazily and once; speed is clamped', async () => {
    const made: string[] = [];
    const speeds: (number | undefined)[] = [];
    const { say } = setup((voice) => {
      made.push(voice);
      return { ready: () => true, speak: async (t: string, sp?: number) => { speeds.push(sp); return new TextEncoder().encode(`${voice}:${t}`); } };
    });
    expect(made).toEqual([]);
    await say('A.', { voice: 'am_fenrir' });
    await say('B.', { voice: 'am_fenrir', speed: 9 });
    await say('C.', { voice: 'am_puck', speed: 0.1 });
    expect(made).toEqual(['am_fenrir', 'am_puck']);
    expect(speeds[1]).toBe(1.4);
    expect(speeds[2]).toBe(0.8);
  });
  it('the allowlist has no duplicates', () => {
    expect(new Set(ANNOUNCER_VOICES).size).toBe(ANNOUNCER_VOICES.length);
  });
});
