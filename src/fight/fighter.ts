import type RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three/webgpu';
import type { RagdollLayout } from '../physics/layout';
import { Ragdoll, type Piece } from '../physics/ragdoll';
import { Brain, type AttackPhase } from './brain';
import { Muscles, push } from './muscles';
import { MOVE_POWER, MOVE_TIMING, launchFor, type Tune } from './tune';
import { SPECIAL_FOR, type SpecialCue, type SpecialName, type SpecialState } from './special';
import {
  ARMOR_POWER, ENGAGE, ENGAGE_WAIT_S, METER_LAND, METER_PER_S, METER_TAKEN, nearest, specialFor, type Blow, type SpecialBody,
  type SpecialRun,
} from './specials';
import type { FightPlan, Move } from './types';

export type FighterState = 'entering' | 'fighting' | 'out' | 'gone';

/** What one fighter's tick sees: the others in the ring, whether it is strutting alone (or as champion), the tuning. */
export type FightCtx = { others: readonly Fighter[]; boast: boolean; tune: Tune; rng: () => number };

/**
 * A landed hit (already applied to the target). `launch` is the knockback velocity it was given (m/s); `special` is set
 * when the hit came from a special attack.
 */
export type Hit = { attacker: Fighter; target: Fighter; at: Vector3; power: number; launch: number; special?: SpecialName };

/** A ball that hurts: a weapon point and its radius. */
type Weapon = { at: Vector3; r: number };

/** Extra slack (m) when testing a weapon against a body (0.15 before big fights: fliers land out of reach more). */
const HIT_SLACK = 0.3;
/** A body lying over the bumper this long (s) is popped off it, outward and up (m/s). */
const BUMPER_WAIT = 3, BUMPER_OUT = 4, BUMPER_UP = 2;
/**
 * A launched fighter stays limp until it is down again: torso back under this x its stand height and not rising, at
 * least `AIR_MIN` s after the launch, at most `AIR_MAX` s.
 */
const AIR_LOW = 1.3, AIR_MIN = 0.2, AIR_MAX = 3;
/** A limp flier falls with this much extra gravity (× `tune.gravity`) once past the top: a floaty rise, a quicker drop. */
const FALL = 0.8;
const DOWN = new Vector3(0, -1, 0);
/** A flier's level speed may be its launch's outward part plus this (m/s). */
const AIR_SLACK = 1;
/** The fastest (m/s) a torso may climb: in a special, hopping (a divebomb) and otherwise (not launched). */
const SPECIAL_UP_MAX = 12, HOP_UP_MAX = 10, STUMBLE_UP_MAX = 5;
/** Tumble on launch: about the torso's spin (rad/s), head over heels, for a 6 m/s pop. */
const TUMBLE = 7;
/** A swing reaches this much lower (m, × size scale) at a foe that is down. */
const DOWN_REACH = 0.5;
/** A normal blow on a fighter in the middle of a special (super armour) pushes this x as hard and does not stun. */
const ARMORED = 0.3;
/** A special starts only from a steady stance: at least this far back to full strength. */
const STEADY = 0.9;

/**
 * One fighter in the ring: its ragdoll, muscles and brain, how stunned and wobbly it is and how many hits it landed.
 * The fight loop calls `think` for every fighter once per physics step, then steps the world.
 */
export class Fighter {
  readonly ragdoll: Ragdoll;
  private _state: FighterState = 'entering';
  /** Seconds of full ragdoll left. */
  stun = 0;
  /** Hit power taken, healing slowly: knockback grows with it. */
  wobble = 0;
  /** Hits this fighter landed. */
  hits = 0;
  /** Its special attack: the meter filling toward it, and which special is under way (null when none). */
  readonly special: SpecialState = { meter: 0, active: null };
  /** 0–1: back to full strength after a stun (1 = steady). */
  private recover = 1;
  private readonly muscles: Muscles;
  private readonly brain: Brain<Fighter>;
  private tune: Tune;
  private rng: () => number;
  private started = false;
  private onBumper = 0;
  private readonly reachM: number;
  /** Launched and not yet down: limp. */
  private airborne = false;
  private airT = 0;
  /** While launched, its flight's level speed is held under this (m/s): the launch's own outward part, plus a little. */
  private airCap = 0;
  /** Its latest launch's pop (m/s). */
  private airUp = 0;
  /** The special under way. */
  private run: SpecialRun | null = null;
  /** How long (s) the meter has been full. */
  private fullFor = 0;
  /** Special cues not yet collected (`takeCues`). */
  private cues: SpecialCue[] = [];
  /** Where it was when let go (for a special's `end` cue after its body is gone). */
  private readonly lastPos = new Vector3();
  private readonly rig: SpecialBody;
  /** How far (m) any part of this body can reach from its torso's centre: a cheap first cull for hit checks. */
  private readonly extent: number;
  /** This swing's weapon points, reused every tick (`weaponPoints` fills the first few). */
  private readonly wps: Weapon[];

