/**
 * The arena sound for the announcer: squashed and brightened like a PA system, with a stadium's tail and a slapback echo.
 * Built from Web Audio nodes only; the reverb's impulse response is made here, so no audio files are needed.
 */

/** A stereo impulse response of decaying noise: `seconds` long, falling off as `exp(-decay * t)`. */
export function arenaImpulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.round(seconds * rate));
  const buf = ctx.createBuffer(2, length, rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp((-decay * i) / rate);
  }
  return buf;
}

/**
 * Compressor (-18 dB, 4:1) -> high shelf (+4 dB at 3 kHz) -> dry + reverb (1.8 s, wet 0.35) + slapback (0.11 s, feedback 0.25,
 * wet 0.2) -> `out`. Feed `input`; `setWet(w)` scales the reverb and slapback together (1 is as designed, 0 is dry only).
 */
export function arenaChain(ctx: BaseAudioContext, out: AudioNode): { input: AudioNode; setWet(w: number): void } {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.ratio.value = 4;
  const shelf = ctx.createBiquadFilter();
  shelf.type = 'highshelf';
  shelf.frequency.value = 3000;
  shelf.gain.value = 4;
  comp.connect(shelf);

  shelf.connect(out); // dry

  const verb = ctx.createConvolver();
  verb.buffer = arenaImpulse(ctx, 1.8, 3);
  const verbWet = ctx.createGain();
  verbWet.gain.value = 0.35;
  shelf.connect(verb);
  verb.connect(verbWet);
  verbWet.connect(out);

  const delay = ctx.createDelay(0.5);
  delay.delayTime.value = 0.11;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.25;
  delay.connect(feedback);
  feedback.connect(delay);
  const slapWet = ctx.createGain();
  slapWet.gain.value = 0.2;
  shelf.connect(delay);
  delay.connect(slapWet);
  slapWet.connect(out);

  return {
    input: comp,
    setWet(w) {
      const k = Math.max(0, w);
      verbWet.gain.value = 0.35 * k;
      slapWet.gain.value = 0.2 * k;
    },
  };
}
