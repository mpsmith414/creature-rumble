import type RAPIER from '@dimforge/rapier3d-compat';
import { Vector3, type Camera } from 'three/webgpu';
import { introText, type Beat, type Slots } from '../announcer/announcer';
import type { BodyData } from '../builder/build';
import { Fighter, type Hit } from '../fight/fighter';
import { planFor } from '../fight/moves';
import type { Tune } from '../fight/tune';
import type { FightPlan } from '../fight/types';
import type { Match, MatchEvent } from '../match/match';
import { ragdollLayout, type RagdollLayout } from '../physics/layout';
import type { Recipe } from '../recipe/schema';
import { BYE_BYE } from '../show/pops';
import { bigLaunch, type SlowMo } from '../show/slowmo';
import type { RingLoop } from './loop';

/** A lone fighter's taunt comes back this often (s) while it stays alone (spec §2.6). */
export const LONE_EVERY_S = 12;
/** A taunt that could not be said (a big line was up) is tried again this soon (s). */
export const LONE_RETRY_S = 2;
/** Quick-filled fighters stand on a circle this far (× ring radius) from the centre, facing in. */
const FILL_AT = 0.4;

/** A creature the ring knows: what it is, its body, who made it, the name to shout. */
export type Card = { id: string; recipe: Recipe; body: BodyData; maker: string | null; name: string };
type Entry = Card & { plan: FightPlan; layout: RagdollLayout };

type Say = (beat: 'intro' | 'groupIntro' | 'hit' | 'bigHit' | 'ringOut' | 'holdsRing' | 'lone' | 'tie' | 'crown' | 'again', slots: Slots,
  o?: { priority?: boolean; text?: string }) => { text: string; spoken: boolean };

/** What the show drives. Everything here is injected, so the whole round (and many rounds) can be run in a test. */
export type ShowDeps<O> = {
  world: RAPIER.World; tune: Tune; rng: () => number; match: Match; loop: RingLoop; slow: SlowMo; camera: Camera;
  entrance: { run(fs: readonly Fighter[], group: boolean, champion?: Fighter | null): void; cancel(): void };
  finale: { crown(f: Fighter): void; stop(): void; clear(): void; update(dt: number): void; readonly champion: unknown };
  stars: { update(f: Fighter, dt: number): void; remove(f: Fighter): void; clear(): void };
  pops: { pop(at: Vector3, camera: Camera, word?: string, size?: number): void };
  banner: { hide(): void };
  announcer: { say: Say; warm(beat: Exclude<Beat, 'intro'>, slots: Slots, n?: number): void; prefetch(text: string): void };
  sfx: { boing(sizeM: number): void; bonk(): void; whoosh(): void; fanfare(): void };
  crowd: { roar(): void };
  roster: { fought(ids: string[]): Promise<void>; crowned(id: string): Promise<void> };
  /** The fighter's picture: made when its ragdoll is, driven each frame, disposed with it. */
  objects: { make(card: Card, layout: RagdollLayout): O; drive(o: O, f: Fighter, dt: number): void; dispose(o: O): void };
};

const _at = new Vector3();