  /**
   * Builds its own ragdoll from `layout` in `world`, standing at the origin (place it with `ragdoll.pose`). `tune` and
   * `rng` serve `knock` until the first `think`, which takes them from its context from then on.
   */
  constructor(readonly id: string, world: RAPIER.World, readonly layout: RagdollLayout, readonly plan: FightPlan,
    opts: { tune: Tune; rng: () => number }) {
    this.tune = opts.tune;
    this.rng = opts.rng;
    this.ragdoll = new Ragdoll(world, layout, { bounce: opts.tune.bounce });
    this.muscles = new Muscles(this.ragdoll, layout);
    this.brain = new Brain<Fighter>(id, this.muscles.weapons.length);
    this.reachM = reachFor(plan.move, this.muscles);
    this.extent = extentOf(this.ragdoll);
    this.wps = Array.from({ length: this.muscles.weapons.length + 1 }, () => ({ at: new Vector3(), r: 0 }));
    const self = this;
    this.rig = {
      id, ragdoll: this.ragdoll, muscles: this.muscles, layout, move: plan.move,
      get tune() { return self.tune; },
      get reach() { return self.reachM; },
      blow: (o, at, power, how) => this.blow(o, at, power, how),
    };
  }

  /** In the ring and fighting, entering, out (fell) or gone (let go). Leaving `fighting` ends a special under way. */
  get state(): FighterState { return this._state; }
  set state(s: FighterState) {
    this._state = s;
    if (s !== 'fighting') this.endSpecial();
  }

  /**
   * Its special is called off and its meter emptied (the crowning, "Again!"): a special under way ends (its `end` cue
   * goes as usual), the meter is 0 and the wait for a foe in range starts again.
   */
  resetSpecial(): void {
    this.endSpecial();
    this.special.meter = 0;
    this.fullFor = 0;
  }

  /** Launched by a blow and not down yet (limp in the air). */
  get flying(): boolean { return this.airborne; }

  /** The special cues since the last call (the loop collects them every step). */
  takeCues(): SpecialCue[] {
    if (!this.cues.length) return [];
    const out = this.cues;
    this.cues = [];
    return out;
  }

  get move(): Move { return this.plan.move; }
  /** Where the current attack is: wind-up, strike window, cool-down or none. */
  get attack(): AttackPhase { return this.brain.atk.phase; }

  /** How close (m, torso to torso) it gets before starting its move: the spike's reach, scaled to its size. */
  get reach(): number { return this.reachM; }

  /** Start the signature move where it stands, with no hit checks: an entrance showing what it can do. */
  showOff(): void {
    this.brain.face.copy(this.muscles.facing());
    this.brain.startAttack(this.brain.face, this.rng, true);
  }

  /** One physics tick of brain and muscles. Returns the hits it landed (each already knocked into its target). */
  think(dt: number, t: number, ctx: FightCtx): Hit[] {
    this.tune = ctx.tune;
    this.rng = ctx.rng;
    if (this.state === 'entering') {
      if (this.brain.atk.phase !== 'none') this.showTick(dt);
      return [];
    }
    if (this.state !== 'fighting') return [];
    if (!this.started) { this.started = true; this.brain.boastAt = t + 1.5; } // a breath before the first strut

    const tune = ctx.tune, R = tune.ringRadius, m = this.muscles;
    this.wobble = Math.max(0, this.wobble - dt * tune.heal);
    const str = this.strength(dt);

    this.noCatapult();
    const live = ctx.others.filter((o) => o !== this && o.state === 'fighting');
    const foes = ctx.boast ? [] : live;
    // a stunned fighter (a big blow, or held limp for the crowning) has no special: it ends, and none starts (`ready`)
    if (this.run && this.stun > 0) this.endSpecial();
    if (this.run) {
      const hits = this.specialTick(dt, foes);
      this.bumperRule(dt, R);
      return hits;
    }
    if (foes.length) this.fill(dt * METER_PER_S);
    if (this.ready(dt, str, foes, ctx.others, R)) {
      this.beginSpecial();
      return [];
    }
    const { want, face } = this.brain.steer(this.ragdoll.pos(), t, live, ctx.boast, this.reach, R, tune.edgeMargin, ctx.rng);
    const grounded = m.grounded(R);
    if (grounded && str > 0) m.hover(dt, str, want, tune.gravity);
    m.stand(dt, str, face, tune.gravity);
    m.waddle(dt, str, this.brain.face, grounded);
    if (!this.airborne) m.flapSave(dt, R, ctx.rng, tune.gravity); // limp in the air: no flapping

    const hits = this.attackTick(dt, str, foes);
    this.fill(METER_LAND * hits.length);
    this.bumperRule(dt, R);
    return hits;
  }

