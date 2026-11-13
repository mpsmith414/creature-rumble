import { Vector3 } from 'three/webgpu';
import { createArena, type Arena } from '../arena/arena';
import { connectWorkshop, sendEnd, TRY_AGAIN, type Made } from '../bring/workshop';
import type { BodyData } from '../builder/build';
import { bodyCacheKey, loadBody } from '../builder/cache';
import { TUNE } from '../fight/tune';
import { Match } from '../match/match';
import type { FighterObject } from '../render/fighter-object';
import { createFighterObject } from '../render/fighter-object';
import { compileTogether } from '../render/compile';
import { planFor } from '../fight/moves';
import { ragdollLayout } from '../physics/layout';
import type { Recipe } from '../recipe/schema';
import warmUpFighter from '../fixtures/fighters/fists.json';
import { driveBones } from '../render/drive';
import { setGlow } from '../render/toon';
import type { RosterItem } from '../roster/roster';
import { h } from '../shared/dom';
import { Input } from '../shared/input';
import { remember, stored } from '../shared/settings';
import { CameraDirector, facingYaw } from '../show/camera';
import { Entrance } from '../show/entrance';
import { Finale } from '../show/finale';
import { TA_DA } from '../show/pops';
import { SlowMo } from '../show/slowmo';
import { Shockwaves } from '../show/shockwave';
import { DizzyStars } from '../show/stars';
import { Trails } from '../show/trails';
import type { Core } from './core';
import { RingLoop } from './loop';
import { menuControl } from './menu-control';
import { openMenu, type FighterRow, type MenuState, type RumbleMenu } from './menu';
import { RumbleShow, type Card } from './show';
import { handleCommand, keepMade, RingBroadcast, sendBack } from './wiring';


/** What the Rumble hands back (the dev panel and its shots drive it through this). */
export type RumbleApi = {
  show: RumbleShow<FighterObject>; match: Match; loop: RingLoop; arena: Arena; entrance: Entrance; world: Core['world'];
  /** Learn a creature and send it in (an entrance follows). */
  enter(card: Card): void;
  /** Learn creatures and stand them in the ring at once (no entrances). */
  quickFill(cards: Card[]): void;
  crown(): boolean;
  again(): boolean;
  reset(): void;
  /** Is the TV menu open (the dev keys keep out of its way)? */
  menuOpen(): boolean;
  /** Runs after every frame is drawn, in the same task (a page shot reads the canvas there). Returns the way to stop. */
  onFrame(fn: () => void): () => void;
};

/** Seconds of show clock; the frame is capped so a stalled tab does not leap. */
const MAX_FRAME = 0.05;
/** A failing frame is logged at most this often (s). */
const ERROR_LOG_S = 5;
/** Volume as the menu sets it (0 … 1) to the master gain (the mixer's own level). */
const MASTER = 0.9;

/**
 * The Rumble on the TV (spec §2): the arena, the match, the fight loop, entrances, the finale and the TV menu, on the
 * mode-neutral core. Phones send fighters in (release → roster → ring), crown champions and call Again!; the menu does
 * the same from the remote. The start screen ("ADD A CREATURE!" and the join card) shows while the ring is empty.
 */
