/**
 * The crowd: one looping bed of band-passed noise with a slow amplitude wobble, plus swells, roars and an "aww".
 * The bed buffer is made once; start/stop only create and drop a source.
 */
import { noiseBuffer } from './sfx';

const REST = 0.25; // level of the bed with nothing happening
const LOUD = 1.0;
/** How loud the crowd gets as a special winds up, and in an "ooh" at a big launch. */
const RISE = 0.8, OOH = 0.7;

export interface Crowd {
  start(): void;
  stop(): void;
  /** Rise (or fall) to `level` 0..1 of the bed's full volume over `seconds`, and stay there. */
  swell(level: number, seconds: number): void;
  /** After names and ring-outs: a quick surge, then back to the resting bed. */
  roar(): void;
  /** For a tie: a sag in volume with the crowd's pitch sliding down. */
  aww(): void;
  /** A special winding up: the crowd rises for `seconds`, then (with no roar to take over) settles back. */
  rise(seconds: number): void;
  /** A fighter launched high: a quick rising "ooh", then back to the resting bed. */
  ooh(): void;
}

export function createCrowd(ctx: AudioContext, out: AudioNode): Crowd {
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 900;
  filter.Q.value = 0.5;
  const wobble = ctx.createGain(); // the slow wobble modulates this one
  wobble.gain.value = 0.7;
  const level = ctx.createGain();
  level.gain.value = 0;
  filter.connect(wobble);
  wobble.connect(level);
  level.connect(out);

  let src: AudioBufferSourceNode | null = null, lfo: OscillatorNode | null = null, lfoDepth: GainNode | null = null;
  let rest = REST;

  /** Starts a fresh schedule on the level from where it is now. */
  const from = () => {
    const now = ctx.currentTime;
    level.gain.cancelScheduledValues(now);
    level.gain.setValueAtTime(level.gain.value, now);
    return now;
  };

  return {
    start() {
      if (src) return;
      src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx, 3);
      src.loop = true;
      src.connect(filter);
      lfo = ctx.createOscillator();
      lfo.frequency.value = 0.4;
      lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0.3;
      lfo.connect(lfoDepth);
      lfoDepth.connect(wobble.gain);
      src.start();
      lfo.start();
      level.gain.linearRampToValueAtTime(rest, from() + 1);
    },
    stop() {
      if (!src || !lfo || !lfoDepth) return;
      const s = src, l = lfo, d = lfoDepth;
      src = lfo = lfoDepth = null;
      const now = from();
      level.gain.linearRampToValueAtTime(0, now + 0.3);
      s.stop(now + 0.35);
      l.stop(now + 0.35);
      s.onended = () => s.disconnect();
      l.onended = () => {
        l.disconnect();
        d.disconnect();
      };
    },
    swell(l, seconds) {
      rest = REST + (LOUD - REST) * Math.min(1, Math.max(0, l));
      level.gain.linearRampToValueAtTime(rest, from() + Math.max(0.01, seconds));
    },
    roar() {
      const now = from();
      level.gain.linearRampToValueAtTime(LOUD, now + 0.35);
      level.gain.linearRampToValueAtTime(rest, now + 3);
      filter.frequency.cancelScheduledValues(now);
      filter.frequency.setValueAtTime(900, now);
      filter.frequency.linearRampToValueAtTime(1300, now + 0.35);
      filter.frequency.linearRampToValueAtTime(900, now + 3);
    },
    rise(seconds) {
      const s = Math.min(4, Math.max(0.2, seconds)), now = from();
      level.gain.linearRampToValueAtTime(RISE, now + s);
      level.gain.linearRampToValueAtTime(rest, now + s + 1.5);
      filter.frequency.cancelScheduledValues(now);
      filter.frequency.setValueAtTime(900, now);
      filter.frequency.linearRampToValueAtTime(1150, now + s);
      filter.frequency.linearRampToValueAtTime(900, now + s + 1.5);
    },
    ooh() {
      const now = from();
      level.gain.linearRampToValueAtTime(OOH, now + 0.3);
      level.gain.linearRampToValueAtTime(rest, now + 2);
      filter.frequency.cancelScheduledValues(now);
      filter.frequency.setValueAtTime(700, now);
      filter.frequency.exponentialRampToValueAtTime(1500, now + 0.6);
      filter.frequency.linearRampToValueAtTime(900, now + 2);
    },
    aww() {
      const now = from();
      level.gain.linearRampToValueAtTime(rest * 0.5, now + 0.2);
      level.gain.linearRampToValueAtTime(rest, now + 1.6);
      filter.frequency.cancelScheduledValues(now);
      filter.frequency.setValueAtTime(900, now);
      filter.frequency.exponentialRampToValueAtTime(350, now + 1.2);
      filter.frequency.linearRampToValueAtTime(900, now + 2);
    },
  };
}
