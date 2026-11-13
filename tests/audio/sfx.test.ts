import { describe, expect, it } from 'vitest';
import { createCrowd } from '../../src/audio/crowd';
import { createMixer, lazyAudio } from '../../src/audio/mixer';
import { createSfx, pitchForSize } from '../../src/audio/sfx';

interface Call { kind: string; value?: number; time?: number; tc?: number }
class FakeParam {
  value = 1;
  calls: Call[] = [];
  setValueAtTime(v: number, t: number) { this.value = v; this.calls.push({ kind: 'set', value: v, time: t }); return this; }
  linearRampToValueAtTime(v: number, t: number) { this.calls.push({ kind: 'linear', value: v, time: t }); return this; }
  exponentialRampToValueAtTime(v: number, t: number) { if (!(v > 0)) throw new Error('exponential ramp to ' + v); this.calls.push({ kind: 'exp', value: v, time: t }); return this; }
  setTargetAtTime(v: number, t: number, tc: number) { this.calls.push({ kind: 'target', value: v, time: t, tc }); return this; }
  cancelScheduledValues(t: number) { this.calls.push({ kind: 'cancel', time: t }); return this; }
}
class FakeNode {
  started: number | null = null;
  stopped: number | null = null;
  disconnected = false;
  onended: (() => void) | null = null;
  loop = false;
  buffer: unknown = null;
  type = '';
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  threshold = new FakeParam();
  ratio = new FakeParam();
  delayTime = new FakeParam();
  constructor(public kind: string) {}
  outs: FakeNode[] = [];
  connect(to: FakeNode) { this.outs.push(to); return to; }
  disconnect() { this.disconnected = true; }
  start(t = 0) { this.started = t; }
  stop(t = 0) { this.stopped = t; }
  /** Plays out: fires `onended` as the browser does after the stop time. */
  end() { this.onended?.(); }
}
function fakeCtx() {
  const nodes: FakeNode[] = [];
  const make = (kind: string) => () => { const n = new FakeNode(kind); nodes.push(n); return n; };
  const raw = {
    currentTime: 1,
    sampleRate: 8000,
    state: 'running',
    buffers: 0,
    destination: new FakeNode('destination'),
    createBuffer(c: number, len: number) {
      raw.buffers++;
      const d = new Float32Array(len);
      return { length: len, numberOfChannels: c, sampleRate: 8000, duration: len / 8000, getChannelData: () => d };
    },
    createOscillator: make('osc'),
    createBufferSource: make('src'),
    createGain: make('gain'),
    createBiquadFilter: make('filter'),
    createDynamicsCompressor: make('comp'),
    createConvolver: make('conv'),
    createDelay: make('delay'),
    resume() { raw.state = 'running'; return Promise.resolve(); },
  };
  return { ctx: raw as unknown as AudioContext, raw, nodes };
}
const out = () => new FakeNode('out') as unknown as AudioNode;
const reach = (from: FakeNode, seen = new Set<FakeNode>()): Set<FakeNode> => {
  if (!seen.has(from)) { seen.add(from); from.outs.forEach((o) => reach(o, seen)); }
  return seen;
};

