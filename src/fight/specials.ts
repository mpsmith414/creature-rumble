import { Vector3 } from 'three/webgpu';
import type { RagdollLayout } from '../physics/layout';
import type { Piece, Ragdoll } from '../physics/ragdoll';
import type { Fighter, Hit } from './fighter';
import { push, tipOf, type Muscles } from './muscles';
import { SPECIAL_FOR, type SpecialCue, type SpecialName } from './special';
import { MOVE_POWER, type Tune } from './tune';
import type { Move } from './types';

/**
 * The seven special attacks (design 2026-11-12 §2): scripted, slapstick, about twice a normal hit (1.8× its power and
 * launched higher; balanced with npm run balance, as 2.5× rang fighters out in seconds). A fighter whose
 * meter is full starts its style's special (`SPECIAL_FOR`); the special runs as a little timeline — a wind-up
 * (`charge`), the attack (`release`), maybe an `impact`, then `end` — and always reaches `end`: by finishing, by its
 * time limit, or by being cancelled (knocked by a big blow, ruled out, let go).
 */

/**
 * The meter fills by this per landed hit, per hit taken, and per second of fighting (the design's hit rates halved: at
 * 0.12 / 0.08 a full ring of 8 saw a special every 1.5 s, which stops them feeling special).
 */
export const METER_LAND = 0.06, METER_TAKEN = 0.04, METER_PER_S = 1 / 45;
/** A special's blow is this × the style's normal hit power (× `knock`). */
export const SPECIAL_MULT = 1.8;
/** × `SPECIAL_MULT` per special (balanced with npm run balance: the dash, the dive and the belly slam hit many). */
export const SPECIAL_POWER: Record<SpecialName, number> = {
  megaPunch: 1, jabFlurry: 1, helicopterKick: 1, bellyBomb: 0.8, rocketHeadbutt: 0.6, tornadoTail: 0.9, meteorDive: 0.55,
};
/**
 * While a special runs, a normal blow weaker than this only rocks the fighter (super armour); one this strong or a
 * special cancels it. 1.2 is about the top tenth of landed normal blows: a divebomb's 1.26 breaks it, a kick's or a
 * tail spin's 1.19 does not.
 */
export const ARMOR_POWER = 1.2;
/** Shockwave reach (m) × the fighter's size scale (ringHeight / 1.4). */
export const SHOCK_R = 2.5;
/** No special runs longer than this (s) after its wind-up, whatever happens. */
export const MAX_RELEASE_S = 4;
/**
 * A full meter waits this long (s) for a foe to come in range, then goes anyway; it never goes while another fighter's
 * special is under way (one special at a time in the ring).
 */
export const ENGAGE_WAIT_S = 2;
/** A shockwave's launch: × a normal launch's outward and upward parts (for its special's power), less toward its rim. */
const SW_OUT = 0.2, SW_UP = 1.2;
/** A shockwave runs along the ground: it throws only foes whose torso is at most this (m) over their stand height. */
const SW_AIR = 1;

/** How a blow launches: × the outward and upward parts of a normal launch, and where it comes from. */
export type Blow = { out: number; up: number; from: Vector3 };

/** What a special drives: its fighter's body and muscles, and how it lands blows. */
export interface SpecialBody {
  readonly id: string;
  readonly ragdoll: Ragdoll;
  readonly muscles: Muscles;
  readonly layout: RagdollLayout;
  readonly tune: Tune;
  readonly move: Move;
  readonly reach: number;
  /** Lands a special blow on `o` at `at` (the hit is applied to `o` now); null when `o` cannot be hit. */
  blow(o: Fighter, at: Vector3, power: number, how: Blow): Hit | null;
}

/** One tick of a special: its fighter, the foes it may hit (none while boasting) and where its hits and cues go. */
export type SpecialTickCtx = {
  dt: number;
  me: SpecialBody;
  foes: readonly Fighter[];
  hits: Hit[];
  cue(phase: SpecialCue['phase'], at: Vector3, radius?: number): void;
};

const UP = new Vector3(0, 1, 0);
const flat = (p: Vector3) => new Vector3(p.x, 0, p.z);

