import { describe, expect, it } from 'vitest';
import { arenaImpulse } from '../../src/audio/chain';

/** A context with just enough to build an impulse: a sample rate and `createBuffer`. */
function fakeCtx(sampleRate: number) {
  return {
    sampleRate,
    createBuffer(channels: number, length: number, rate: number) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { duration: length / rate, numberOfChannels: channels, length, sampleRate: rate, getChannelData: (c: number) => data[c] };
    },
  } as unknown as BaseAudioContext;
}

function rms(b: AudioBuffer, from: number, to: number): number {
  const d = b.getChannelData(0);
  const a = Math.floor(from * b.sampleRate), z = Math.min(d.length, Math.floor(to * b.sampleRate));
  let s = 0;
  for (let i = a; i < z; i++) s += d[i] * d[i];
  return Math.sqrt(s / (z - a));
}

describe('arena impulse', () => {
  it('decays', () => {
    const ir = arenaImpulse(fakeCtx(24000), 1.8, 3);
    expect(ir.duration).toBeCloseTo(1.8, 1);
    expect(ir.numberOfChannels).toBe(2);
    expect(rms(ir, 0, 0.1)).toBeGreaterThan(rms(ir, 1.6, 1.8) * 10);
  });
  it('the two channels differ (stereo width)', () => {
    const ir = arenaImpulse(fakeCtx(24000), 0.5, 3);
    expect(Array.from(ir.getChannelData(0).slice(0, 50))).not.toEqual(Array.from(ir.getChannelData(1).slice(0, 50)));
  });
});