  /**
   * Whether its special starts now: meter full, nobody else's special under way (one at a time in the ring, however long
   * it has waited), steady on its feet, between attacks, a foe in range (or waited long enough).
   */
  private ready(dt: number, str: number, foes: readonly Fighter[], ring: readonly Fighter[], R: number): boolean {
    if (this.special.meter < 1) { this.fullFor = 0; return false; }
    this.fullFor += dt;
    if (ring.some((o) => o !== this && o.special.active !== null)) return false;
    if (!foes.length || this.stun > 0 || this.airborne || str < STEADY * STEADY || this.brain.atk.phase !== 'none') return false;
    if (!this.muscles.grounded(R)) return false;
    const range = ENGAGE[SPECIAL_FOR[this.move]];
    if (range === null || this.fullFor >= ENGAGE_WAIT_S) return true;
    const o = nearest(this.ragdoll.pos(), foes);
    return !!o && !o.flying && o.ragdoll.pos().distanceTo(this.ragdoll.pos()) < range * this.muscles.k + this.reach * 0.3;
  }

  private fill(by: number): void {
    if (!this.run && by > 0) this.special.meter = Math.min(1, this.special.meter + by);
  }

  /** The meter is spent: the wind-up starts. */
  private beginSpecial(): void {
    this.run = specialFor(this.move);
    this.special.meter = 0;
    this.special.active = this.run.name;
    this.fullFor = 0;
    this.cue('charge', this.ragdoll.pos());
  }

  /** One tick of the special under way; it ends (with its `end` cue) when its script is over. */
  private specialTick(dt: number, foes: readonly Fighter[]): Hit[] {
    const run = this.run!, hits: Hit[] = [];
    const over = run.tick({ dt, me: this.rig, foes, hits, cue: (phase, at, radius) => this.cue(phase, at, radius) });
    this.hits += hits.length;
    if (over) this.endSpecial();
    return hits;
  }

  /** Ends the special under way (if any): `end` is sent, the meter starts again from empty and the brain takes over. */
  private endSpecial(): void {
    if (!this.run) return;
    const name = this.run.name;
    this.run = null;
    this.special.active = null;
    this.special.meter = 0;
    this.fullFor = 0;
    const at = this.ragdoll.pieces.length ? this.ragdoll.pos() : this.lastPos.clone();
    this.cues.push({ id: this.cueId(), special: name, phase: 'end', at });
    if (this.brain.atk.phase !== 'none') this.brain.interrupt();
  }

  /** A cue names its fighter (the show finds the fighter by it). */
  private cueId(): string { return this.id; }

  private cue(phase: SpecialCue['phase'], at: Vector3, radius?: number): void {
    if (!this.run) return;
    const c: SpecialCue = { id: this.cueId(), special: this.run.name, phase, at: at.clone() };
    if (radius !== undefined) c.radius = radius;
    this.cues.push(c);
  }

  /** A special's blow on `o`: applied now, counted as this fighter's hit. */
  private blow(o: Fighter, at: Vector3, power: number, how: Blow): Hit | null {
    if (o === this || o.state !== 'fighting' || !o.ragdoll.pieces.length || !this.run) return null;
    const name = this.run.name;
    const launch = o.takeHit(how.from, power, { out: how.out, up: how.up, special: true });
    return { attacker: this, target: o, at: at.clone(), power, launch, special: name };
  }

  /** Knocked by a hit from `from` (the attacker's torso): wobblier, stunned, flying. */
  knock(from: Vector3, power: number): void {
    if (!this.ragdoll.pieces.length) return;
    this.takeHit(from, power, {});
  }

  dispose(): void {
    if (this.ragdoll.pieces.length) this.lastPos.copy(this.ragdoll.pos());
    this.endSpecial();
    this.ragdoll.dispose();
    this.state = 'gone';
  }