describe('sound', () => {
  it('bigger fighters boing lower', () => {
    expect(pitchForSize(2.4)).toBeLessThan(pitchForSize(0.7));
  });

  it('ducking lowers the crowd and restores it', () => {
    const { ctx } = fakeCtx();
    const mixer = createMixer(ctx);
    const calls = (mixer.crowd.gain as unknown as FakeParam).calls;
    mixer.duckForVoice(true);
    mixer.duckForVoice(false);
    const [on, off] = calls.filter((c) => c.kind === 'target');
    expect(20 * Math.log10(on.value!)).toBeCloseTo(-10, 5);
    expect(on.tc).toBe(0.15);
    expect(off.value).toBe(1);
    expect(off.tc).toBe(0.15);
  });

  it('pitch falls steadily across 0.45 to 3.5 m', () => {
    let prev = Infinity;
    for (let s = 0.45; s <= 3.5; s += 0.05) {
      const p = pitchForSize(s);
      expect(p).toBeLessThan(prev);
      prev = p;
    }
    expect(pitchForSize(1.6 ** 2)).toBeCloseTo(1, 5);
  });

  for (const name of ['boing', 'bonk', 'whoosh', 'thud', 'sting', 'fanfare', 'drumRoll', 'drum'] as const) {
    it(`${name} schedules sources that stop, and cleans up when they end`, () => {
      const { ctx, nodes } = fakeCtx();
      const sfx = createSfx(ctx, out());
      if (name === 'boing') sfx.boing(1);
      else if (name === 'drumRoll') sfx.drumRoll(2);
      else sfx[name]();
      const sources = nodes.filter((n) => n.kind === 'osc' || n.kind === 'src');
      expect(sources.length).toBeGreaterThan(0);
      for (const s of sources) {
        expect(s.started).not.toBeNull();
        expect(s.stopped).toBeGreaterThan(s.started!);
      }
      expect(nodes.some((n) => n.disconnected)).toBe(false);
      sources.forEach((s) => s.end());
      expect(nodes.every((n) => n.disconnected)).toBe(true);
    });
  }

  it('boing frequency follows the size', () => {
    const start = (size: number) => {
      const { ctx, nodes } = fakeCtx();
      createSfx(ctx, out()).boing(size);
      return nodes.find((n) => n.kind === 'osc')!.frequency.calls[0].value!;
    };
    expect(start(3)).toBeLessThan(start(0.5));
  });

  it('the noise buffer is made once per context', () => {
    const { ctx, raw } = fakeCtx();
    const sfx = createSfx(ctx, out());
    sfx.boing(1);
    sfx.bonk();
    sfx.thud();
    expect(raw.buffers).toBe(1);
  });

  describe('crowd', () => {
    const setup = () => {
      const f = fakeCtx();
      const crowd = createCrowd(f.ctx, out());
      crowd.start();
      const target = (f.nodes.find((n) => n.kind === 'gain' && n.outs.some((o) => o.kind === 'out')))!;
      const level = target.gain;
      level.calls.length = 0;
      return { ...f, crowd, level };
    };
    it('swell ramps to a higher gain for a higher level', () => {
      const a = setup(), b = setup();
      a.crowd.swell(0.2, 2);
      b.crowd.swell(0.9, 2);
      const end = (l: FakeParam) => l.calls.filter((c) => c.kind === 'linear').pop()!;
      expect(end(b.level).value).toBeGreaterThan(end(a.level).value!);
      expect(end(a.level).time).toBeCloseTo(3, 5);
    });
    it('roar surges, then settles back', () => {
      const { crowd, level } = setup();
      crowd.roar();
      const ramps = level.calls.filter((c) => c.kind === 'linear');
      expect(ramps[0].value).toBeGreaterThan(ramps[1].value!);
      expect(ramps[1].time).toBeGreaterThan(ramps[0].time!);
    });
    it('aww dips below the resting level, then recovers', () => {
      const { crowd, level } = setup();
      crowd.aww();
      const ramps = level.calls.filter((c) => c.kind === 'linear');
      expect(ramps[0].value).toBeLessThan(0.25);
      expect(ramps[1].value).toBeGreaterThan(ramps[0].value!);
    });
    it('rise climbs over the wind-up, then settles back to the resting bed', () => {
      const { crowd, level } = setup();
      crowd.rise(1);
      const ramps = level.calls.filter((c) => c.kind === 'linear');
      expect(ramps[0].value).toBeGreaterThan(0.5);
      expect(ramps[0].time).toBeCloseTo(2, 5); // now (1) + 1 s
      expect(ramps[1].value).toBeCloseTo(0.25, 5);
      expect(ramps[1].time).toBeGreaterThan(ramps[0].time!);
    });
    it('ooh swells quickly with the pitch sliding up, then settles back', () => {
      const { crowd, level, nodes } = setup();
      crowd.ooh();
      const ramps = level.calls.filter((c) => c.kind === 'linear');
      expect(ramps[0].value).toBeGreaterThan(0.25);
      expect(ramps[0].time! - 1).toBeLessThan(0.5);
      expect(ramps[1].value).toBeCloseTo(0.25, 5);
      const filter = nodes.find((n) => n.kind === 'filter')!;
      expect(filter.frequency.calls.some((c) => c.kind === 'exp' && c.value! > 900)).toBe(true);
    });
    it('a second start makes no second bed', () => {
      const { crowd, nodes } = setup();
      crowd.start();
      expect(nodes.filter((n) => n.kind === 'src').length).toBe(1);
      expect(nodes.filter((n) => n.kind === 'osc').length).toBe(1);
    });
    it('stop then start inside the fade lets the old bed go within the fade', () => {
      const { crowd, nodes } = setup();
      crowd.stop();
      crowd.start();
      const srcs = nodes.filter((n) => n.kind === 'src');
      expect(srcs.length).toBe(2);
      expect(srcs[0].stopped).toBeLessThanOrEqual(1.35 + 1e-9);
      expect(srcs[1].stopped).toBeNull();
    });
    it('aww sags the pitch and the level returns', () => {
      const { crowd, level, nodes } = setup();
      crowd.aww();
      expect(level.calls.filter((c) => c.kind === 'linear').length).toBeGreaterThanOrEqual(2);
      const filter = nodes.find((n) => n.kind === 'filter')!;
      expect(filter.frequency.calls.some((c) => c.kind === 'exp' && c.value! < 900)).toBe(true);
    });
    it('stop ends and frees the bed', () => {
      const { crowd, nodes } = setup();
      const srcs = nodes.filter((n) => n.kind === 'src' || n.kind === 'osc');
      crowd.stop();
      for (const s of srcs) {
        expect(s.stopped).not.toBeNull();
        s.end();
        expect(s.disconnected).toBe(true);
      }
    });
  });

  it('sounds before unlock make no nodes', () => {
    const { ctx, raw, nodes } = fakeCtx();
    raw.state = 'suspended';
    const sfx = createSfx(ctx, out());
    sfx.boing(1); sfx.bonk(); sfx.whoosh(); sfx.thud(); sfx.drumRoll(1); sfx.sting(); sfx.fanfare(); sfx.drum();
    expect(nodes.length).toBe(0);
  });

  it('drumRoll is capped at 6 seconds', () => {
    const { ctx, nodes } = fakeCtx();
    createSfx(ctx, out()).drumRoll(60);
    expect(nodes.find((n) => n.kind === 'src')!.stopped).toBeLessThan(1 + 6.1);
  });

  it('every sound and crowd move avoids ramping to zero', () => {
    const { ctx } = fakeCtx();
    const sfx = createSfx(ctx, out()), crowd = createCrowd(ctx, out());
    expect(() => {
      sfx.boing(0.45); sfx.boing(3.5); sfx.bonk(); sfx.whoosh(); sfx.thud(); sfx.drumRoll(3); sfx.sting(); sfx.fanfare(); sfx.drum();
      crowd.start(); crowd.swell(0, 1); crowd.swell(1, 1); crowd.roar(); crowd.aww(); crowd.rise(1); crowd.ooh(); crowd.stop();
    }).not.toThrow();
  });

  it('the voice bus reaches the arena compressor and reverb', () => {
    const { ctx } = fakeCtx();
    const mixer = createMixer(ctx);
    const kinds = new Set([...reach(mixer.voice as unknown as FakeNode)].map((n) => n.kind));
    expect(kinds.has('comp')).toBe(true);
    expect(kinds.has('conv')).toBe(true);
    expect(kinds.has('destination')).toBe(true);
  });

  it('the crowd bed uses its own longer noise buffer', () => {
    const { ctx, raw, nodes } = fakeCtx();
    createCrowd(ctx, out()).start();
    expect(nodes.find((n) => n.kind === 'src')!.buffer).toMatchObject({ length: 3 * raw.sampleRate });
  });

  it('the context is made lazily and unlock resumes it', () => {
    const { ctx, raw } = fakeCtx();
    raw.state = 'suspended';
    let made = 0;
    const audio = lazyAudio(() => { made++; return ctx; });
    expect(made).toBe(0);
    audio.unlock();
    audio.unlock();
    expect(made).toBe(1);
    expect(raw.state).toBe('running');
  });
});
