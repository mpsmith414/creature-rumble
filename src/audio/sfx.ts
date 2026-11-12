/**
 * Synthesised sound effects (no audio files). Each call builds its own nodes, schedules them to stop, and disconnects
 * everything when the last source ends, so nothing piles up on a long night.
 */

/** Boing pitch multiplier: bigger fighters boing lower (1 at about 2.56 m). */
export function pitchForSize(sizeM: number): number {
  return 1.6 / Math.sqrt(Math.max(0.05, sizeM));
}

/** A shared one-second white-noise buffer per context. */
const noiseCache = new WeakMap<object, Map<number, AudioBuffer>>();
export function noiseBuffer(ctx: BaseAudioContext, seconds = 1): AudioBuffer {
  let per = noiseCache.get(ctx);
  if (!per) noiseCache.set(ctx, (per = new Map()));
  let b = per.get(seconds);
  if (!b) {
    b = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    per.set(seconds, b);
  }
  return b;
}

export interface Sfx {
  boing(sizeM: number): void;
  bonk(): void;
  whoosh(): void;
  thud(): void;
  drumRoll(seconds: number): void;
  /** The hit on the name. */
  sting(): void;
  fanfare(): void;
}

type Source = OscillatorNode | AudioBufferSourceNode;

export function createSfx(ctx: AudioContext, out: AudioNode): Sfx {
  /** Disconnects every node once every source has ended. */
  const cleanup = (sources: Source[], nodes: AudioNode[]) => {
    let left = sources.length;
    for (const s of sources) {
      s.onended = () => {
        if (--left > 0) return;
        for (const n of [...sources, ...nodes]) n.disconnect();
      };
    }
  };
  const env = (g: GainNode, t: number, peak: number, attack: number, end: number) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + end);
  };
  const tone = (type: OscillatorType, t: number, f0: number, f1: number, dur: number, peak: number, attack = 0.005) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    env(g, t, peak, attack, dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.02);
    return { o, g };
  };
  const noise = (t: number, dur: number, type: BiquadFilterType, f0: number, f1: number, q: number, peak: number) => {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuffer(ctx);
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    env(g, t, peak, Math.min(0.01, dur / 4), dur);
    s.connect(f).connect(g).connect(out);
    s.start(t);
    s.stop(t + dur + 0.02);
    return { s, f, g };
  };

  const sounds: Sfx = {
    boing(sizeM) {
      const t = ctx.currentTime, p = pitchForSize(sizeM);
      const a = tone('triangle', t, 420 * p, 90 * p, 0.4, 0.5);
      const b = noise(t, 0.06, 'bandpass', 1800, 1800, 1, 0.4);
      cleanup([a.o, b.s], [a.g, b.f, b.g]);
    },
    bonk() {
      const t = ctx.currentTime;
      const a = tone('sine', t, 260, 110, 0.16, 0.6, 0.002);
      const b = tone('square', t, 520, 300, 0.05, 0.15, 0.002);
      const c = noise(t, 0.04, 'bandpass', 2200, 2200, 1, 0.3);
      cleanup([a.o, b.o, c.s], [a.g, b.g, c.f, c.g]);
    },
    whoosh() {
      const t = ctx.currentTime;
      const a = tone('sine', t, 900, 120, 0.9, 0.25, 0.03);
      const b = noise(t, 0.8, 'bandpass', 2500, 300, 0.8, 0.2);
      cleanup([a.o, b.s], [a.g, b.f, b.g]);
    },
    thud() {
      const t = ctx.currentTime;
      const a = tone('sine', t, 120, 45, 0.28, 0.8, 0.003);
      const b = noise(t, 0.08, 'lowpass', 500, 200, 0.7, 0.4);
      cleanup([a.o, b.s], [a.g, b.f, b.g]);
    },
    drumRoll(seconds) {
      const t = ctx.currentTime, dur = Math.min(6, Math.max(0.3, seconds));
      // One looping noise source whose gain is hit over and over, faster and louder towards the end.
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noiseBuffer(ctx);
      s.loop = true;
      f.type = 'lowpass';
      f.frequency.value = 700;
      g.gain.setValueAtTime(0.0001, t);
      let at = 0, gap = 0.12;
      while (at < dur - 0.05) {
        const peak = 0.15 + 0.45 * (at / dur);
        g.gain.setValueAtTime(0.0001, t + at);
        g.gain.linearRampToValueAtTime(peak, t + at + 0.01);
        g.gain.linearRampToValueAtTime(0.02, t + at + gap * 0.9);
        at += gap;
        gap = Math.max(0.035, gap * 0.93);
      }
      g.gain.setValueAtTime(0.0001, t + dur);
      s.connect(f).connect(g).connect(out);
      s.start(t);
      s.stop(t + dur + 0.02);
      cleanup([s], [f, g]);
    },
    sting() {
      const t = ctx.currentTime;
      const srcs: Source[] = [], nodes: AudioNode[] = [];
      for (const f of [392, 494, 587]) {
        const a = tone('square', t, f, f, 0.5, 0.12, 0.01);
        srcs.push(a.o);
        nodes.push(a.g);
      }
      const k = tone('sine', t, 160, 50, 0.3, 0.7, 0.003);
      const n = noise(t, 0.25, 'highpass', 3000, 3000, 0.7, 0.25);
      srcs.push(k.o, n.s);
      nodes.push(k.g, n.f, n.g);
      cleanup(srcs, nodes);
    },
    fanfare() {
      const t = ctx.currentTime;
      const srcs: Source[] = [], nodes: AudioNode[] = [];
      [523, 659, 784, 1047].forEach((f, i) => {
        const a = tone('square', t + i * 0.14, f, f, i === 3 ? 0.8 : 0.16, 0.12, 0.02);
        srcs.push(a.o);
        nodes.push(a.g);
      });
      cleanup(srcs, nodes);
    },
  };

  // Before the context is unlocked (or after it is closed) `onended` never fires, so nodes would pile up: stay silent.
  const guarded = {} as Sfx;
  for (const k of Object.keys(sounds) as (keyof Sfx)[]) {
    guarded[k] = ((...args: unknown[]) => {
      if (ctx.state === 'running') (sounds[k] as (...a: unknown[]) => void)(...args);
    }) as never;
  }
  return guarded;
}