/** The foe nearest `me` (horizontally), or null. */
export function nearest(me: Vector3, foes: readonly Fighter[]): Fighter | null {
  let best: Fighter | null = null, bd = Infinity;
  for (const o of foes) {
    if (o.state !== 'fighting' || !o.ragdoll.pieces.length) continue;
    const t = o.ragdoll.torso.body.translation();
    const d = (t.x - me.x) ** 2 + (t.z - me.z) ** 2;
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

/** Whether foe `o` is in play and its torso within `r` (m, plus its torso's radius) of `at`. */
function near(o: Fighter, at: Vector3, r: number): boolean {
  if (o.state !== 'fighting' || !o.ragdoll.pieces.length) return false;
  const t = o.ragdoll.torso.body.translation(), R = r + o.ragdoll.torso.seg.radius;
  return (t.x - at.x) ** 2 + (t.y - at.y) ** 2 + (t.z - at.z) ** 2 < R * R;
}

/** How close (m, torso to torso) a foe must be before each special starts (× size scale); null = any distance. */
export const ENGAGE: Record<SpecialName, number | null> = {
  megaPunch: 3, jabFlurry: 2.2, helicopterKick: 2.6, bellyBomb: 4.5, rocketHeadbutt: null, tornadoTail: 3, meteorDive: 5.5,
};

/**
 * A running special. `t` counts from its start; the wind-up lasts `charge` s, then `release` runs until `done` (or
 * `MAX_RELEASE_S`). Subclasses script the wind-up and the attack.
 */
export abstract class SpecialRun {
  t = 0;
  phase: 'charge' | 'release' = 'charge';
  done = false;
  /** Who this special already struck (once each, unless the script clears it). */
  readonly struck = new Set<Fighter>();
  /** Seconds since the release. */
  rt = 0;
  private impacted = false;
  /** The way it attacks (horizontal unit), fixed at the release. */
  readonly dir = new Vector3(0, 0, 1);

  constructor(readonly name: SpecialName, readonly charge: number) {}

  /** One tick; returns true once it is over (the caller sends `end`). */
  tick(c: SpecialTickCtx): boolean {
    this.t += c.dt;
    if (this.phase === 'charge') {
      const target = nearest(c.me.ragdoll.pos(), c.foes);
      this.windup(c, target);
      if (this.t >= this.charge) {
        this.phase = 'release';
        const p = c.me.ragdoll.pos();
        const to = target ? flat(target.ragdoll.pos().sub(p)) : c.me.muscles.facing();
        if (to.lengthSq() > 1e-6) this.dir.copy(to.normalize());
        else this.dir.copy(c.me.muscles.facing());
        c.cue('release', p);
        this.release(c, target);
      }
      return false;
    }
    this.rt += c.dt;
    this.attack(c);
    return this.done || this.rt >= MAX_RELEASE_S;
  }

  /** Sends `impact` (once per special). */
  protected impact(c: SpecialTickCtx, at: Vector3, radius?: number): void {
    if (this.impacted) return;
    this.impacted = true;
    c.cue('impact', at.clone(), radius);
  }

  /** The special's power: `SPECIAL_MULT` × its style's normal hit. */
  protected power(c: SpecialTickCtx, mul = 1): number {
    return SPECIAL_MULT * MOVE_POWER[c.me.move] * c.me.tune.knock * mul * SPECIAL_POWER[this.name];
  }

  /** Strikes `o` once (per `struck`): the hit goes to `c.hits` and the first one sends `impact`. */
  protected strike(c: SpecialTickCtx, o: Fighter, at: Vector3, power: number, how: Blow, impact = true): void {
    if (this.struck.has(o)) return;
    const h = c.me.blow(o, at, power, how);
    if (!h) return;
    this.struck.add(o);
    c.hits.push(h);
    if (impact) this.impact(c, at);
  }

  /** Strikes (once each) every foe whose torso is within `r` (m, plus its torso's radius) of `at`, with `how` from `from`. */
  protected strikeNear(c: SpecialTickCtx, at: Vector3, r: number, power: number, how: Blow, impact = true): void {
    for (const o of c.foes) if (!this.struck.has(o) && near(o, at, r)) this.strike(c, o, o.ragdoll.pos(), power, how, impact);
  }

  /** A wind-up on its feet: stand, turn to the target and walk in at `walk` × its speed. */
  protected stand(c: SpecialTickCtx, target: Fighter | null, walk: number): void {
    const { me } = c, m = me.muscles, g = me.tune.gravity, R = me.tune.ringRadius;
    const p = me.ragdoll.pos();
    let face = m.facing(), want = new Vector3();
    if (target) {
      const to = flat(target.ragdoll.pos().sub(p));
      const d = to.length();
      if (d > 1e-6) {
        face = to.divideScalar(d);
        if (d > me.reach * 0.7) want = face.clone().multiplyScalar(walk);
      }
    }
    if (m.grounded(R)) m.hover(c.dt, 1, want, g);
    m.stand(c.dt, 1, face, g);
  }

  /** A shockwave on the ground at `at`: every foe near the ground within `r` is thrown UP (harder nearer the middle). */
  protected shockwave(c: SpecialTickCtx, at: Vector3, r: number): void {
    const o0 = flat(at);
    this.impact(c, o0, r);
    for (const o of c.foes) {
      if (o.state !== 'fighting' || !o.ragdoll.pieces.length) continue;
      const p = o.ragdoll.pos(), d = Math.hypot(p.x - o0.x, p.z - o0.z);
      if (d > r || p.y - o.layout.standHeight > SW_AIR) continue; // fliers overhead are not hit again
      const near = 1 - 0.5 * (d / r);
      this.strike(c, o, p, this.power(c, near), { out: SW_OUT, up: SW_UP * near, from: o0 }, false);
    }
  }

  protected windup(c: SpecialTickCtx, target: Fighter | null): void {
    this.stand(c, target, 0.4);
  }

  protected abstract release(c: SpecialTickCtx, target: Fighter | null): void;
  protected abstract attack(c: SpecialTickCtx): void;
}

/** A point `d` m ahead of the torso along `dir`. */
const ahead = (me: SpecialBody, dir: Vector3, d: number) => me.ragdoll.pos().add(dir.clone().multiplyScalar(d));
const k = (me: SpecialBody) => me.muscles.k;

/** Punch: a 0.9 s glowing wind-up, then a giant lunging haymaker. */
class MegaPunch extends SpecialRun {
  constructor() { super('megaPunch', 0.9); }
  protected windup(c: SpecialTickCtx, target: Fighter | null): void {
    this.stand(c, target, 0.35);
    const m = c.me.muscles, w = m.weapons[0];
    m.windup(c.dt, 'punch', c.me.muscles.facing(), w);
  }
  protected release(c: SpecialTickCtx): void {
    const { me } = c, m = me.muscles;
    m.setVelocity(this.dir.clone().multiplyScalar(5.5 * Math.sqrt(k(me))).add(UP.clone().multiplyScalar(1)));
    for (const w of m.weapons) push(w, this.dir.clone().add(UP.clone().multiplyScalar(0.2)), w.mass * 40);
  }
  protected attack(c: SpecialTickCtx): void {
    const { me } = c;
    me.muscles.keepUp(c.dt, 1, me.tune.gravity);
    if (this.rt < 0.5) {
      const zone = ahead(me, this.dir, me.reach * 0.55);
      this.strikeNear(c, zone, me.reach * 0.55 + 0.2 * k(me), this.power(c), { out: 0.35, up: 0.9, from: me.ragdoll.pos() });
    }
    if (this.rt > 0.8) this.done = true;
  }
}

/** Jab: six rapid jabs that pin the foe, then an uppercut pop-up. */
class JabFlurry extends SpecialRun {
  private jabs = 0;
  constructor() { super('jabFlurry', 0.5); }
  protected release(): void {}
  protected attack(c: SpecialTickCtx): void {
    const { me } = c, m = me.muscles, every = 0.13;
    this.stand(c, nearest(me.ragdoll.pos(), c.foes), 0.3);
    const zone = ahead(me, this.dir, me.reach * 0.6), r = me.reach * 0.7 + 0.25 * k(me);
    if (this.jabs < 6 && this.rt >= this.jabs * every) {
      const w = m.weapons[this.jabs % m.weapons.length];
      m.strike('jab', this.dir, w);
      this.struck.clear();
      const tip = tipOf(w), from = me.ragdoll.pos();
      for (const o of c.foes) if (near(o, zone, r)) this.strike(c, o, tip, this.power(c, 0.12), { out: 0.08, up: 0.12, from }, false);
      this.jabs++;
    } else if (this.jabs === 6 && this.rt >= 6 * every + 0.1) {
      const w = m.weapons[0];
      push(w, UP.clone().multiplyScalar(1).add(this.dir.clone().multiplyScalar(0.4)), w.mass * 30);
      this.struck.clear();
      this.strikeNear(c, zone, r + 0.2 * k(me), this.power(c), { out: 0.15, up: 1.25, from: me.ragdoll.pos() });
      this.jabs++;
    } else if (this.jabs > 6 && this.rt >= 6 * every + 0.5) this.done = true;
  }
}

/** Kick: a hop and a fast spin with the legs out for 1.2 s, kicking everyone around. */
class HelicopterKick extends SpecialRun {
  private legs: Piece[] = [];
  /** How far (m) its spinning legs kick, from the torso (set at the release). */
  private reachM = 0;
  constructor() { super('helicopterKick', 0.4); }
  protected release(c: SpecialTickCtx): void {
    const m = c.me.muscles;
    this.legs = [...new Set(m.weapons.flatMap((w) => m.limb(w)))];
    this.reachM = Math.max(...m.weapons.map((w) => m.limbLength(w))) + c.me.ragdoll.torso.seg.radius + 0.4 * k(c.me);
    m.setVelocity(new Vector3(0, 3.5, 0));
  }
  protected attack(c: SpecialTickCtx): void {
    const { me } = c, m = me.muscles, g = me.tune.gravity;
    if (this.rt < 1.2) {
      m.keepUp(c.dt, 1, g);
      m.spin(c.dt, 2.5);
      m.splay(this.legs, 30 * c.dt);
      if (m.grounded(me.tune.ringRadius)) m.hover(c.dt, 1, new Vector3(), g);
      const p = me.ragdoll.pos();
      this.strikeNear(c, p, this.reachM, this.power(c), { out: 0.3, up: 0.8, from: p });
    } else {
      m.stand(c.dt, 1, m.facing(), g);
      if (m.grounded(me.tune.ringRadius)) m.hover(c.dt, 1, new Vector3(), g);
      if (this.rt > 1.5) this.done = true;
    }
  }
}

/** Shared by the jumping slams: up, over, down, BOOM. */
abstract class Slam extends SpecialRun {
  protected falling = false;
  protected landedAt = -1;
  private lastVy = 0;
  /** Where it lands (on the ground, inside the ring). */
  protected readonly aim = new Vector3();
  /** The reach of its shockwave (m). */
  protected radius(c: SpecialTickCtx): number { return SHOCK_R * k(c.me); }
  /** Jump toward `aim`, `h` m high. */
  protected jump(c: SpecialTickCtx, target: Fighter | null, h: number, maxSpeed: number): void {
    const { me } = c, g = me.tune.gravity, p = me.ragdoll.pos();
    this.aimAt(c, target);
    const vy = Math.sqrt(2 * g * h), T = (2 * vy) / g;
    const hv = flat(this.aim.clone().sub(p)).divideScalar(T);
    if (hv.length() > maxSpeed) hv.setLength(maxSpeed);
    me.muscles.setVelocity(hv.setY(vy));
  }
  /**
   * Where to come down: just short of the target (on top of it, its own body would pin it under the slam), inside the
   * ring; where it stands when there is none.
   */
  protected aimAt(c: SpecialTickCtx, target: Fighter | null): void {
    const { me } = c, R = me.tune.ringRadius, p = flat(me.ragdoll.pos());
    if (!target) { this.aim.copy(p); return; }
    const t = flat(target.ragdoll.pos()), back = p.clone().sub(t);
    const short = me.ragdoll.torso.seg.radius + target.ragdoll.torso.seg.radius + 0.2 * k(me);
    this.aim.copy(t).add(back.lengthSq() > 1e-6 ? back.setLength(Math.min(short, back.length())) : back);
    if (this.aim.length() > R - 1) this.aim.setLength(R - 1);
  }

  /** Down: once falling and back near the ground, the shockwave. */
  protected land(c: SpecialTickCtx): boolean {
    const { me } = c, p = me.ragdoll.pos(), vel = me.ragdoll.vel();
    if (this.landedAt >= 0) return true;
    // came down on something (the floor, or a foe it squashed): its fall stopped short
    const stopped = this.falling && this.lastVy < -3 && vel.y > -1;
    this.lastVy = vel.y;
    if (vel.y < 0) this.falling = true;
    const low = p.y < me.layout.standHeight * 1.15;
    if ((this.falling && low) || stopped || (this.rt > 0.3 && low && vel.y <= 0.5) || this.rt > 3) {
      this.landedAt = this.rt;
      // a slam sticks: it stops dead where it lands (no bounce back up)
      const v = me.ragdoll.vel();
      me.muscles.setVelocity(new Vector3(v.x * 0.2, 0, v.z * 0.2));
      this.shockwave(c, p, this.radius(c));
      return true;
    }
    return false;
  }
}

/** Bump: a big jump and a belly slam that throws everyone nearby UP. */
class BellyBomb extends Slam {
  constructor() { super('bellyBomb', 0.5); }
  protected windup(c: SpecialTickCtx, target: Fighter | null): void {
    this.stand(c, target, 0.3);
    push(c.me.ragdoll.torso, UP.clone().negate(), c.me.ragdoll.mass * 4 * c.dt); // squat
  }
  protected release(c: SpecialTickCtx, target: Fighter | null): void {
    this.jump(c, target, 2.6 * Math.sqrt(k(c.me)), 6);
  }
  protected attack(c: SpecialTickCtx): void {
    const { me } = c, m = me.muscles, g = me.tune.gravity;
    m.keepUp(c.dt, 1, g);
    if (this.landedAt < 0) {
      // slam: once past the top, fall faster
      if (this.falling) push(me.ragdoll.torso, UP.clone().negate(), me.ragdoll.mass * 25 * c.dt);
      this.land(c);
    } else {
      if (m.grounded(me.tune.ringRadius)) m.hover(c.dt, 1, new Vector3(), g);
      if (this.rt - this.landedAt > 0.4) this.done = true;
    }
  }
}

/** Headbutt: a rocket dash straight across the ring, bowling through whoever is in the way. */
class RocketHeadbutt extends SpecialRun {
  private stopAt = -1;
  constructor() { super('rocketHeadbutt', 0.7); }
  protected windup(c: SpecialTickCtx, target: Fighter | null): void {
    this.stand(c, target, 0);
    const m = c.me.muscles;
    m.windup(c.dt, 'headbutt', m.facing(), m.weapons[0]);
  }
  protected release(): void {}
  protected attack(c: SpecialTickCtx): void {
    const { me } = c, m = me.muscles, g = me.tune.gravity, R = me.tune.ringRadius, p = me.ragdoll.pos();
    m.stand(c.dt, 1, this.dir, g);
    if (m.grounded(R)) m.hover(c.dt, 1, new Vector3(), g);
    const edge = flat(p).length() > R - 1.2 && flat(p).dot(this.dir) > 0;
    if (this.stopAt < 0 && (this.rt > 1 || edge)) {
      this.stopAt = this.rt;
      const v = me.ragdoll.vel();
      m.setVelocity(new Vector3(v.x * 0.2, 0, v.z * 0.2), true);
    }
    if (this.stopAt < 0) {
      m.setVelocity(this.dir.clone().multiplyScalar(11 * Math.sqrt(k(me))), true);
      const side = new Vector3(-this.dir.z, 0, this.dir.x);
      const r = me.ragdoll.torso.seg.radius + 0.45 * k(me);
      const head = me.ragdoll.head ? me.ragdoll.head.body.translation() : null;
      const at = head ? new Vector3(head.x, head.y, head.z) : p;
      for (const o of c.foes) {
        if (this.struck.has(o) || !(near(o, p, r) || near(o, at, r * 0.8))) continue;
        const op = o.ragdoll.pos();
        const s = Math.sign(flat(op.clone().sub(p)).dot(side)) || 1;
        // bowled aside: thrown forward and off the line
        const from = op.clone().sub(this.dir.clone().add(side.clone().multiplyScalar(s)).normalize());
        this.strike(c, o, op, this.power(c), { out: 0.35, up: 0.8, from });
      }
    } else if (this.rt - this.stopAt > 0.35) this.done = true;
  }
}

/** Spin: a long fast spin that drags nearby fighters in, then flings them. */
class TornadoTail extends SpecialRun {
  constructor() { super('tornadoTail', 0.4); }
  protected release(): void {}
  protected attack(c: SpecialTickCtx): void {
    const { me } = c, m = me.muscles, g = me.tune.gravity, p = me.ragdoll.pos();
    m.keepUp(c.dt, 1, g);
    if (m.grounded(me.tune.ringRadius)) m.hover(c.dt, 1, new Vector3(), g);
    const pull = me.reach * 1.6 + 1.2;
    if (this.rt < 1.8) {
      m.spin(c.dt, 2.5);
      for (const o of c.foes) {
        if (o.state !== 'fighting' || !o.ragdoll.pieces.length) continue;
        const to = flat(p.clone().sub(o.ragdoll.pos()));
        const d = to.length();
        if (d > pull || d < 1e-3) continue;
        to.divideScalar(d);
        const swirl = new Vector3(-to.z, 0, to.x);
        // dragged in (less once close) and round
        push(o.ragdoll.torso, to.multiplyScalar(d > me.reach * 0.6 ? 14 : 0).add(swirl.multiplyScalar(8)), o.ragdoll.mass * c.dt);
      }
    } else {
      this.strikeNear(c, p, me.reach + 0.6 * k(me), this.power(c), { out: 0.35, up: 0.9, from: p });
      this.done = true;
    }
  }
}

/** Divebomb: flies up high, hangs there, then slams down on a foe: a shockwave. */
class MeteorDive extends Slam {
  private hangAt = -1;
  private diving = false;
  constructor() { super('meteorDive', 0.4); }
  protected radius(c: SpecialTickCtx): number { return SHOCK_R * 1.1 * k(c.me); }
  protected release(c: SpecialTickCtx, target: Fighter | null): void {
    const { me } = c, g = me.tune.gravity, p = me.ragdoll.pos();
    const vy = Math.sqrt(2 * g * 2.5);
    const hv = target ? flat(target.ragdoll.pos().sub(p)).divideScalar(vy / g) : new Vector3();
    if (hv.length() > 3) hv.setLength(3);
    me.muscles.setVelocity(hv.setY(vy));
    for (const w of me.muscles.wings) push(w, UP, w.mass * 10);
  }
  protected attack(c: SpecialTickCtx): void {
    const { me } = c, m = me.muscles, g = me.tune.gravity, R = me.tune.ringRadius;
    m.keepUp(c.dt, 1, g);
    if (this.landedAt >= 0) {
      if (m.grounded(R)) m.hover(c.dt, 1, new Vector3(), g);
      if (this.rt - this.landedAt > 0.4) this.done = true;
      return;
    }
    if (!this.diving) {
      if (this.hangAt < 0 && (me.ragdoll.vel().y <= 0 || this.rt > 1.2)) this.hangAt = this.rt;
      if (this.hangAt >= 0) {
        m.float(c.dt, g, 0.15);
        if (this.rt - this.hangAt > 0.25) {
          this.diving = true;
          this.aimAt(c, nearest(me.ragdoll.pos(), c.foes));
          const to = this.aim.clone().sub(me.ragdoll.pos());
          if (to.y > -0.5) to.y = -0.5;
          m.setVelocity(to.normalize().multiplyScalar(18));
          this.falling = true;
        }
      }
      return;
    }
    this.land(c);
  }
}

const SCRIPTS: Record<SpecialName, () => SpecialRun> = {
  megaPunch: () => new MegaPunch(),
  jabFlurry: () => new JabFlurry(),
  helicopterKick: () => new HelicopterKick(),
  bellyBomb: () => new BellyBomb(),
  rocketHeadbutt: () => new RocketHeadbutt(),
  tornadoTail: () => new TornadoTail(),
  meteorDive: () => new MeteorDive(),
};

/** A fresh run of the special for a style of fighting. */
export const specialFor = (move: Move): SpecialRun => SCRIPTS[SPECIAL_FOR[move]]();
/** A fresh run of a named special. */
export const startSpecial = (name: SpecialName): SpecialRun => SCRIPTS[name]();
