import type RAPIER from '@dimforge/rapier3d-compat';
import { Group, PerspectiveCamera, Scene, Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { Announcer, LINES } from '../../src/announcer/announcer';
import { RingLoop } from '../../src/app/loop';
import type { Crowd } from '../../src/audio/crowd';
import type { Mixer } from '../../src/audio/mixer';
import type { Sfx } from '../../src/audio/sfx';
import type { Banner } from '../../src/show/banner';
import { LONE_EVERY_S, LONE_RETRY_S, namesOf, RumbleShow, type Card, type ShowDeps } from '../../src/app/show';
import { addArenaColliders } from '../../src/arena/colliders';
import { ENTRY_ANGLE, entryDir } from '../../src/arena/geometry';
import type { BodyData } from '../../src/builder/build';
import { buildSkeleton } from '../../src/builder/skeleton';
import type { Hit } from '../../src/fight/fighter';
import type { SpecialCue } from '../../src/fight/special';
import { TUNE } from '../../src/fight/tune';
import { Match } from '../../src/match/match';
import { createWorld, initPhysics } from '../../src/physics/world';
import { Entrance, type EntranceStage } from '../../src/show/entrance';
import { SHAKE_MAX } from '../../src/show/camera';
import { Finale } from '../../src/show/finale';
import { Shockwaves, SHOCK_S } from '../../src/show/shockwave';
import { SlowMo } from '../../src/show/slowmo';
import { GLOW_FAINT, GLOW_LOW, SPECIAL_POP, WHEEE } from '../../src/show/special-fx';
import { DizzyStars } from '../../src/show/stars';
import { Trails } from '../../src/show/trails';
import { mulberry32 } from '../../src/util/rng';
import { KINDS, loadFixture } from '../fixtures/fighters';

beforeAll(initPhysics);

const DT = 1 / 60;

function stage(): EntranceStage {
  return {
    entry: { angle: ENTRY_ANGLE, dir: entryDir(ENTRY_ANGLE) },
    bridge: { show: () => {} },
    spot: { intensity: 0, position: new Vector3(), target: { position: new Vector3() } },
  };
}

/** A card for a fixture kind (its body is only the skeleton: the pictures are fakes here). */
function card(kind: string, id = kind): Card {
  const recipe = loadFixture(kind);
  return { id, recipe, body: { skeleton: buildSkeleton(recipe) } as BodyData, maker: 'Pickle', name: recipe.name };
}

/** The whole show with real physics, match, entrance, stars and finale; words, sounds and pictures are counted fakes. */
function rig(seed = 5, o: { announcer?: (crowd: { roar(): void; aww(): void; rise(s: number): void; ooh(): void }) => ShowDeps<Group>['announcer'] } = {}) {
  const world: RAPIER.World = createWorld(TUNE.gravity);
  addArenaColliders(world, TUNE);
  const scene = new Scene(), camera = new PerspectiveCamera();
  const match = new Match(), slow = new SlowMo();
  const entrance = new Entrance(stage(), TUNE);
  const rng = mulberry32(seed);
  const loop = new RingLoop({ world, match, slowmo: slow, tune: TUNE, entrance, rng });
  // special cues and hits handed to the show as if the fight made them this frame
  const cues: SpecialCue[] = [], hits: Hit[] = [];
  const step = loop.step.bind(loop);
  loop.step = (dt, now) => {
    const out = step(dt, now);
    out.specials.push(...cues.splice(0));
    out.hits.push(...hits.splice(0));
    return out;
  };
  const live = new Set<Group>();
  const said: string[] = [];
  const announcer = {
    say: vi.fn((beat: string) => { said.push(beat); return { text: beat, spoken: false }; }),
    warm: vi.fn(), prefetch: vi.fn<(t: string) => void>(),
  };
  const roster = { fought: vi.fn(async () => {}), crowned: vi.fn(async () => {}) };
  const crowd = { roar: vi.fn(), aww: vi.fn(), rise: vi.fn(), ooh: vi.fn() };
  const finale = new Finale(scene, { ringRadius: TUNE.ringRadius, rng });
  const stars = new DizzyStars(scene, TUNE);
  const trails = new Trails(scene), shockwaves = new Shockwaves(scene);
  const pops = { pop: vi.fn<(at: Vector3, c: unknown, word?: string, size?: number) => void>() };
  const sfx = { boing: vi.fn(), bonk: vi.fn(), whoosh: vi.fn(), fanfare: vi.fn(), thud: vi.fn(), drum: vi.fn() };
  const director = { punch: vi.fn(), shake: vi.fn<(amp: number) => void>() };
  const glow = new Map<Group, number>();
  const show = new RumbleShow<Group>({
    world, tune: TUNE, rng, match, loop, slow, camera, entrance, finale, stars,
    pops, banner: { hide: vi.fn() }, announcer: o.announcer?.(crowd) ?? announcer,
    sfx, crowd, roster, director, trails, shockwaves,
    objects: {
      make: () => { const g = new Group(); scene.add(g); live.add(g); return g; },
      drive: () => {},
      dispose: (g) => { scene.remove(g); live.delete(g); glow.delete(g); },
      glow: (g, level) => void glow.set(g, level),
    },
  });
  let t = 0;
  const run = (secs: number) => {
    for (let i = 0; i < Math.round(secs / DT); i++) show.frame(DT, (t += DT));
  };
  const words = () => pops.pop.mock.calls.map((c) => c[2]);
  return {
    world, scene, match, loop, show, entrance, finale, announcer, roster, crowd, live, said, run, cues, hits, trails, shockwaves, pops, words,
    sfx, director, glow, slow, now: () => t,
  };
}

describe('RumbleShow', () => {
  test('an arrival is made only when its entrance starts, enters with its intro, then fights', () => {
    const r = rig();
    r.show.register(card('fists', 'a'));
    expect(r.announcer.prefetch).toHaveBeenCalledTimes(1); // the intro fetches as soon as it is made
    expect(r.announcer.prefetch.mock.calls[0][0]).toContain('Pickle');
    const bodies = r.world.bodies.len();
    r.show.arrive(['a']);
    expect(r.world.bodies.len()).toBe(bodies); // waiting holds no ragdoll
    r.run(DT);
    expect(r.loop.get('a')?.state).toBe('entering');
    expect(r.said).toContain('intro');
    r.run(9);
    expect(r.loop.get('a')?.state).toBe('fighting');
    expect(r.match.fighting).toEqual(['a']);
    expect(r.said).toContain('lone');
  });

  test('fighters on deck hold no ragdoll: 10 arrivals, at most 8 made', () => {
    const r = rig();
    const ids = Array.from({ length: 10 }, (_, i) => `f${i}`);
    for (const [i, id] of ids.entries()) r.show.register(card(KINDS[i % KINDS.length], id));
    r.show.arrive(ids);
    r.run(DT);
    expect(r.match.entering.length).toBe(8);
    expect(r.match.onDeck.length).toBe(2);
    expect(r.loop.size).toBe(8);
    expect(r.live.size).toBe(8);
  });

  test('crown and again only act when the phase allows, and a second press does nothing', () => {
    const r = rig();
    expect(r.show.crown()).toBe(false); // nobody in the ring
    expect(r.show.again()).toBe(false);
    for (const k of ['fists', 'blob']) r.show.register(card(k));
    r.show.quickFill(['fists', 'blob']);
    expect(r.match.fighting.length).toBe(2);
    expect(r.show.again()).toBe(false); // open: no Again! yet
    expect(r.show.crown()).toBe(true);
    expect(r.match.phase).toBe('crowned');
    expect(r.finale.champion).toBe(r.show.champion);
    expect(r.show.crown()).toBe(false);
    expect(r.said.filter((b) => b === 'crown')).toHaveLength(1);
    expect(r.roster.crowned).toHaveBeenCalledTimes(1);
    expect(r.show.again()).toBe(true);
    expect(r.show.again()).toBe(false);
    expect(r.match.phase).toBe('open');
  });

  test('crowning mid-entrance sends the walkers back on deck and lets their ragdolls go', () => {
    const r = rig();
    for (const k of ['fists', 'blob', 'tiny']) r.show.register(card(k));
    r.show.quickFill(['fists', 'blob']);
    r.show.arrive(['tiny']);
    r.run(1);
    expect(r.loop.get('tiny')?.state).toBe('entering');
    r.show.crown();
    expect(r.loop.get('tiny')).toBeUndefined();
    expect(r.match.onDeck).toEqual(['tiny']);
    expect(r.entrance.active).toBe(false);
  });

  test(`a lone fighter taunts again every ${LONE_EVERY_S} s while it stays alone`, () => {
    const r = rig();
    r.show.register(card('blob'));
    r.show.quickFill(['blob']);
    r.run(DT);
    expect(r.said.filter((b) => b === 'lone')).toHaveLength(1);
    r.run(LONE_EVERY_S * 2 + 0.5);
    expect(r.said.filter((b) => b === 'lone')).toHaveLength(3);
  });

  test('a taunt that would talk over a big line is tried again soon', () => {
    const r = rig();
    r.show.register(card('blob'));
    let quiet = true;
    r.announcer.say.mockImplementation((beat: string) => {
      if (beat === 'lone' && quiet) return { text: '', spoken: false };
      r.said.push(beat);
      return { text: beat, spoken: false };
    });
    r.show.quickFill(['blob']);
    r.run(1);
    expect(r.said.filter((b) => b === 'lone')).toHaveLength(0);
    quiet = false;
    r.run(LONE_RETRY_S + 0.1);
    expect(r.said.filter((b) => b === 'lone')).toHaveLength(1);
  });

  test('two falling out together is a tie: the tie line is shown and the crowd goes aww', () => {
    const shown: string[] = [];
    const r = rig(5, {
      announcer: (crowd) => new Announcer({
        voice: { prefetch: () => {}, isReady: () => false, play: () => ({ spoken: false, seconds: 0 }), stop: () => {} },
        banner: { show: (_t: string, sub: string) => void shown.push(sub) } as unknown as Banner,
        mixer: { duckForVoice: () => {} } as unknown as Mixer,
        sfx: { drumRoll: () => {}, sting: () => {} } as unknown as Sfx,
        crowd: crowd as unknown as Crowd, rng: mulberry32(2), now: () => 0, later: () => {},
      }),
    });
    for (const k of ['fists', 'blob']) r.show.register(card(k));
    r.show.quickFill(['fists', 'blob']);
    for (const f of r.loop.all()) f.ragdoll.pose(new Vector3(TUNE.ringRadius + 6, 0, f.id === 'blob' ? 3 : -3), 0);
    r.run(DT);
    expect(r.match.fighting).toEqual([]);
    expect(r.crowd.aww).toHaveBeenCalledTimes(1);
    expect(shown.some((t) => LINES.tie.includes(t))).toBe(true);
  });

  test('after an arrival, a ring-out and a crown are spoken (not words only) when the voice decodes at once', () => {
    const readyLines = new Set<string>();
    const spokenLines: string[] = [];
    const r = rig(5, {
      announcer: (crowd) => new Announcer({
        voice: { prefetch: (t: string) => void readyLines.add(t), isReady: (t: string) => readyLines.has(t),
          play: (t: string) => { if (!readyLines.has(t)) return { spoken: false, seconds: 0 }; spokenLines.push(t); return { spoken: true, seconds: 1 }; }, stop: () => {} },
        banner: { show: () => {} } as unknown as Banner,
        mixer: { duckForVoice: () => {} } as unknown as Mixer,
        sfx: { drumRoll: () => {}, sting: () => {}, } as unknown as Sfx,
        crowd: crowd as unknown as Crowd, rng: mulberry32(2), now: () => 0, later: () => {},
      }),
    });
    for (const k of ['fists', 'blob']) r.show.register(card(k));
    r.show.quickFill(['fists', 'blob']);
    r.loop.get('blob')!.ragdoll.pose(new Vector3(TUNE.ringRadius + 6, 0, 0), 0);
    r.run(DT);
    expect(spokenLines.some((t) => LINES.ringOut.some((l) => l.replace('{other}', card('blob').name.toUpperCase()) === t))).toBe(true);
    r.show.crown();
    expect(spokenLines.some((t) => LINES.crown.some((l) => l.replace('{name}', card('fists').name.toUpperCase()) === t))).toBe(true);
  });

  test('one event that fails does not stop the rest of its batch', () => {
    const r = rig();
    for (const k of ['fists', 'blob']) r.show.register(card(k));
    r.show.quickFill(['fists', 'blob']);
    r.announcer.say.mockImplementation((beat: string) => {
      if (beat === 'ringOut') throw new Error('no words');
      r.said.push(beat);
      return { text: beat, spoken: false };
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    r.loop.get('blob')!.ragdoll.pose(new Vector3(TUNE.ringRadius + 6, 0, 0), 0);
    r.run(DT);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('ringOut'), expect.any(Error));
    expect(r.said).toContain('holdsRing'); // the ringOut before it in the same batch threw
    expect(r.match.fighting).toEqual(['fists']);
    error.mockRestore();
  });

  test('after a round that 10 fought, Again! brings the champion in last and still crowned', () => {
    const r = rig(11);
    const ids = Array.from({ length: 10 }, (_, i) => `f${i}`);
    for (const [i, id] of ids.entries()) r.show.register(card(KINDS[i % KINDS.length], id));
    r.show.quickFill(ids); // 8 in the ring, 2 on deck
    expect(r.match.onDeck).toHaveLength(2);
    // two fall out: the two on deck come in, so 10 have fought this round
    const [p, q] = r.loop.all();
    p.ragdoll.pose(new Vector3(TUNE.ringRadius + 6, 0, 3), 0);
    q.ragdoll.pose(new Vector3(TUNE.ringRadius + 6, 0, -3), 0);
    r.run(7);
    expect(r.match.lastCast).toHaveLength(10);
    expect(r.match.onDeck).toHaveLength(0);
    expect(r.show.crown()).toBe(true);
    const champ = r.show.champion!;
    expect(r.finale.champion).toBe(champ);
    expect(r.show.again()).toBe(true);
    expect(r.match.entering).toHaveLength(8);
    expect(r.match.entering[7]).toBe(champ.id); // last of those who walk in
    expect(r.match.onDeck).not.toContain(champ.id);
    expect(r.loop.get(champ.id)).toBe(champ);
    expect(r.finale.champion).toBe(champ); // still wearing the crown
    expect(r.loop.size).toBeLessThanOrEqual(8);
    r.run(6);
    expect(r.match.fighting).toContain(champ.id);
    expect(r.finale.champion).toBe(champ);
  });

  test('a ring-out: BYE BYE, the roster counts the bout, and the fallen ragdoll and picture are let go', () => {
    const r = rig();
    for (const k of ['fists', 'blob']) r.show.register(card(k));
    r.show.quickFill(['fists', 'blob']);
    r.loop.get('blob')!.ragdoll.pose(new Vector3(TUNE.ringRadius + 6, 0, 0), 0);
    r.run(DT);
    expect(r.said).toContain('ringOut');
    expect(r.roster.fought).toHaveBeenCalledWith(['blob']);
    r.run(5.1);
    expect(r.loop.get('blob')).toBeUndefined();
    expect(r.live.size).toBe(1);
  });

  test('many Again! rounds leak nothing: ragdolls, pictures, scene objects and cards stay bounded', () => {
    const r = rig(9);
    const ids = ['fists', 'legs', 'tiny', 'blob', 'wings'];
    for (const k of ids) r.show.register(card(k));
    r.show.quickFill(ids);
    const counts: { bodies: number; colliders: number; joints: number; scene: number; live: number; loop: number; cards: number }[] = [];
    for (let round = 0; round < 5; round++) {
      r.run(4);
      // a special and a flier every round: glows, shockwaves and trails come and go
      const star = r.loop.all().find((f) => f.state === 'fighting');
      if (star) {
        for (const phase of ['charge', 'release', 'impact'] as const) r.cues.push({ id: star.id, special: 'bellyBomb', phase, at: new Vector3(), radius: 3 });
        star.ragdoll.pose(new Vector3(0, 4, 0), 0);
      }
      r.run(0.3);
      // somebody falls out each round (a push off the edge), so ragdolls are let go and made again
      const pushed = r.loop.all().find((f) => f.state === 'fighting');
      pushed?.ragdoll.pose(new Vector3(TUNE.ringRadius + 6, 0, 0), 0);
      r.run(0.5);
      expect(r.show.crown()).toBe(true);
      r.run(2);
      expect(r.show.again()).toBe(true);
      r.run(6); // the group entrance
      counts.push({
        bodies: r.world.bodies.len(), colliders: r.world.colliders.len(), joints: r.world.impulseJoints.len(),
        scene: r.scene.children.length, live: r.live.size, loop: r.loop.size, cards: r.show.cardCount,
      });
    }
    const first = counts[0];
    for (const c of counts) {
      expect(c.loop).toBeLessThanOrEqual(ids.length);
      expect(c.live).toBe(c.loop);
      expect(c.cards).toBeLessThanOrEqual(ids.length);
      expect(c.bodies).toBeLessThanOrEqual(first.bodies + 24); // one fighter's worth of slack (a faller not yet let go)
      expect(c.colliders).toBeLessThanOrEqual(first.colliders + 24);
      expect(c.joints).toBeLessThanOrEqual(first.joints + 24);
      expect(c.scene).toBeLessThanOrEqual(first.scene + 2); // its picture and its dizzy stars
    }
    r.show.reset();
    r.run(DT);
    expect(r.show.chargedCount).toBe(0);
    expect(r.trails.count).toBe(0);
    expect(r.shockwaves.live).toBe(0);
    expect(r.loop.size).toBe(0);
    expect(r.live.size).toBe(0);
    expect(r.show.cardCount).toBe(0);
    expect(r.world.impulseJoints.len()).toBe(0);
  });
});

describe('specials and air time', () => {
  /** Two fighters fighting (no entrances), one frame in. */
  const ring = (seed = 5) => {
    const r = rig(seed);
    for (const k of ['fists', 'blob']) r.show.register(card(k));
    r.show.quickFill(['fists', 'blob']);
    r.run(DT);
    const fists = r.loop.get('fists')!, blob = r.loop.get('blob')!;
    const cue = (phase: SpecialCue['phase'], o: Partial<SpecialCue> = {}) =>
      r.cues.push({ id: 'fists', special: 'megaPunch', phase, at: new Vector3(1, 0, 0.5), ...o });
    return { ...r, fists, blob, cue, obj: (f = fists) => r.show.object(f)! };
  };

  test('their lines are warmed when the fighters arrive, with the words they will say', () => {
    const r = ring();
    expect(r.announcer.warm).toHaveBeenCalledWith('special', { name: card('fists').name, special: 'MEGA PUNCH' }, 1);
  });

  test('a charge: the special’s name on the banner with a special line, a drum hit, the crowd rising, and it glows', () => {
    const r = ring();
    expect(r.glow.get(r.obj())).toBeLessThanOrEqual(GLOW_FAINT);
    r.cue('charge');
    r.run(DT);
    expect(r.announcer.say).toHaveBeenCalledWith('special', { name: card('fists').name, special: 'MEGA PUNCH' }, { title: 'MEGA PUNCH!' });
    expect(r.sfx.drum).toHaveBeenCalledTimes(1);
    expect(r.crowd.rise).toHaveBeenCalledTimes(1);
    expect(r.show.chargedCount).toBe(1);
    expect(r.glow.get(r.obj())).toBeGreaterThanOrEqual(GLOW_LOW);
    expect(r.glow.get(r.obj(r.blob))).toBeLessThanOrEqual(GLOW_FAINT); // only the one doing it
    r.run(0.5);
    expect(r.glow.get(r.obj())).toBeGreaterThanOrEqual(GLOW_LOW); // it keeps glowing through the wind-up
  });

  test('a release: a whoosh, a slow-mo and the camera leaning in on the attacker', () => {
    const r = ring();
    r.cue('charge');
    r.run(DT);
    r.cue('release');
    r.run(DT);
    expect(r.sfx.whoosh).toHaveBeenCalled();
    expect(r.slow.timeScale(r.now())).toBeLessThan(1);
    expect(r.director.punch).toHaveBeenCalledTimes(1);
    const at = r.director.punch.mock.calls[0][0] as { x: number; z: number };
    const p = r.fists.ragdoll.pos();
    expect(Math.hypot(at.x - p.x, at.z - p.z)).toBeLessThan(0.5);
  });

  test('an impact: a shockwave to its reach, a big word, a gentle shake, a thud and a roar', () => {
    const r = ring();
    r.cue('impact', { radius: 3 });
    r.run(DT);
    expect(r.shockwaves.live).toBe(1);
    expect(r.words()).toContain(SPECIAL_POP.megaPunch);
    expect(r.director.shake).toHaveBeenCalledTimes(1);
    expect(r.director.shake.mock.calls[0][0]).toBeGreaterThan(0);
    expect(r.director.shake.mock.calls[0][0]).toBeLessThanOrEqual(SHAKE_MAX);
    expect(r.sfx.thud).toHaveBeenCalled();
    expect(r.crowd.roar).toHaveBeenCalled();
    r.run(SHOCK_S + 0.05);
    expect(r.shockwaves.live).toBe(0);
  });

  test('an end: the glow goes', () => {
    const r = ring();
    r.cue('charge');
    r.run(DT);
    r.cue('end');
    r.run(DT);
    expect(r.show.chargedCount).toBe(0);
    expect(r.glow.get(r.obj())).toBeLessThanOrEqual(GLOW_FAINT);
  });

  test('a fighter that leaves mid-special stops glowing and its cues after that do not break the show', () => {
    const r = ring();
    r.cue('charge');
    r.run(DT);
    r.fists.ragdoll.pose(new Vector3(TUNE.ringRadius + 6, 0, 0), 0);
    r.run(5.2);
    expect(r.loop.get('fists')).toBeUndefined();
    expect(r.show.chargedCount).toBe(0);
    r.cue('impact');
    r.cue('end');
    expect(() => r.run(DT)).not.toThrow();
    expect(r.shockwaves.live).toBe(1); // the impact still shows where it was
  });

  test('a high launch: a trail behind the flier, WHEEE! and the crowd’s ooh', () => {
    const r = ring();
    r.blob.ragdoll.pose(new Vector3(0, 3, 0), 0);
    r.hits.push({ attacker: r.fists, target: r.blob, at: new Vector3(0, 3, 0), power: 1, launch: 14 });
    r.run(DT);
    expect(r.words()).toContain(WHEEE);
    expect(r.crowd.ooh).toHaveBeenCalledTimes(1);
    r.run(0.1);
    expect(r.trails.count).toBe(1);
    expect(r.trails.ghosts).toBeGreaterThan(0);
    expect(r.words().filter((w) => w === WHEEE)).toHaveLength(1); // one WHEEE! a flight, not one a frame
  });

  test('a flier measured high pops WHEEE! with no hit; someone on their feet never trails', () => {
    const r = ring();
    r.run(0.5);
    expect(r.trails.count).toBe(0);
    r.blob.ragdoll.pose(new Vector3(0, 4, 0), 0);
    r.run(DT);
    expect(r.words()).toContain(WHEEE);
    expect(r.trails.count).toBe(1);
  });

  test('a gentle launch is not a WHEEE!', () => {
    const r = ring();
    r.hits.push({ attacker: r.fists, target: r.blob, at: new Vector3(), power: 0.5, launch: 3 });
    r.run(DT);
    expect(r.words()).not.toContain(WHEEE);
  });

  test('Again! and Clear the ring take every glow, trail and shockwave away', () => {
    const r = ring();
    r.cue('charge');
    r.cue('impact', { radius: 2 });
    r.blob.ragdoll.pose(new Vector3(0, 4, 0), 0);
    r.run(DT);
    expect(r.trails.count).toBe(1);
    expect(r.show.crown()).toBe(true);
    expect(r.show.chargedCount).toBe(0);
    expect(r.show.again()).toBe(true);
    expect(r.trails.count).toBe(0);
    expect(r.shockwaves.live).toBe(0);
    r.cue('charge');
    r.run(DT);
    r.show.reset();
    expect(r.show.chargedCount).toBe(0);
    expect(r.trails.count).toBe(0);
  });
});

test('namesOf joins names for a group call', () => {
  expect(namesOf(['A'])).toBe('A');
  expect(namesOf(['A', 'B'])).toBe('A and B');
  expect(namesOf(['A', 'B', 'C'])).toBe('A, B and C');
});
