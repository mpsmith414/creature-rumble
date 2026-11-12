/**
 * The mixer: one master gain and a bus each for sound effects, crowd, announcer voice and music.
 * The voice bus runs through the arena chain (PA squash, reverb, slapback) on its way to master.
 */
import { arenaChain } from './chain';

export const DUCK_DB = -10;
export const DUCK_SECONDS = 0.15;
const duckGain = Math.pow(10, DUCK_DB / 20);

export interface Mixer {
  master: GainNode;
  sfx: GainNode;
  crowd: GainNode;
  voice: GainNode;
  music: GainNode;
  /** Crowd -10 dB (0.15 s time constant) while the voice speaks; back to 0 dB when it stops. */
  duckForVoice(on: boolean): void;
}

export function createMixer(ctx: AudioContext): Mixer {
  const bus = (out: AudioNode, level = 1): GainNode => {
    const g = ctx.createGain();
    g.gain.value = level;
    g.connect(out);
    return g;
  };
  const master = bus(ctx.destination, 0.9);
  const sfx = bus(master, 0.8);
  const crowd = bus(master);
  const music = bus(master, 0.7);
  const voice = ctx.createGain();
  voice.gain.value = 1;
  voice.connect(arenaChain(ctx, master).input);
  return {
    master, sfx, crowd, voice, music,
    duckForVoice(on) {
      crowd.gain.setTargetAtTime(on ? duckGain : 1, ctx.currentTime, DUCK_SECONDS);
    },
  };
}

/** An AudioContext made on first use. Browsers keep it suspended until a user gesture: call `unlock()` from one. */
export function lazyAudio(make: () => AudioContext = () => new AudioContext()): { ctx(): AudioContext; unlock(): void; made(): boolean } {
  let c: AudioContext | null = null;
  const get = () => (c ??= make());
  return {
    ctx: get,
    made: () => c !== null,
    unlock() {
      const a = get();
      if (a.state !== 'running') a.resume().catch(() => {});
    },
  };
}