  /**
   * Muscle strength this tick: 0 while stunned (full ragdoll) or launched and not yet down (limp in the air), then a
   * quadratic scramble back over `recoverS`.
   */
  private strength(dt: number): number {
    if (this.airborne) {
      this.airT += dt;
      const p = this.ragdoll.pos(), vy = this.ragdoll.vel().y;
      const down = this.airT >= AIR_MIN && p.y < this.layout.standHeight * AIR_LOW && vy < 1;
      if (down || this.airT >= AIR_MAX) this.airborne = false;
      else {
        this.stun = Math.max(this.stun, dt * 1.01);
        this.capFlight();
        // cartoon fall: a floaty rise, a quicker drop
        if (vy < 0) push(this.ragdoll.torso, DOWN, this.ragdoll.mass * this.tune.gravity * FALL * dt);
      }
    }
    if (this.stun > 0) { this.stun -= dt; this.recover = 0; }
    else this.recover = Math.min(1, this.recover + dt / this.tune.recoverS);
    return this.stun > 0 ? 0 : this.recover * this.recover;
  }

  /**
   * A heavy body landing hard on its light feet can be flung back up by the physics (the solver pushing the feet out
   * of the floor): faster than anything sent it. Its climb is trimmed to what it may have: a launch's pop, its own
   * hop or special, else a stumble.
   */
  private noCatapult(): void {
    const vy = this.ragdoll.vel().y;
    const cap = this.run ? SPECIAL_UP_MAX : this.airborne ? this.airUp + 1
      : this.move === 'divebomb' && this.brain.atk.phase === 'strike' ? HOP_UP_MAX : STUMBLE_UP_MAX;
    if (vy <= cap) return;
    const dv = vy - cap;
    for (const p of this.ragdoll.pieces) {
      const v = p.body.linvel();
      p.body.setLinvel({ x: v.x, y: v.y - dv, z: v.z }, true);
    }
  }

  /**
   * A flier goes as far as its launch sends it, not as far as a body slam or a tangle of limbs flings it: its level
   * speed (the whole body's) is trimmed to `airCap`, so how far it flies still grows with wobble.
   */
  private capFlight(): void {
    let mx = 0, mz = 0, m = 0;
    for (const p of this.ragdoll.pieces) {
      const v = p.body.linvel();
      mx += v.x * p.mass; mz += v.z * p.mass; m += p.mass;
    }
    const vx = mx / m, vz = mz / m, sp = Math.hypot(vx, vz);
    if (sp <= this.airCap) return;
    const k = 1 - this.airCap / sp, dx = -vx * k, dz = -vz * k;
    for (const p of this.ragdoll.pieces) {
      const v = p.body.linvel();
      p.body.setLinvel({ x: v.x + dx, y: v.y, z: v.z + dz }, true);
    }
  }

  /** Entering, showing off: stand in place and play the move. */
  private showTick(dt: number): void {
    const m = this.muscles;
    if (m.grounded(this.tune.ringRadius)) m.hover(dt, 1, new Vector3(), this.tune.gravity);
    m.stand(dt, 1, this.brain.face, this.tune.gravity);
    this.attackTick(dt, 1, []);
  }

  /** The attack's wind-up, strike burst and hit checks against `targets`. */
  private attackTick(dt: number, str: number, targets: readonly Fighter[]): Hit[] {
    const a = this.brain.atk, m = this.muscles, move = this.move;
    const w = m.weapons[a.side % m.weapons.length];
    const step = this.brain.tick(dt, str, MOVE_TIMING[move]);
    if (step.windup) m.windup(dt, move, a.dir, w);
    if (step.burst) m.strike(move, a.dir, w, this.tune.gravity);
    const hits: Hit[] = [];
    if (!step.strike) return hits;
    if (move === 'spin') m.spin(dt);
    if (a.harmless) return hits;
    const n = this.weaponPoints(w);
    const power = MOVE_POWER[move] * this.tune.knock;
    for (const o of targets) {
      if (a.hit.has(o)) continue;
      // a foe that is down (knocked flat, scrambling up) is hit by a swing passing just over it: whacked off the floor
      const down = o.stun > 0 || o.recover < 1 ? DOWN_REACH * m.k : 0;
      const t = o.ragdoll.torso.body.translation();
      for (let i = 0; i < n; i++) {
        const wp = this.wps[i];
        // cheap cull: out of reach of any part of it
        const cull = o.extent + wp.r + HIT_SLACK + down;
        if ((wp.at.x - t.x) ** 2 + (wp.at.y - t.y) ** 2 + (wp.at.z - t.z) ** 2 > cull * cull) continue;
        if (!touches(o, wp, down)) continue;
        a.hit.add(o);
        const launch = o.takeHit(this.ragdoll.pos(), power, {});
        this.hits++;
        hits.push({ attacker: this, target: o, at: wp.at.clone(), power, launch });
        break;
      }
    }
    return hits;
  }