/** "A", "A and B", "A, B and C". */
export const namesOf = (ns: readonly string[]) => (ns.length < 2 ? ns.join('') : `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);

/**
 * The Rumble's show (spec §2): turns the match's events into entrances, words, sounds and pictures, and runs the ring
 * loop once a frame. A fighter's ragdoll and picture exist only from its entrance until it has fallen (so those waiting
 * on deck hold no collision bit); a creature's card is kept while the match still knows it.
 */
export class RumbleShow<O> {
  /** The crowned champion (camera push-in, crown), or null. */
  champion: Fighter | null = null;
  private readonly cards = new Map<string, Entry>();
  private readonly objects = new Map<Fighter, O>();
  private now = 0;
  /** Quick-fill: the next entrance is skipped, its fighters placed straight in the ring. */
  private quiet = false;
  /** Who a group entrance after Again! walks in last (the last champion, still wearing its crown). */
  private lastChampion: Fighter | null = null;
  private lone: { id: string; next: number } | null = null;

  constructor(private readonly d: ShowDeps<O>) {
    d.loop.onEvents = (evs) => this.onMatch(evs);
    d.loop.onGone = (f) => this.gone(f);
    d.announcer.warm('tie', {});
    d.announcer.warm('again', {});
  }

  /** How many cards it keeps (bounded: only creatures the match still knows). */
  get cardCount(): number { return this.cards.size; }
  get objectCount(): number { return this.objects.size; }
  card(id: string): Card | undefined { return this.cards.get(id); }
  /** The picture of a fighter in the ring. */
  object(f: Fighter): O | undefined { return this.objects.get(f); }
  /** Is this creature in the ring, entering or on deck? */
  known(id: string): boolean {
    const m = this.d.match;
    return m.fighting.includes(id) || m.entering.includes(id) || m.onDeck.includes(id);
  }

  /** How a creature fights and its ragdoll's layout; throws when its recipe and body cannot make a fighter. */
  static check(recipe: Recipe, body: BodyData): { plan: FightPlan; layout: RagdollLayout } {
    const plan = planFor(recipe, body.skeleton);
    return { plan, layout: ragdollLayout(body.skeleton, plan) };
  }

  /** Learn a creature (a release, a send-back, a fixture): its intro starts fetching now, so its entrance never waits. */
  register(c: Card): void {
    const { plan, layout } = RumbleShow.check(c.recipe, c.body);
    this.cards.set(c.id, { ...c, plan, layout });
    this.d.announcer.prefetch(introText(plan.intro, this.slots(c.id)));
  }

  /** Into the ring (an entrance follows; past 8 they wait on deck). Unknown ids are skipped. */
  arrive(ids: string[]): void {
    const known = ids.filter((id) => this.cards.has(id));
    this.d.match.arrive(known);
    this.warmBigMoments(known);
    this.warmGroup([...new Set([...this.d.match.entering, ...known])]);
  }

  /** Gets the big moments of these fighters decoded (their ring-out, crown, taunt and boast), so they can be spoken. */
  private warmBigMoments(ids: string[]): void {
    const { announcer } = this.d;
    for (const id of ids) {
      const name = this.name(id);
      announcer.warm('ringOut', { other: name }, 1);
      for (const beat of ['lone', 'holdsRing', 'crown'] as const) announcer.warm(beat, { name }, 1);
    }
  }

  /** Gets the group entrance line for these fighters decoded. */
  private warmGroup(ids: string[]): void {
    if (ids.length > 1) this.d.announcer.warm('groupIntro', { names: namesOf(ids.map((id) => this.name(id))) }, 1);
  }

  /** Dev: `ids` (registered) straight into the ring with no entrance. */
  quickFill(ids: string[]): void {
    const m = this.d.match;
    if (m.phase !== 'open' || m.entering.length) return this.arrive(ids);
    this.arrive(ids);
    this.quiet = true;
    try {
      this.onMatch(m.tick(1e3));
    } finally {
      this.quiet = false;
    }
  }

  /** "Crown the champion!" (TV menu, phone, dev): only while the ring is open with someone fighting. True when it crowned. */
  crown(): boolean {
    const { match, loop, entrance, finale } = this.d;
    if (match.phase !== 'open' || match.fighting.length === 0) return false;
    for (const e of match.crown(loop.hits())) {
      if (e.type !== 'crowned') continue;
      // anyone mid-entrance went back on deck: it is made again when it enters
      entrance.cancel();
      for (const f of loop.all()) if (f.state === 'entering') loop.remove(f.id);
      const champ = loop.get(e.id) ?? null;
      for (const f of loop.all()) if (f !== champ && f.state === 'fighting') f.stun = 999; // the others flop over defeated
      this.champion = champ;
      loop.champion = champ;
      this.lone = null;
      if (champ) finale.crown(champ);
      this.d.sfx.fanfare();
      this.d.crowd.roar();
      this.d.announcer.say('crown', this.slots(e.id));
      this.warmGroup([...match.fighting]); // the Again! entrance is likely next
      void this.d.roster.crowned(e.id).catch((err) => console.warn('could not mark the champion', err));
    }
    return true;
  }

  /** "Again!": after a crowning, the same cast plus anyone made meanwhile, in one group entrance. True when it went. */
  again(): boolean {
    const { match, loop, finale, stars } = this.d;
    if (match.phase !== 'crowned') return false;
    finale.stop(); // the champion keeps its crown for the group entrance
    this.lastChampion = this.champion;
    this.champion = null;
    loop.champion = null;
    for (const f of loop.all()) {
      if (f.state === 'out' || f.state === 'gone') loop.remove(f.id);
      else { f.stun = 0; f.wobble = 0; }
    }
    loop.resetHits();
    stars.clear();
    this.lone = null;
    this.onMatch(match.again());
    // anyone left on deck (more than 8) is made again when it enters
    for (const f of loop.all()) if (!match.entering.includes(f.id)) loop.remove(f.id);
    this.prune();
    return true;
  }

  /** "Clear the ring": everyone out (back to the roster), the start screen comes back. */
  reset(): void {
    const { match, loop, entrance, finale, stars, banner } = this.d;
    entrance.cancel();
    loop.clear();
    match.reset();
    finale.clear();
    stars.clear();
    banner.hide();
    this.champion = this.lastChampion = null;
    this.lone = null;
    this.prune();
  }

  /** One frame (`dt` real s, `now` the show clock in s): the ring loop, the hits' show, the lone taunt, pictures. */
  frame(dt: number, now: number): { hits: Hit[]; outs: string[] } {
    this.now = now;
    const { loop, match, announcer } = this.d;
    const r = loop.step(dt, now);
    for (const h of r.hits) this.hit(h);
    if (this.lone) {
      const id = this.lone.id;
      const still = match.phase === 'open' && match.fighting.length === 1 && match.fighting[0] === id && !match.entering.length && !match.onDeck.length;
      if (!still) this.lone = null;
      else if (now >= this.lone.next) {
        // never over a big line (an intro still speaking): a taunt that could not be said is tried again soon
        const said = announcer.say('lone', this.slots(id)).text !== '';
        this.lone.next = now + (said ? LONE_EVERY_S : LONE_RETRY_S);
      }
    }
    for (const f of loop.all()) {
      const o = this.objects.get(f);
      if (o !== undefined) this.d.objects.drive(o, f, dt);
      this.d.stars.update(f, dt);
    }
    this.d.finale.update(dt);
    return { hits: r.hits, outs: r.outs };
  }

  private name(id: string): string {
    return this.cards.get(id)?.name ?? 'OUR HERO';
  }

  private slots(id: string): Slots {
    const c = this.cards.get(id);
    return { name: c?.name, maker: c?.maker ?? undefined, weight: c?.plan.weight };
  }

  /** The fighter for an entrance: the one still standing in the ring (after Again!), or a new one. Null if it cannot be made. */
  private fighterFor(id: string): Fighter | null {
    const { loop, world, tune, rng } = this.d;
    const have = loop.get(id);
    if (have && (have.state === 'fighting' || have.state === 'entering')) return have;
    if (have) loop.remove(id);
    const c = this.cards.get(id);
    if (!c) {
      console.warn(`no card for ${id}: it cannot enter`);
      return null;
    }
    if (!loop.makeRoom()) {
      console.warn(`no room for ${id}'s ragdoll`);
      return null;
    }
    const f = new Fighter(id, world, c.layout, c.plan, { tune, rng });
    loop.add(f);
    this.objects.set(f, this.d.objects.make(c, c.layout));
    return f;
  }

  /** The match's events, each on its own: one that fails is logged and the rest of the batch still plays. */
  private onMatch(events: MatchEvent[]): void {
    for (const e of events) {
      try {
        this.onEvent(e);
      } catch (err) {
        console.error(`the show failed on a ${e.type} event`, err);
      }
    }
  }

  private onEvent(e: MatchEvent): void {
    const { announcer, entrance } = this.d;
    if (e.type === 'entranceStart') {
      const fs = e.ids.map((id) => this.fighterFor(id)).filter((f): f is Fighter => f !== null);
      if (this.quiet) this.place(fs);
      else {
        const champ = this.lastChampion && fs.includes(this.lastChampion) ? this.lastChampion : null;
        entrance.run(fs, e.group, champ);
        if (e.ids.length === 1) announcer.say('intro', this.slots(e.ids[0]), { text: this.cards.get(e.ids[0])?.plan.intro });
        else announcer.say('groupIntro', { names: namesOf(e.ids.map((id) => this.name(id))) });
      }
    } else if (e.type === 'entranceEnd') {
      for (const id of e.ids) {
        const f = this.d.loop.get(id);
        if (f && f.state === 'entering') f.state = 'fighting'; // the match's clock is the one that counts
      }
      this.lastChampion = null;
      // anyone the match brought in with no fighter in the ring (it could not be made, or it broke) is ruled out
      const missing = e.ids.filter((id) => !this.d.loop.get(id));
      if (missing.length) this.onMatch(this.d.match.ringOut(missing));
      this.warmHits();
    } else if (e.type === 'ringOut') this.ringOut(e.ids);
    else if (e.type === 'holdsRing') {
      // it comes with the ring-out's line: if that is still up, the boast follows a little later
      const said = announcer.say('holdsRing', this.slots(e.id)).text !== '';
      this.lone = { id: e.id, next: this.now + (said ? LONE_EVERY_S : LONE_RETRY_S) };
    } else if (e.type === 'lone') this.lone = { id: e.id, next: this.now }; // taunted at once (this frame), then every 12 s
    else if (e.type === 'tie') announcer.say('tie', {});
    else if (e.type === 'again') announcer.say('again', {});
  }

  /** Quick-fill: stand them round the middle facing in, fighting at once. */
  private place(fs: Fighter[]): void {
    const R = this.d.tune.ringRadius;
    fs.forEach((f, i) => {
      const a = (i / Math.max(1, fs.length)) * Math.PI * 2 + 0.3;
      _at.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(R * FILL_AT);
      f.ragdoll.pose(_at, Math.atan2(-_at.x, -_at.z));
      f.state = 'fighting';
    });
  }

  private ringOut(ids: string[]): void {
    const { loop, pops, camera, stars, finale, sfx, crowd, announcer, slow, roster } = this.d;
    for (const id of ids) {
      const f = loop.get(id);
      if (!f) continue;
      const p = f.ragdoll.pos();
      pops.pop(_at.set(p.x, Math.max(p.y, -1) + 2, p.z), camera, BYE_BYE, 1.3);
      stars.remove(f);
      if (finale.champion === f) finale.clear();
    }
    sfx.whoosh();
    crowd.roar();
    slow.trigger(this.now);
    announcer.say('ringOut', { other: namesOf(ids.map((id) => this.name(id))) });
    void roster.fought(ids).catch((e) => console.warn('could not count the bout', e));
  }

  private hit(h: Hit): void {
    const { pops, camera, sfx, slow, announcer, tune } = this.d;
    pops.pop(h.at, camera, undefined, 0.8 + h.power * 0.2);
    sfx.bonk();
    sfx.boing(h.target.layout.ringHeight);
    const p = h.target.ragdoll.torso.body.translation();
    const big = bigLaunch(p, h.target.wobble, tune.build, tune.ringRadius);
    if (big) {
      slow.trigger(this.now);
      sfx.whoosh();
    }
    const beat = big ? 'bigHit' : 'hit';
    if (announcer.say(beat, { name: this.name(h.attacker.id), other: this.name(h.target.id) }).text) this.warmHits(beat);
  }

  /** Gets a few hit lines decoded for a likely pair in the ring, so the next one can be spoken. */
  private warmHits(only?: 'hit' | 'bigHit'): void {
    const ids = this.d.match.fighting;
    if (ids.length < 2) return;
    const r = this.d.rng, i = Math.floor(r() * ids.length) % ids.length;
    const j = (i + 1 + (Math.floor(r() * (ids.length - 1)) % (ids.length - 1))) % ids.length;
    const slots = { name: this.name(ids[i]), other: this.name(ids[j]) };
    for (const beat of only ? [only] : (['hit', 'bigHit'] as const)) this.d.announcer.warm(beat, slots);
  }

  private gone(f: Fighter): void {
    const o = this.objects.get(f);
    if (o !== undefined) this.d.objects.dispose(o);
    this.objects.delete(f);
    this.d.stars.remove(f);
    if (this.d.finale.champion === f) this.d.finale.clear();
    if (this.champion === f) this.champion = null;
    if (this.lastChampion === f) this.lastChampion = null;
    this.prune();
  }

  /** Forgets cards the match no longer knows and no fighter uses (their bodies are big; the roster keeps them). */
  private prune(): void {
    const m = this.d.match, keep = new Set([...m.fighting, ...m.entering, ...m.onDeck, ...m.lastCast]);
    for (const id of this.cards.keys()) if (!keep.has(id) && !this.d.loop.get(id)) this.cards.delete(id);
  }
}
