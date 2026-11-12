// Dev only (`/?dev=sound`): a button per sound, a crowd toggle, a duck toggle and a size slider for the boing, to audition by ear.
import { Announcer, introText, type Beat } from '../announcer/announcer';
import { VoiceClient } from '../announcer/voice';
import { Banner } from '../show/banner';
import { createCrowd } from '../audio/crowd';
import { createMixer, lazyAudio } from '../audio/mixer';
import { createSfx } from '../audio/sfx';

export function showSound(ui: HTMLElement): void {
  const audio = lazyAudio();
  let parts: ReturnType<typeof build> | null = null;
  const build = () => {
    const ctx = audio.ctx();
    const mixer = createMixer(ctx);
    return { ctx, mixer, sfx: createSfx(ctx, mixer.sfx), crowd: createCrowd(ctx, mixer.crowd) };
  };
  const get = () => {
    audio.unlock(); // inside a click, so the browser lets it play
    return (parts ??= build());
  };

  ui.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;padding:24px;align-content:flex-start;color:#fff;font-size:20px';
  const add = <K extends keyof HTMLElementTagNameMap>(tag: K, text = ''): HTMLElementTagNameMap[K] => {
    const el = document.createElement(tag);
    el.textContent = text;
    ui.appendChild(el);
    return el;
  };
  const button = (label: string, fn: () => void) => {
    const b = add('button', label);
    b.style.cssText = 'font:inherit;padding:12px 20px;border-radius:12px;border:0;background:#ffe14d;color:#14405c;cursor:pointer';
    b.onclick = fn;
  };

  const sizeRow = add('label', 'Boing size: ');
  sizeRow.style.cssText = 'flex-basis:100%';
  const size = document.createElement('input');
  size.type = 'range';
  size.min = '0.45';
  size.max = '3.5';
  size.step = '0.05';
  size.value = '1.2';
  const sizeText = document.createElement('span');
  const showSize = () => (sizeText.textContent = ` ${(+size.value).toFixed(2)} m`);
  size.oninput = showSize;
  showSize();
  sizeRow.append(size, sizeText);

  button('Boing', () => get().sfx.boing(+size.value));
  button('Bonk', () => get().sfx.bonk());
  button('Whoosh', () => get().sfx.whoosh());
  button('Thud', () => get().sfx.thud());
  button('Drum roll (2 s)', () => get().sfx.drumRoll(2));
  button('Sting', () => get().sfx.sting());
  button('Fanfare', () => get().sfx.fanfare());
  button('Swell', () => get().crowd.swell(0.7, 1.5));
  button('Calm', () => get().crowd.swell(0, 1.5));
  button('Roar', () => get().crowd.roar());
  button('Aww', () => get().crowd.aww());

  const toggle = (label: string, fn: (on: boolean) => void) => {
    let on = false;
    const b = add('button', `${label}: off`);
    b.style.cssText = 'font:inherit;padding:12px 20px;border-radius:12px;border:0;background:#3ec7ff;color:#14405c;cursor:pointer';
    b.onclick = () => {
      on = !on;
      b.textContent = `${label}: ${on ? 'on' : 'off'}`;
      fn(on);
    };
  };
  toggle('Crowd bed', (on) => (on ? get().crowd.start() : get().crowd.stop()));
  toggle('Voice duck', (on) => get().mixer.duckForVoice(on));

  // The announcer with the real voice (needs the home server's voice route). A line speaks only once its audio is decoded, so the
  // first press of a beat is words only and warms a few lines; press again a few seconds later to hear one.
  const voiceNote = add('div', 'Announcer: press a beat (first press may be words only while the voice loads).');
  voiceNote.style.cssText = 'flex-basis:100%;margin-top:12px';
  let announcer: Announcer | null = null;
  const announce = () => {
    if (announcer) return announcer;
    const p = get();
    const voice = new VoiceClient({ fetch: (...a) => fetch(...a), ctx: p.ctx, out: p.mixer.voice });
    void voice.check().then(() => (voiceNote.textContent = `Announcer voice: ${voice.available === 'yes' ? 'available' : 'not available (words only)'}`));
    return (announcer = new Announcer({ voice, banner: new Banner(document.body), mixer: p.mixer, sfx: p.sfx, crowd: p.crowd, rng: Math.random, now: () => performance.now() }));
  };
  const names = { name: 'Sir Bounces', other: 'Captain Wobble', names: 'Sir Bounces and Captain Wobble', maker: 'Pickle', weight: 'two buckets' };
  const beats: Beat[] = ['intro', 'groupIntro', 'hit', 'bigHit', 'ringOut', 'holdsRing', 'lone', 'tie', 'crown', 'again'];
  for (const beat of beats) {
    button(`Say: ${beat}`, () => {
      const a = announce();
      if (beat === 'intro') a.prefetch(introText(undefined, names));
      else a.warm(beat, names, 4);
      a.say(beat, names, { priority: true });
    });
  }
}