  /**
   * Where the move hurts (the spike's weapons, taken from the plan's weapon pieces), into `wps`; returns how many. `w` is
   * this swing's weapon.
   */
  private weaponPoints(w: Piece): number {
    const ws = this.muscles.weapons, torso = this.ragdoll.torso, k = this.muscles.k;
    switch (this.move) {
      case 'punch': case 'jab': this.setWp(0, w, true, w.seg.radius); return 1;
      case 'kick': for (let i = 0; i < ws.length; i++) this.setWp(i, ws[i], true, ws[i].seg.radius * 1.6); return ws.length;
      case 'bump':
        for (let i = 0; i < ws.length; i++) {
          this.setWp(i, ws[i], false, ws[i].seg.radius * 0.75);
          this.wps[i].at.addScaledVector(this.brain.atk.dir, ws[i].seg.radius * 0.6);
        }
        return ws.length;
      case 'headbutt': for (let i = 0; i < ws.length; i++) this.setWp(i, ws[i], false, ws[i].seg.radius * 1.1); return ws.length;
      case 'divebomb':
        for (let i = 0; i < ws.length; i++) this.setWp(i, ws[i], false, ws[i].seg.radius * 1.1);
        this.setWp(ws.length, torso, false, torso.seg.radius);
        return ws.length + 1;
      case 'spin': for (let i = 0; i < ws.length; i++) this.setWp(i, ws[i], true, 0.3 * k); return ws.length;
    }
  }

  /** Weapon point `i`: piece `p`'s tip (or centre), `r` m round. */
  private setWp(i: number, p: Piece, tip: boolean, r: number): void {
    const wp = this.wps[i];
    if (tip) tipInto(p, wp.at);
    else centreInto(p, wp.at);
    wp.r = r;
  }

  /**
   * Knocked by a blow from `from`: wobblier, popped UP (big from the first hit) and away (growing with wobble), tumbling,
   * stunned and limp until it is down again (`launchFor`). Returns the launch speed (m/s) given. In the middle of its own
   * special a fighter shrugs off a weak normal blow (pushed a little, not stunned); a strong one or a special cancels it.
   */
  private takeHit(from: Vector3, power: number, how: { out?: number; up?: number; special?: boolean }): number {
    const rng = this.rng, M = this.ragdoll.mass;
    const d = this.ragdoll.pos().sub(from).setY(0);
    if (d.lengthSq() < 1e-4) d.set(rng() - 0.5, 0, rng() - 0.5);
    d.normalize();
    this.wobble += power;
    const armored = !!this.run && !how.special && power < ARMOR_POWER;
    if (!armored) this.endSpecial();
    this.fill(METER_TAKEN);
    const { out, up } = launchFor(power, this.wobble, M, this.tune, how);
    const k = armored ? ARMORED : 1;
    // the pop lifts it to `up` m/s, not on top of a flight already under way (no juggling to the rafters)
    const lift = Math.max(0, up * k - Math.max(0, this.ragdoll.vel().y));
    push(this.ragdoll.torso, d.clone().multiplyScalar(out * k).add(new Vector3(0, lift, 0)), M);
    if (armored) return Math.hypot(out, up) * k;
    const dv = out / 0.85;
    const spin = M * 0.4 * dv * this.tune.spin;
    this.ragdoll.torso.body.applyTorqueImpulse({ x: (rng() - 0.5) * spin, y: (rng() - 0.5) * spin, z: (rng() - 0.5) * spin }, true);
    // and a tumble head over heels, away from the blow
    const torso = this.ragdoll.torso, r = torso.seg.radius;
    const flip = new Vector3(d.z, 0, -d.x).multiplyScalar(TUMBLE * (up / 6) * 0.8 * M * r * r);
    torso.body.applyTorqueImpulse({ x: flip.x, y: 0, z: flip.z }, true);
    // never shorter than a stun it already has (a crowning holds the losers limp for good)
    this.stun = Math.max(this.stun, this.tune.flop * (0.45 + power * 0.18));
    this.recover = 0;
    if (!this.airborne) this.airCap = 0;
    this.airborne = true;
    this.airT = 0;
    this.airCap = Math.max(this.airCap, out + AIR_SLACK);
    this.airUp = Math.max(up, this.ragdoll.vel().y);
    this.brain.interrupt();
    return Math.hypot(out, up);
  }

