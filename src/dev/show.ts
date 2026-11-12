// Dev only (`/?dev=show`): the show running on the real arena with fixture fighters, to check it by eye. A "coming soon"
// capsule, one solo entrance into the empty ring (the lone fighter then boasts), a group entrance of three that freezes
// it mid-strut, a short fight (comic pops, dizzy stars, slow-mo on a big launch, BYE BYE on a ring-out), then the
// crowning. `&shot=1` saves the solo show-off at the top of its jump, with the banner over it, as .shots/show.png
// (/__shot).
import { PerspectiveCamera, Scene, Vector3 } from 'three/webgpu';
import { createArena } from '../arena/arena';
import type { BodyData } from '../builder/build';
import { BuilderClient } from '../builder/client';
import { Fighter, type FightCtx } from '../fight/fighter';
import { planFor } from '../fight/moves';
import { TUNE } from '../fight/tune';
import { isOut, Match, type MatchEvent } from '../match/match';
import { ragdollLayout } from '../physics/layout';
import { createWorld, initPhysics } from '../physics/world';
import type { Recipe } from '../recipe/schema';
import { driveBones } from '../render/drive';
import { createFighterObject, type FighterObject } from '../render/fighter-object';
import { createRenderer } from '../render/renderer';
import { Banner } from '../show/banner';
import { CameraDirector, facingYaw } from '../show/camera';
import { Capsule } from '../show/capsule';
import { Entrance, setFrozen, type EntranceCue } from '../show/entrance';
import { Finale } from '../show/finale';
import { fillIntro, makerName } from '../show/intro';
import { BYE_BYE, Pops, TA_DA } from '../show/pops';
import { bigLaunch, SlowMo } from '../show/slowmo';
import { DizzyStars } from '../show/stars';
import { entranceAt } from '../show/timeline';
import { mulberry32 } from '../util/rng';
import { fixtures } from './pose';

const DT = 1 / 60;
const KINDS = ['fists', 'legs', 'tiny', 'blob', 'wings', 'tail', 'horns'];
/** Who made each (the solo one has a maker; the blob has none, so it shows "a mystery maker"). */
const MAKERS: Record<string, string | null> = { horns: 'Pickle', fists: 'Sam', blob: null, tiny: 'Captain Doodle' };
/** The blob starts this wobbly, so its dizzy stars show in the fight (dev only). */
const BLOB_WOBBLE = 14;
/** `&shot=1` saves the frame where the show-off jump is this near its top (0 … 1). */
const SHOT_AT = 0.985;

type Cast = { f: Fighter; obj: FighterObject; recipe: Recipe; outAt: number };