export async function startRumble(core: Core): Promise<RumbleApi> {
  const { renderer, scene, camera, world, sfx, crowd, announcer, roster, bring, workshop, banner, pops, ui, capsule } = core;
  const R = TUNE.ringRadius;
  const arena = createArena(scene, world, TUNE); // adds the ring's colliders too
  const match = new Match();
  const slow = new SlowMo();
  const stars = new DizzyStars(scene, TUNE);
  const trails = new Trails(scene), shockwaves = new Shockwaves(scene);
  const finale = new Finale(scene, { ringRadius: R });
  const director = new CameraDirector({ ringRadius: R, bumper: TUNE.bumper, fov: camera.fov });
  director.cut();
  const entrance = new Entrance(arena, TUNE, (cue) => {
    if (cue.type === 'taDa') pops.pop(cue.at, camera, TA_DA, 1.4);
  });
  const loop = new RingLoop({ world, match, slowmo: slow, tune: TUNE, entrance });
  // a crowning changes the roster (one more crown): the phones hear it once it is saved
  const showRoster = {
    fought: (ids: string[]) => roster.fought(ids),
    crowned: async (id: string) => {
      await roster.crowned(id);
      void broadcast.push();
    },
  };
  const show = new RumbleShow<FighterObject>({
    world, tune: TUNE, rng: Math.random, match, loop, slow, camera, entrance, finale, stars, pops, banner, announcer, sfx, crowd, roster: showRoster,
    director, trails, shockwaves,
    objects: {
      make(c, layout) {
        const o = createFighterObject(c.body, c.recipe, layout);
        scene.add(o.root);
        return o;
      },
      drive: (o, f, dt) => driveBones(o, f.ragdoll, dt),
      glow: (o, level) => setGlow(o.mesh, level),
      dispose(o) {
        scene.remove(o.root);
        o.dispose();
      },
    },
  });

  // ---------- the phones: the ring on every phone, their commands, their creatures ----------
  const broadcast = new RingBroadcast({
    state: () => ({ phase: match.phase, fighting: match.fighting.length }),
    roster: () => roster.summaries(),
    send: (phase, fighting, entries) => bring.sendRing(phase, fighting, entries),
  });
  bring.onStatus((s, fresh) => {
    if (s === 'hosting' && fresh) void broadcast.push(false); // a new relay: the same ring and roster, sent again
  });
  const cardOf = (item: RosterItem, body: BodyData): Card => ({
    id: item.id, recipe: item.recipe, body, maker: item.maker.name || null, name: item.cards.name || item.recipe.name,
  });
  const sendBackIn = (id: string) => sendBack(id, {
    known: (i) => show.known(i), // already in the ring or on deck: no body is loaded or built
    get: (i) => roster.get(i),
    cached: (r) => loadBody(bodyCacheKey(r)),
    build: (r) => core.build(r),
    arrive(item, body) {
      if (show.known(item.id)) return; // already in the ring or on deck
      show.register(cardOf(item, body));
      show.arrive([item.id]);
    },
  });
  bring.onCommand((_token, cmd) => handleCommand(cmd, {
    phase: () => match.phase, fighting: () => match.fighting.length,
    crown: () => show.crown(), again: () => show.again(), sendBack: sendBackIn,
  }));

  type Outcome = 'released' | 'kept' | 'failed';
  /** Tell the phone how its turn ended (`failed` with Try again when nothing could be kept); once more if it did not go. */
  const tell = (token: string, o: Outcome) =>
    sendEnd((t, m) => bring.send(t, m), token, o === 'failed' ? { type: 'failed', message: TRY_AGAIN, retry: true } : { type: o });
  connectWorkshop(bring, workshop, {
    /** "Send to the ring!": kept in the roster, its intro fetched now, then into the ring (an entrance, or on deck). */
    async onRelease(made: Made) {
      let outcome: Outcome = 'failed';
      try {
        await keepMade(made, {
          check: (m) => void RumbleShow.check(m.recipe, m.body), // a creature that cannot fight is never kept broken
          add: (m) => roster.add(m, Date.now()),
          enter(item) {
            show.register(cardOf(item, made.body));
            show.arrive([item.id]);
          },
        });
        outcome = 'released';
        void broadcast.push();
      } catch (e) {
        console.error('release: the creature could not be kept', e);
        banner.show(TRY_AGAIN, '', 3);
      }
      await tell(made.token, outcome);
    },
    /** "Save for later" (or a turn closed some other way): into the roster only. */
    async onKept(made: Made) {
      let outcome: Outcome = 'kept';
      try {
        await keepMade(made, { check: (m) => void RumbleShow.check(m.recipe, m.body), add: (m) => roster.add(m, Date.now()) });
        void broadcast.push();
      } catch (e) {
        console.error('workshop: the creature could not be kept', e);
        outcome = 'failed';
      }
      await tell(made.token, outcome);
    },
  });

  // ---------- the TV menu (Enter or Menu opens it, Back or Esc closes it) ----------
  const vol = { volume: stored('rumble.volume', 0.8), muted: stored('rumble.muted', false) };
  const applyVolume = () => {
    core.mixer.master.gain.value = vol.muted ? 0 : MASTER * Math.min(1, Math.max(0, vol.volume));
  };
  applyVolume();
  const menuState = (): MenuState => ({ phase: match.phase, fighting: match.fighting.length, joinShown: bring.cardShown, ...vol });
  const fighters = async (): Promise<FighterRow[]> =>
    (await roster.summaries()).map((s) => ({ ...s, inRing: show.known(s.id) }));
  const control = menuControl({
    ui,
    waiting: () => false,
    open: (root, close) => openMenu(root, menuState(), {
      crown: () => void show.crown(),
      again: () => void show.again(),
      fighters,
      sendBack: (id) => void sendBackIn(id).catch((e) => console.warn('send back failed', e)),
      join: () => {
        bring.toggle();
        refreshMenu();
      },
      volume: (d) => {
        vol.volume = Math.round(Math.min(1, Math.max(0, vol.volume + d)) * 10) / 10;
        vol.muted = false;
        remember('rumble.volume', vol.volume);
        remember('rumble.muted', false);
        applyVolume();
        refreshMenu();
      },
      mute: () => {
        vol.muted = !vol.muted;
        remember('rumble.muted', vol.muted);
        applyVolume();
        refreshMenu();
      },
      clear: () => show.reset(),
    }, close),
  });
  let menuKey = '';
  const refreshMenu = () => {
    const m = control.open as RumbleMenu | null;
    const s = menuState();
    menuKey = `${s.phase}|${s.fighting > 0}`;
    m?.update(s);
  };
  const input = new Input();
  input.onPress = (b, repeat) => {
    if (control.press(b, repeat)) return;
    if (b === 'a' && !repeat) control.show();
  };
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.key === 'ContextMenu') { // the remote's Menu key
      e.preventDefault();
      if (control.open) control.close();
      else control.show();
    } else if ((e.key === 'GoBack' || e.key === 'BrowserBack') && control.open) { // the remote's Back key
      e.preventDefault();
      control.press('b');
    }
  });

  // ---------- the start screen: "ADD A CREATURE!" (the join card shows beside it) ----------
  const soundHint = h('div', { class: 'rm-start-hint rm-start-sound' }, '🔊 Press any button for sound');
  const start = h('div', { class: 'rm-start', role: 'status' },
    h('div', { class: 'rm-start-title' }, 'ADD A CREATURE!'),
    h('div', { class: 'rm-start-hint' }, 'Scan the code with a phone and draw a fighter'),
    soundHint,
    h('div', { class: 'rm-start-keys' }, 'Enter: menu'));
  ui.append(start);

  // ---------- the frame ----------
  const hooks = new Set<() => void>();
  const champAt = new Vector3(), ramp = arena.entry.dir.clone().multiplyScalar(R + 2.5).setY(0.6);
  let clock = 0, last = performance.now(), loggedAt = -Infinity;
  shockwaves.spawn(champAt, 1); // shown while the scene compiles, so the first special's shockwave does not hitch
  await renderer.compileAsync(scene, camera);
  shockwaves.clear();
  void warmFighterShaders(core);
  renderer.setAnimationLoop((now: number) => {
    const dt = Math.min(MAX_FRAME, Math.max(0, (now - last) / 1000));
    last = now;
    clock += dt;
    input.poll(dt, !!control.open);
    try {
      show.frame(dt, clock);
    } catch (e) {
      // the night goes on: the next frame tries again; the error is logged at most every 5 s
      if (clock - loggedAt >= ERROR_LOG_S) {
        loggedAt = clock;
        console.error('the ring loop failed this frame', e);
      }
    }
    broadcast.watch();
    const s = menuState();
    if (control.open && `${s.phase}|${s.fighting > 0}` !== menuKey) refreshMenu();

    arena.update(dt);
    const champ = show.champion;
    if (champ && champ.ragdoll.pieces.length) {
      const p = champ.ragdoll.torso.body.translation();
      director.champion(dt, champAt.set(p.x, 0, p.z), champ.layout.ringHeight, facingYaw(champ.ragdoll.torso));
    } else if (entrance.active) director.entrance(dt, entrance.focus, arena.entry.dir, entrance.height, entrance.lift, entrance.side);
    else director.wide(dt, loop.all().filter((f) => f.state === 'fighting'));
    director.apply(camera);
    capsule.update(camera, ramp);
    start.hidden = !(match.phase === 'open' && !match.fighting.length && !match.entering.length && !match.onDeck.length && !workshop.busy);
    soundHint.hidden = core.audio.live();
    renderer.render(scene, camera);
    for (const fn of hooks) fn();
  });

  return {
    show, match, loop, arena, entrance, world,
    enter(card) {
      show.register(card);
      show.arrive([card.id]);
    },
    quickFill(cards) {
      for (const c of cards) show.register(c);
      show.quickFill(cards.map((c) => c.id));
    },
    crown: () => show.crown(),
    again: () => show.again(),
    reset: () => show.reset(),
    menuOpen: () => !!control.open,
    onFrame(fn) {
      hooks.add(fn);
      return () => void hooks.delete(fn);
    },
  };
}

/**
 * Compiles a fighter's shaders once at start-up (one fixture's body, laid out, compiled detached but lit by the scene,
 * then thrown away), so the first creature to enter does not stall its entrance while the GPU compiles. In the
 * background: nothing waits for it, and a failure only means the first entrance may hitch.
 */
async function warmFighterShaders(core: Core): Promise<void> {
  try {
    const recipe = structuredClone(warmUpFighter) as Recipe;
    const body = await core.build(recipe);
    const plan = planFor(recipe, body.skeleton);
    const obj = createFighterObject(body, recipe, ragdollLayout(body.skeleton, plan));
    try {
      await compileTogether(core.renderer, obj.root, core.camera, core.scene);
    } finally {
      obj.dispose();
    }
  } catch (e) {
    console.warn('could not warm the fighter shaders', e);
  }
}