  /** Nobody rests on the bumper: a torso over it (past the ring's edge, not yet falling) for 3 s is popped off. */
  private bumperRule(dt: number, R: number): void {
    const p = this.ragdoll.pos(), flat = new Vector3(p.x, 0, p.z);
    this.onBumper = flat.length() > R && p.y > -0.5 ? this.onBumper + dt : 0;
    if (this.onBumper <= BUMPER_WAIT) return;
    this.onBumper = 0;
    push(this.ragdoll.torso, flat.normalize().multiplyScalar(BUMPER_OUT).add(new Vector3(0, BUMPER_UP, 0)), this.ragdoll.mass);
  }
}

/** The spike's reach per move, from the body's own size: torso radius, limb length and ringHeight / 1.4. */
function reachFor(move: Move, m: Muscles): number {
  const k = m.k, torsoR = m.body.torso.seg.radius;
  const limb = Math.max(...m.weapons.map((w) => m.limbLength(w)));
  switch (move) {
    case 'punch': return torsoR + limb + 0.9 * k;
    case 'jab': return 1.1 * k;
    case 'kick': return limb + torsoR + 0.6 * k;
    case 'bump': return Math.max(...m.weapons.map((w) => w.seg.radius)) + 1.6 * k;
    case 'headbutt': return 3.2 * k;
    case 'spin': return 1.9 * k;
    case 'divebomb': return 2.6 * k;
  }
}

/** Scratch for the hit checks (they allocate nothing of their own per tick). */
const _q = new Quaternion(), _ax = new Vector3(), _d = new Vector3(), _low = new Vector3();

/** Half a piece's capsule length (m). */
const halfLength = (p: Piece) => Math.hypot(p.seg.b.x - p.seg.a.x, p.seg.b.y - p.seg.a.y, p.seg.b.z - p.seg.a.z) / 2;

/** A piece's centre, into `out`. */
function centreInto(p: Piece, out: Vector3): Vector3 {
  const t = p.body.translation();
  return out.set(t.x, t.y, t.z);
}

/** A piece's capsule axis (unit, its local +y) in the world, into `out`. */
function axisInto(p: Piece, out: Vector3): Vector3 {
  const r = p.body.rotation();
  return out.set(0, 1, 0).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
}

/** The far end (`b`) of a piece's capsule, into `out`. */
function tipInto(p: Piece, out: Vector3): Vector3 {
  const h = halfLength(p);
  axisInto(p, _ax);
  return centreInto(p, out).addScaledVector(_ax, h);
}

/** Distance from `x` to a piece's capsule axis (its segment from end to end). */
function distToPiece(x: Vector3, p: Piece): number {
  const h = halfLength(p);
  axisInto(p, _ax);
  centreInto(p, _d);
  _d.subVectors(x, _d);
  const s = Math.max(-h, Math.min(h, _d.dot(_ax)));
  return _d.addScaledVector(_ax, -s).length();
}

/** Whether weapon `wp` touches any part of `o` (also `down` m lower, for a foe that is down). */
function touches(o: Fighter, wp: Weapon, down: number): boolean {
  if (down) _low.copy(wp.at).setY(wp.at.y - down);
  for (const p of o.ragdoll.pieces) {
    const r = p.seg.radius + wp.r + HIT_SLACK;
    if (distToPiece(wp.at, p) < r || (down && distToPiece(_low, p) < r)) return true;
  }
  return false;
}

/**
 * How far (m) any part of a ragdoll can be from its torso's centre, however its joints turn: each piece's farthest
 * point is at most its joint's farthest reach plus its own length and radius.
 */
function extentOf(rag: Ragdoll): number {
  const torso = rag.torso, joint: number[] = [];
  let most = halfLength(torso) + torso.seg.radius;
  for (const p of rag.pieces) {
    if (p === torso) continue;
    const parent = rag.pieces[p.seg.parent];
    const a = p.seg.anchor, c = torso.restP;
    const j = parent === torso ? Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z) : joint[p.seg.parent] + 2 * halfLength(parent);
    joint[p.seg.id] = j;
    most = Math.max(most, j + 2 * halfLength(p) + p.seg.radius);
  }
  return most + 0.05;
}