export async function showShow(canvas: HTMLCanvasElement, ui: HTMLElement, opts: { shot: boolean }): Promise<void> {
  const [{ renderer }] = await Promise.all([createRenderer(canvas, 'high'), initPhysics()]);
  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 1, 0.1, 300);
  const fit = () => {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    camera.aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', fit);
  fit();

  const world = createWorld(TUNE.gravity);
  const arena = createArena(scene, world, TUNE); // adds the ring's colliders too
  const R = TUNE.ringRadius;
  const banner = new Banner(ui), pops = new Pops(ui, Math.random, () => banner.band()), capsule = new Capsule(ui);
  const director = new CameraDirector({ ringRadius: R, bumper: TUNE.bumper, fov: camera.fov });
  director.cut();
  const slow = new SlowMo(), stars = new DizzyStars(scene, TUNE), finale = new Finale(scene, { ringRadius: R });
  const match = new Match();
  const rng = mulberry32(12);
  const cast = new Map<string, Cast>();
  const nameOf = (f: Fighter) => cast.get(f.id)!.recipe.name.toUpperCase();

  const recipes = fixtures().slice(0, KINDS.length);
  const builder = new BuilderClient();
  const bodies = new Map<string, { body: BodyData; recipe: Recipe }>();
  (await Promise.all(recipes.map((r) => builder.build(r)))).forEach((body, i) => bodies.set(KINDS[i], { body, recipe: recipes[i] }));

  const entrance = new Entrance(arena, TUNE, (cue) => onCue(cue));
  function onCue(cue: EntranceCue): void {
    if (cue.type === 'taDa') { pops.pop(cue.at, camera, TA_DA, 1.4); return; }
    if (cue.type === 'done') return;
    if (cue.fighters.length === 1) {
      const f = cue.fighters[0];
      if (cue.type === 'maker') banner.show(`From the bedroom of ${makerName(MAKERS[f.id])}…`, `weighing in at ${f.plan.weight}!`, 0);
      else banner.show(nameOf(f), fillIntro(f.plan.intro, MAKERS[f.id]), 4.6);
    } else {
      banner.show('HERE THEY COME!', cue.fighters.map(nameOf).join(' · '), 4.5);
    }
  }

  function spawn(id: string): Fighter {
    const { body, recipe } = bodies.get(id)!;
    const plan = planFor(recipe, body.skeleton);
    const layout = ragdollLayout(body.skeleton, plan);
    const f = new Fighter(id, world, layout, plan, { tune: TUNE, rng });
    if (id === 'blob') f.wobble = BLOB_WOBBLE;
    const obj = createFighterObject(body, recipe, layout);
    scene.add(obj.root);
    cast.set(id, { f, obj, recipe, outAt: 0 });
    return f;
  }

  // ---- the script: each step waits for its moment ----
  let clock = 0, sim = 0, acc = 0, mark = 0, crowned: Fighter | null = null, shotTaken = !opts.shot;
  const steps: { when: () => boolean; then: () => void }[] = [
    { when: () => clock > 0.5, then: () => capsule.set({ name: 'Pickle', badge: '🦊' }, false) },
    { when: () => clock > 2, then: () => capsule.set({ name: 'Pickle', badge: '🦊' }, true) },
    { when: () => clock > 3.5, then: () => { capsule.set(null, false); match.arrive(['horns']); } },
    { when: () => match.fighting.length === 1 && !entrance.active, then: () => { mark = clock; } },
    { when: () => clock > mark + 1.5, then: () => capsule.set({ name: 'Sam', badge: '🐸' }, true) },
    { when: () => clock > mark + 4, then: () => { capsule.set(null, false); match.arrive(['fists', 'blob', 'tiny']); } },
    { when: () => match.fighting.length > 1 && !entrance.active, then: () => { mark = clock; } },
    { when: () => clock > mark + 12 || (match.fighting.length <= 1 && clock > mark + 2), then: () => crown() },
  ];

  function crown(): void {
    const hits = new Map([...cast.values()].map((c) => [c.f.id, c.f.hits]));
    for (const e of match.crown(hits)) {
      if (e.type !== 'crowned') continue;
      crowned = cast.get(e.id)!.f;
      for (const c of cast.values()) if (c.f !== crowned && c.f.state === 'fighting') c.f.stun = 999; // the others flop over
      entrance.cancel();
      finale.crown(crowned);
      banner.show('👑 CHAMPION! 👑', nameOf(crowned), 0);
    }
  }

  function onMatch(events: MatchEvent[]): void {
    for (const e of events) {
      if (e.type === 'entranceStart') entrance.run(e.ids.map((id) => cast.get(id)?.f ?? spawn(id)), e.group);
      else if (e.type === 'lone') banner.show(`IS THERE ANYONE BRAVE ENOUGH…`, `…to face ${cast.get(e.id)!.recipe.name.toUpperCase()}?!`, 3.5);
      else if (e.type === 'holdsRing') banner.show(cast.get(e.id)!.recipe.name.toUpperCase(), 'holds the ring!', 3);
      else if (e.type === 'tie') banner.show("IT'S A TIE!", 'everybody fell out!', 3);
    }
  }

  // the fight loop's contexts (others is refreshed each step)
  const ring: Fighter[] = [];
  const ctx: FightCtx = { others: ring, boast: false, tune: TUNE, rng };
  const boastCtx: FightCtx = { others: ring, boast: true, tune: TUNE, rng };

  function step(): void {
    onMatch(match.tick(DT));
    ring.length = 0;
    for (const c of cast.values()) if (c.f.state === 'fighting' || c.f.state === 'entering') ring.push(c.f);
    const frozen = match.frozen;
    const fighting = ring.filter((f) => f.state === 'fighting');
    setFrozen(fighting, frozen);
    entrance.update(DT);
    const alone = fighting.length === 1 && match.entering.length === 0 && match.onDeck.length === 0;
    for (const f of ring) {
      if (frozen && f.state === 'fighting') continue; // frozen mid-flail
      for (const h of f.think(DT, sim, f === crowned || (alone && !crowned) ? boastCtx : ctx)) {
        pops.pop(h.at, camera, undefined, 0.8 + h.power * 0.2);
        const p = h.target.ragdoll.torso.body.translation();
        if (bigLaunch(p, h.target.wobble, TUNE.build, R)) slow.trigger(clock);
      }
    }
    world.step();
    sim += DT;
    const outs = ring.filter((f) => f.state === 'fighting' && isOut(f.ragdoll.pos(), R));
    if (outs.length) {
      for (const f of outs) {
        f.state = 'out';
        cast.get(f.id)!.outAt = clock;
        stars.remove(f);
        const p = f.ragdoll.pos();
        pops.pop(new Vector3(p.x, Math.max(p.y, -1) + 2, p.z), camera, BYE_BYE, 1.3);
      }
      slow.trigger(clock);
      onMatch(match.ringOut(outs.map((f) => f.id)));
    }
    for (const c of cast.values()) {
      if (c.f.state !== 'out' || clock - c.outAt < 3) continue;
      c.f.dispose();
      c.obj.dispose();
      cast.delete(c.f.id);
    }
  }

  async function saveShot(frame: string): Promise<void> {
    const { toCanvas } = await import('html-to-image');
    // the library waits on frames, which stall while the pane is hidden: stand in for them
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 0);
    let over: HTMLCanvasElement;
    try {
      over = await toCanvas(ui, { width: innerWidth, height: innerHeight, pixelRatio: canvas.width / Math.max(1, innerWidth), skipFonts: true });
    } finally { window.requestAnimationFrame = raf; }
    const img = new Image();
    await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = fail; img.src = frame; });
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const g = out.getContext('2d')!;
    g.drawImage(img, 0, 0);
    g.drawImage(over, 0, 0, out.width, out.height);
    await fetch('/__shot?name=show', { method: 'POST', body: out.toDataURL('image/png') });
    console.info('saved .shots/show.png');
  }

  await renderer.compileAsync(scene, camera);
  let last = performance.now();
  const champAt = new Vector3(), ramp = arena.entry.dir.clone().multiplyScalar(R + 2.5).setY(0.6);
  renderer.setAnimationLoop((now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;
    while (steps.length && steps[0].when()) steps.shift()!.then();
    acc += dt * slow.timeScale(clock);
    let n = 0;
    while (acc >= DT && n < 4) { step(); acc -= DT; n++; }
    if (n === 4) acc = 0;

    arena.update(dt);
    for (const c of cast.values()) {
      driveBones(c.obj, c.f.ragdoll, dt);
      stars.update(c.f, dt);
    }
    finale.update(dt);
    if (crowned) {
      const p = crowned.ragdoll.torso.body.translation();
      director.champion(dt, champAt.set(p.x, 0, p.z), crowned.layout.ringHeight, facingYaw(crowned.ragdoll.torso));
    } else if (entrance.active) director.entrance(dt, entrance.focus, arena.entry.dir, entrance.height, entrance.lift, entrance.side);
    else director.wide(dt, ring.filter((f) => f.state === 'fighting'));
    director.apply(camera);
    capsule.update(camera, ramp);
    renderer.render(scene, camera);

    // the shot: the solo show-off at the top of its jump, banner up (the frame is read in the same task as the render)
    if (!shotTaken && entrance.active && !entrance.group && entrance.phase === 'showOff' && entranceAt(entrance.t, false).jump > SHOT_AT) {
      shotTaken = true;
      void saveShot(canvas.toDataURL('image/png'));
    }
  });
  Object.assign(window, { __show: { scene, camera, renderer, world, arena, match, entrance, cast, director, slow, finale } });
}
