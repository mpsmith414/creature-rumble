// The TV page. It builds the mode-neutral core (renderer, stage, physics, sound, announcer, roster, phones, workshop)
// and hands it to the Rumble (`startRumble`), which owns the arena, the match and the show (spec §6.4).
// Dev only (left out of the build): `?dev=pose|arena|show|sound|cast|drawings` open the check pages instead, and `?dev` adds the
// tuning panel on top of the real TV (`&shot=entrance|fight|crown` saves a picture to .shots/).
import { PerspectiveCamera, Scene } from 'three/webgpu';
import { Announcer } from '../announcer/announcer';
import { VoiceClient } from '../announcer/voice';
import { createCrowd } from '../audio/crowd';
import { createMixer, lazyAudio } from '../audio/mixer';
import { createSfx } from '../audio/sfx';
import { createBring } from '../bring/bring';
import { joinCard } from '../bring/card';
import { createStudio } from '../bring/studio';
import { Workshop } from '../bring/workshop';
import { BuilderClient } from '../builder/client';
import { api } from '../designer/api';
import { designCreature, tweakCreature } from '../designer/loop';
import { TUNE } from '../fight/tune';
import { createWorld, initPhysics } from '../physics/world';
import { createRenderer } from '../render/renderer';
import { Roster } from '../roster/roster';
import { h } from '../shared/dom';
import { Banner } from '../show/banner';
import { Capsule } from '../show/capsule';
import { Pops } from '../show/pops';
import type { Core } from './core';
import './app.css';
import { capsuleUi, gatedVoice, localStore, memoryRoster, type RosterLike } from './wiring';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;
const params = new URLSearchParams(location.search);
const dev = import.meta.env.DEV ? params.get('dev') : null;

async function main(): Promise<void> {
  if (import.meta.env.DEV && dev === 'pose') {
    // the fighter fixtures standing in a row; &shot=1 saves .shots/fighters.png
    const { showPoses } = await import('../dev/pose');
    return showPoses(canvas, { shot: params.get('shot') === '1' });
  }
  if (import.meta.env.DEV && dev === 'arena') {
    // the candy ring with the fixtures in it; &shot=1 saves .shots/arena.png
    const { showArena } = await import('../dev/arena');
    return showArena(canvas, { shot: params.get('shot') === '1', fighters: params.get('fighters') !== '0' });
  }
  if (import.meta.env.DEV && dev === 'show') {
    // entrances, fight, crowning on the arena; &shot=1 saves .shots/show.png
    const { showShow } = await import('../dev/show');
    return showShow(canvas, ui, { shot: params.get('shot') === '1' });
  }
  if (import.meta.env.DEV && dev === 'cast') {
    // the valley's cast stood up as fighters, each beside its original build, from the side; &shot=1 saves .shots/cast.png
    const { showCast } = await import('../dev/cast');
    return showCast(canvas, { shot: params.get('shot') === '1' });
  }
  if (import.meta.env.DEV && dev === 'drawings') {
    // the drawing test set through the real designer (&passes=N); &shot=1 runs it all and saves .shots/drawings.png
    const { showDrawings } = await import('../dev/drawings');
    const asked = Number(params.get('passes') ?? 3);
    const passes = Number.isFinite(asked) ? Math.max(0, Math.min(5, Math.round(asked))) : 3;
    return showDrawings(canvas, { shot: params.get('shot') === '1', passes });
  }
  if (import.meta.env.DEV && dev === 'sound') {
    // a button per sound, crowd and duck toggles, a boing size slider
    const { showSound } = await import('../dev/sound');
    return showSound(ui);
  }
  const shot = import.meta.env.DEV && dev === '' ? params.get('shot') : null;

  // ---------- the stage ----------
  const [{ renderer }] = await Promise.all([createRenderer(canvas, 'high'), initPhysics()]);
  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 1, 0.1, 300);
  const fit = () => {
    let w = canvas.clientWidth, hh = canvas.clientHeight;
    if (!w || !hh) [w, hh] = [1280, 720]; // loaded while hidden: draw at a sensible size anyway
    renderer.setSize(w, hh, false);
    camera.aspect = w / hh;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', fit);
  fit();
  const world = createWorld(TUNE.gravity);

  // ---------- sound: made now, silent until the first key, remote press or click lets it play ----------
  const audio = lazyAudio();
  const ctx = audio.ctx();
  const mixer = createMixer(ctx), sfx = createSfx(ctx, mixer.sfx), crowd = createCrowd(ctx, mixer.crowd);
  const live = () => ctx.state === 'running';
  let crowdOn = false;
  const unlock = () => {
    audio.unlock();
    if (!crowdOn) {
      crowdOn = true;
      crowd.start();
    }
  };
  for (const ev of ['keydown', 'pointerdown'] as const) addEventListener(ev, unlock, { capture: true });
  ctx.addEventListener('statechange', () => {
    if (live()) for (const ev of ['keydown', 'pointerdown'] as const) removeEventListener(ev, unlock, { capture: true });
  });

  // ---------- words and voice ----------
  const banner = new Banner(ui);
  const pops = new Pops(ui, Math.random, () => banner.band());
  const voice = new VoiceClient({ fetch: (...a) => fetch(...a), ctx, out: mixer.voice });
  void voice.check();
  const announcer = new Announcer({
    voice: gatedVoice(voice, live), banner, mixer, sfx, crowd, rng: Math.random, now: () => performance.now(),
    store: localStore('rumble.recentLines'),
  });

  // ---------- the roster, the phones and the workshop ----------
  let roster: RosterLike;
  try {
    roster = await Roster.open();
  } catch (e) {
    console.warn('the roster cannot be kept in this browser; tonight only', e);
    roster = memoryRoster();
  }
  const bring = createBring(joinCard(ui));
  const builder = new BuilderClient();
  const capsule = new Capsule(ui);
  // the studio renders the designer's look-again pictures off-screen: the fight stays full-screen (spec §2.12)
  const offstage = h('div', { class: 'rm-offstage', 'aria-hidden': 'true' });
  document.body.append(offstage);
  const shopUi = capsuleUi(capsule, {
    makeStudio: () => createStudio(offstage, 'high'),
    oops: (text) => banner.show(text, '', 3),
  });
  const workshop = new Workshop({
    design: designCreature, tweak: tweakCreature, api, build: (r) => builder.build(r), studio: shopUi.studio,
    send: (t, m) => bring.send(t, m), ui: shopUi, now: () => performance.now(),
  });

  const core: Core = {
    renderer, scene, camera, world, mixer, sfx, crowd, announcer, roster, bring, workshop, banner, pops,
    ui, build: (r) => builder.build(r), capsule, audio: { live },
  };
  const { startRumble } = await import('./rumble');
  const rumble = await startRumble(core);

  // the phones: hosting starts once the TV is up; the join card shows from the start (the menu can hide it)
  void bring.start();
  if (!shot) bring.toggle();

  if (import.meta.env.DEV && dev === '') {
    const { devPanel } = await import('./dev');
    devPanel(ui, canvas, rumble, { shot, build: core.build });
  }
}

main().catch((e) => {
  console.error('the TV could not start', e);
  ui.append(h('div', { class: 'rm-fatal', role: 'alert' }, 'The ring could not start on this screen. Try reloading the page.'));
});
