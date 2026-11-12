import type RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three/webgpu';
import type { RagdollLayout } from '../physics/layout';
import { Ragdoll, type Piece } from '../physics/ragdoll';
import { Brain, type AttackPhase } from './brain';
import { Muscles, endsOf, push, tipOf } from './muscles';
import { MOVE_POWER, MOVE_TIMING, knockMultiplier, type Tune } from './tune';
import type { FightPlan, Move } from './types';

export type FighterState = 'entering' | 'fighting' | 'out' | 'gone';

/** What one fighter's tick sees: the others in the ring, whether it is strutting alone (or as champion), the tuning. */
export type FightCtx = { others: readonly Fighter[]; boast: boolean; tune: Tune; rng: () => number };

/** A landed hit (already applied to the target). `launch` is the knockback velocity it was given (m/s). */
export type Hit = { attacker: Fighter; target: Fighter; at: Vector3; power: number; launch: number };

/** A ball that hurts: a weapon point and its radius. */
type Weapon = { at: Vector3; r: number };

/** Extra slack (m) when testing a weapon against a body. */
const HIT_SLACK = 0.15;
/** A body lying over the bumper this long (s) is popped off it, outward and up (m/s). */
const BUMPER_WAIT = 3, BUMPER_OUT = 4, BUMPER_UP = 2;

/**
 * One fighter in the ring: its ragdoll, muscles and brain, how stunned and wobbly it is and how many hits it landed.
 * The fight loop calls `think` for every fighter once per physics step, then steps the world.
 */
export class Fighter {
  readonly ragdoll: Ragdoll;
  state: FighterState = 'entering';
  /** Seconds of full ragdoll left. */
  stun = 0;
  /** Hit power taken, healing slowly: knockback grows with it. */
  wobble = 0;
  /** Hits this fighter landed. */
  hits = 0;
  private recover = 1;
  private readonly muscles: Muscles;
  private readonly brain: Brain<Fighter>;
  private tune: Tune;
  private rng: () => number;
  private started = false;
  private onBumper = 0;
  private readonly reachM: number;

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

    const live = ctx.others.filter((o) => o !== this && o.state === 'fighting');
    const { want, face } = this.brain.steer(this.ragdoll.pos(), t, live, ctx.boast, this.reach, R, tune.edgeMargin, ctx.rng);
    const grounded = m.grounded(R);
    if (grounded && str > 0) m.hover(dt, str, want, tune.gravity);
    m.stand(dt, str, face, tune.gravity);
    m.waddle(dt, str, this.brain.face, grounded);
    m.flapSave(dt, R, ctx.rng);

    const hits = this.attackTick(dt, str, ctx.boast ? [] : live);
    this.bumperRule(dt, R);
    return hits;
  }

  /** Knocked by a hit from `from` (the attacker's torso): wobblier, stunned, flying. */
  knock(from: Vector3, power: number): void {
    this.takeHit(from, power);
  }

  dispose(): void {
    this.ragdoll.dispose();
    this.state = 'gone';
  }

  /** Muscle strength this tick: 0 while stunned (full ragdoll), then a quadratic scramble back over `recoverS`. */
  private strength(dt: number): number {
    if (this.stun > 0) { this.stun -= dt; this.recover = 0; }
    else this.recover = Math.min(1, this.recover + dt / this.tune.recoverS);
    return this.stun > 0 ? 0 : this.recover * this.recover;
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
    if (step.burst) m.strike(move, a.dir, w);
    const hits: Hit[] = [];
    if (!step.strike) return hits;
    if (move === 'spin') m.spin(dt);
    if (a.harmless) return hits;
    const weapons = this.weaponPoints(w);
    for (const o of targets) {
      if (a.hit.has(o)) continue;
      const body = [o.ragdoll.torso, o.ragdoll.head].filter((p): p is Piece => p !== null);
      for (const wp of weapons) {
        if (!body.some((p) => distToPiece(wp.at, p) < p.seg.radius + wp.r + HIT_SLACK)) continue;
        a.hit.add(o);
        const power = MOVE_POWER[move] * this.tune.knock;
        const launch = o.takeHit(this.ragdoll.pos(), power);
        this.hits++;
        hits.push({ attacker: this, target: o, at: wp.at.clone(), power, launch });
        break;
      }
    }
    return hits;
  }

  /** Where the move hurts (the spike's weapons, taken from the plan's weapon pieces). `w` is this swing's weapon. */
  private weaponPoints(w: Piece): Weapon[] {
    const m = this.muscles, torso = this.ragdoll.torso;
    switch (this.move) {
      case 'punch': case 'jab': return [{ at: tipOf(w), r: w.seg.radius }];
      case 'kick': return m.weapons.map((p) => ({ at: tipOf(p), r: p.seg.radius * 1.6 }));
      case 'bump': return m.weapons.map((p) => ({
        at: centre(p).add(this.brain.atk.dir.clone().multiplyScalar(p.seg.radius * 0.6)), r: p.seg.radius * 0.75,
      }));
      case 'headbutt': return m.weapons.map((p) => ({ at: centre(p), r: p.seg.radius * 1.1 }));
      case 'divebomb': return [...m.weapons.map((p) => ({ at: centre(p), r: p.seg.radius * 1.1 })), { at: centre(torso), r: torso.seg.radius }];
      case 'spin': return m.weapons.map((p) => ({ at: tipOf(p), r: 0.3 * m.k }));
    }
  }

  /** The spike's knock: returns the knockback velocity (m/s) given. */
  private takeHit(from: Vector3, power: number): number {
    const rng = this.rng, M = this.ragdoll.mass;
    const d = this.ragdoll.pos().sub(from).setY(0);
    if (d.lengthSq() < 1e-4) d.set(rng() - 0.5, 0, rng() - 0.5);
    d.normalize();
    this.wobble += power;
    const mult = knockMultiplier(this.wobble, this.tune.build);
    const dv = (power * 2.6 * mult) / M ** 0.3;
    push(this.ragdoll.torso, d.multiplyScalar(0.85).add(new Vector3(0, 0.45 + Math.min(0.5, mult * 0.12), 0)), M * dv);
    const spin = M * 0.4 * dv * this.tune.spin;
    this.ragdoll.torso.body.applyTorqueImpulse({ x: (rng() - 0.5) * spin, y: (rng() - 0.5) * spin, z: (rng() - 0.5) * spin }, true);
    this.stun = this.tune.flop * (0.45 + power * 0.18);
    this.recover = 0;
    this.brain.interrupt();
    return dv;
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

const centre = (p: Piece) => {
  const t = p.body.translation();
  return new Vector3(t.x, t.y, t.z);
};

/** Distance from `x` to a piece's capsule axis (its segment from end to end). */
function distToPiece(x: Vector3, p: Piece): number {
  const [a, b] = endsOf(p);
  const ab = b.clone().sub(a);
  const l2 = ab.lengthSq();
  const s = l2 > 1e-12 ? Math.min(1, Math.max(0, x.clone().sub(a).dot(ab) / l2)) : 0;
  return a.addScaledVector(ab, s).distanceTo(x);
}
