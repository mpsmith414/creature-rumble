import { Vector3 } from 'three/webgpu';
import { fnv1a } from '../util/hash';

/**
 * A fighter's brain (the spike's Creature.think, spike/creature.ts): pick a sticky target, walk at it, attack when in
 * reach, steer back from the edge; alone (or as champion) strut round the ring showing off the signature move.
 */

export type AttackPhase = 'none' | 'windup' | 'strike' | 'cool';

/** What the brain needs to know about another fighter. */
export type Rival = { readonly state: string; readonly ragdoll: { pos(): Vector3 }; /** Launched and not down yet. */ readonly flying?: boolean };

/** Strut circle radius (× ring radius) and speed (rad/s) when showing off. */
const STRUT_R = 0.42, STRUT_RATE = 0.6;
/** Pushed back from the edge this hard (per metre past `edgeMargin`). */
const EDGE_PUSH = 1.8;
/** In reach: creep in at this fraction of full speed. */
const CREEP = 0.15;
/** Turn toward the wanted facing by this fraction each tick. */
const TURN = 0.2;

export class Brain<F extends Rival> {
  target: F | null = null;
  /** Unit, horizontal: the way it is turning to face (smoothed). */
  readonly face = new Vector3(0, 0, 1);
  readonly atk = {
    phase: 'none' as AttackPhase,
    t: 0,
    dir: new Vector3(0, 0, 1),
    side: 0,
    coolMul: 1,
    /** Who this attack already hit (once each). */
    hit: new Set<F>(),
    /** A show-off: no hit checks. */
    harmless: false,
  };
  private retargetAt = 0;
  boastAt = 0;
  /** Where on the strut circle this fighter walks (the spike used its numeric id). */
  private readonly strutPhase: number;

  constructor(id: string, private readonly weaponCount: number) {
    this.strutPhase = (parseInt(fnv1a(id), 16) / 0x100000000) * Math.PI * 2;
  }

  /**
   * Decide this tick: returns `want` (horizontal, length ≤ 1 before edge steering: where to walk, × walking speed)
   * and `face` (the facing the torso turns to this tick). May start an attack.
   */
  steer(pos: Vector3, t: number, live: readonly F[], boast: boolean, reach: number,
    R: number, edgeMargin: number, rng: () => number): { want: Vector3; face: Vector3 } {
    const p = pos, flat = new Vector3(p.x, 0, p.z), r = flat.length();
    if (!this.target || this.target.state !== 'fighting' || t > this.retargetAt) {
      let best: F | null = null, bd = Infinity;
      for (const o of live) {
        const d = o.ragdoll.pos().distanceTo(p) * (0.7 + rng() * 0.6);
        if (d < bd) { bd = d; best = o; }
      }
      this.target = best;
      this.retargetAt = t + 2 + rng() * 2;
    }

    const want = new Vector3();
    let face = this.face.clone();
    if (boast || !this.target) {
      const a = t * STRUT_RATE + this.strutPhase;
      want.set(Math.sin(a) * R * STRUT_R - flat.x, 0, Math.cos(a) * R * STRUT_R - flat.z);
      if (want.lengthSq() > 0.01) face = want.clone().normalize();
      if (t > this.boastAt && this.atk.phase === 'none') {
        this.boastAt = t + 3 + rng() * 2;
        this.startAttack(r > 1e-6 ? flat.clone().negate() : this.face, rng, true); // the move, toward the ring's middle
      }
    } else {
      const to = this.target.ragdoll.pos().sub(p).setY(0);
      const dist = to.length();
      if (dist > 1e-6) face = to.clone().divideScalar(dist);
      want.copy(face).multiplyScalar(dist > reach * 0.75 ? 1 : CREEP);
      // a flier is out of reach until it comes down: wait for it rather than swing under it
      if (dist < reach && this.atk.phase === 'none' && !this.target.flying) this.startAttack(face, rng, false);
    }
    if (want.lengthSq() > 1) want.normalize();
    // don't wander off the edge on purpose
    const edge = R - edgeMargin;
    if (r > edge) want.add(flat.clone().normalize().multiplyScalar(-(r - edge) * EDGE_PUSH));
    this.face.lerp(face, TURN).setY(0).normalize();
    return { want, face };
  }

  /** Begin a wind-up toward `dir` with the next weapon in turn. */
  startAttack(dir: Vector3, rng: () => number, harmless: boolean): void {
    const a = this.atk;
    a.phase = 'windup';
    a.t = 0;
    a.side = (a.side + 1) % this.weaponCount;
    a.coolMul = 0.7 + rng() * 0.6;
    a.harmless = harmless;
    a.dir.copy(dir).setY(0).normalize();
    a.hit.clear();
  }

  /** Knocked: the attack is lost, straight to cool-down. */
  interrupt(): void {
    this.atk.phase = 'cool';
    this.atk.t = 0;
  }

  /**
   * Advance the attack's clock, as the spike: `windup` while pulling back (and `burst` on the tick the strike window
   * opens: do the strike's push), `strike` on every tick of the strike window (check hits).
   */
  tick(dt: number, str: number, timing: readonly [number, number, number]): { windup: boolean; burst: boolean; strike: boolean } {
    const a = this.atk;
    const out = { windup: false, burst: false, strike: false };
    a.t += dt;
    if (a.phase === 'windup') {
      if (str < 0.3) this.interrupt();
      else {
        out.windup = true;
        if (a.t > timing[0]) { a.phase = 'strike'; a.t = 0; out.burst = true; }
      }
    } else if (a.phase === 'strike') {
      out.strike = true;
      if (a.t > timing[1]) { a.phase = 'cool'; a.t = 0; }
    } else if (a.phase === 'cool' && a.t > timing[2] * a.coolMul) a.phase = 'none';
    return out;
  }
}
