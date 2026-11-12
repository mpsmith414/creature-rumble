import { Quaternion, Vector3 } from 'three/webgpu';
import type { RagdollLayout } from '../physics/layout';
import type { Piece, Ragdoll } from '../physics/ragdoll';
import { speedFor } from './tune';
import type { Move } from './types';

/**
 * A fighter's muscles: the forces that hold its ragdoll up and move it (the spike's Creature.think/upright/strike,
 * spike/creature.ts). "Gang-Beasts style": the torso hovers at its stand height on a spring and is kept upright and
 * turned by PD torques; arms and legs only dangle and swing. `str` (0–1) scales everything: 0 is a full ragdoll.
 */

const UP = new Vector3(0, 1, 0);
const FORWARD = new Vector3(0, 0, 1);
const v = (p: { x: number; y: number; z: number }) => new Vector3(p.x, p.y, p.z);
/** The spike's fighters were about this tall (m): its sizes and reaches are scaled by ringHeight / this. */
const SPIKE_HEIGHT = 1.4;

/** Hover spring (per s²) and damping (per s) holding the torso at its stand height; it carries 0.9 × the weight. */
const HOVER_K = 60, HOVER_D = 9, HOVER_CARRY = 0.9;
/** How hard it pushes toward where it wants to go (per s). */
const DRIVE = 6;
/** Upright PD gains: torso (also turns to face). */
const TORSO_KP = 45, TORSO_KD = 7, YAW_KP = 18, YAW_KD = 4;
/**
 * The neck's PD gains (per s² and per s, on the head's inertia about its joint), on top of carrying the head's weight.
 * The spike's 25 / 4 left every head hanging upside down within half a second; these let a head bob on a punch or a
 * lunge and come back up within about a fifth of a second (balanced with npm run balance: 150 let heads hang, 200
 * favoured the tail).
 */
const HEAD_KP = 300, HEAD_KD = 20;

export const pieceLength = (p: Piece) => v(p.seg.a).distanceTo(v(p.seg.b));
/** A point given in a piece's own frame, in the world. */
export function worldPoint(p: Piece, local: Vector3): Vector3 {
  const r = p.body.rotation();
  return local.clone().applyQuaternion(new Quaternion(r.x, r.y, r.z, r.w)).add(v(p.body.translation()));
}
/** The far end (`b`) of a piece's capsule, in the world. */
export const tipOf = (p: Piece) => worldPoint(p, new Vector3(0, pieceLength(p) / 2, 0));
/** Both ends of a piece's capsule, in the world. */
export const endsOf = (p: Piece): [Vector3, Vector3] => {
  const h = pieceLength(p) / 2;
  return [worldPoint(p, new Vector3(0, -h, 0)), worldPoint(p, new Vector3(0, h, 0))];
};

/** An impulse of `dir` × `k` at the piece's centre. */
export function push(p: Piece, dir: Vector3, k: number): void {
  p.body.applyImpulse({ x: dir.x * k, y: dir.y * k, z: dir.z * k }, true);
}

export class Muscles {
  /** ringHeight / 1.4: the spike's creature scale, for its sizes, reaches and spin. */
  readonly k: number;
  readonly speed: number;
  readonly standHeight: number;
  /** One chain of pieces per leg (thigh to foot), for the waddle. */
  readonly legs: Piece[][];
  readonly wings: Piece[];
  /** The pieces the signature move hits with (the plan's weapon parts); the torso if none. */
  readonly weapons: Piece[];
  walkPhase = 0;
  flapCd = 0;
  /** Where the head hangs from its parent (the neck joint), in the head piece's own frame. */
  private readonly neck = new Vector3();
  /** The head and every piece hanging off it: the weight the neck holds up. */
  private readonly headLoad: Piece[];

  constructor(readonly body: Ragdoll, layout: RagdollLayout) {
    this.k = layout.ringHeight / SPIKE_HEIGHT;
    this.speed = speedFor(layout.ringHeight);
    this.standHeight = layout.standHeight;
    const ps = body.pieces;
    const legLike = (p: Piece) => p.seg.kind === 'leg' || p.seg.kind === 'foot';
    this.legs = ps.filter((p) => legLike(p) && !(p.seg.parent >= 0 && legLike(ps[p.seg.parent]))).map((top) => {
      const chain = [top];
      for (let at = top; ;) {
        const next = ps.find((c) => c.seg.parent === at.seg.id && legLike(c));
        if (!next) break;
        chain.push((at = next));
      }
      return chain;
    });
    this.wings = ps.filter((p) => p.seg.kind === 'wing');
    const weapons = ps.filter((p) => p.seg.weapon);
    this.weapons = weapons.length ? weapons : [body.torso];
    const h = body.head;
    if (h) this.neck.copy(v(h.seg.anchor)).sub(h.restP).applyQuaternion(h.restQ.clone().invert());
    this.headLoad = h ? ps.filter((p) => this.hangsOff(p, h)) : [];
  }

  /** Whether `p` is `from` or hangs off it (through its parents). */
  private hangsOff(p: Piece, from: Piece): boolean {
    for (let at: Piece = p; ; at = this.body.pieces[at.seg.parent]) {
      if (at === from) return true;
      if (at.seg.parent < 0) return false;
    }
  }

  /** The weapon piece and its parents up to (not including) the torso: the limb a kick swings. */
  limb(w: Piece): Piece[] {
    const out: Piece[] = [];
    for (let p: Piece = w; p.seg.parent >= 0; p = this.body.pieces[p.seg.parent]) out.push(p);
    return out.length ? out : [w];
  }

  /** How long (m) a weapon's limb is, torso to tip. */
  limbLength(w: Piece): number {
    return w === this.body.torso ? 0 : this.limb(w).reduce((t, p) => t + pieceLength(p), 0);
  }

  /** The way the torso faces now (horizontal unit vector). */
  facing(): Vector3 {
    const r = this.body.torso.body.rotation();
    const q = new Quaternion(r.x, r.y, r.z, r.w).multiply(this.body.torso.restQ.clone().invert());
    const f = FORWARD.clone().applyQuaternion(q).setY(0);
    return f.lengthSq() > 1e-6 ? f.normalize() : FORWARD.clone();
  }

  /** Close enough to the floor to push off it (the spike's `grounded`). */
  grounded(R: number): boolean {
    const p = this.body.pos();
    return Math.hypot(p.x, p.z) < R + 0.15 && p.y > -0.4 && p.y < this.standHeight * 1.7 + 0.4;
  }

  /** Hover the torso at stand height and push toward `want` (a horizontal vector up to length 1). */
  hover(dt: number, str: number, want: Vector3, gravity: number): void {
    const M = this.body.mass, p = this.body.pos(), vel = this.body.vel();
    const fy = Math.max(0, M * gravity * HOVER_CARRY + M * (HOVER_K * (this.standHeight - p.y) - HOVER_D * vel.y)) * str;
    this.body.torso.body.applyImpulse({ x: 0, y: fy * dt, z: 0 }, true);
    const dv = want.clone().multiplyScalar(this.speed).sub(new Vector3(vel.x, 0, vel.z));
    push(this.body.torso, dv, M * DRIVE * dt * str);
  }

  /** Keep the torso upright and turned toward `face`, and the head up on its neck. */
  stand(dt: number, str: number, face: Vector3, gravity: number): void {
    const t = this.body.torso;
    upright(t, dt, str, face, this.body.mass, t.seg.radius + 0.35 * this.k, TORSO_KP, TORSO_KD);
    this.holdHead(dt, str, gravity);
  }

  /**
   * The neck: the head is balanced on its joint like an upside-down pendulum, and gravity's pull about that joint
   * (weight × lever) is several times what the spike's head PD could give, so the head flipped and hung into the torso.
   * The neck carries the head's weight (and anything hanging off it) about the joint, then a PD on the tilt angle (not
   * its sine, so a head left upside down by a stun is pulled up hardest) holds it up, sized to the head's inertia about
   * the joint. Everything scales with `str`: a stunned head (str 0) flops freely.
   */
  private holdHead(dt: number, str: number, gravity: number): void {
    const h = this.body.head;
    if (!h || str <= 0) return;
    let m = 0;
    const com = new Vector3();
    for (const p of this.headLoad) {
      com.addScaledVector(v(p.body.translation()), p.mass);
      m += p.mass;
    }
    const lever = com.divideScalar(m).sub(worldPoint(h, this.neck));
    // lever × (m g up): cancels gravity's turn about the neck
    const tq = new Vector3(-lever.z, 0, lever.x).multiplyScalar(m * gravity);
    const r = h.body.rotation();
    const u = UP.clone().applyQuaternion(new Quaternion(r.x, r.y, r.z, r.w).multiply(h.restQ.clone().invert()));
    const axis = u.clone().cross(UP);
    const sin = axis.length(), angle = Math.atan2(sin, u.dot(UP));
    if (sin > 1e-6) axis.multiplyScalar(angle / sin);
    else if (u.y < 0) axis.set(Math.PI, 0, 0); // straight upside down: any level axis will do
    // damp the head's swing against the body's (not the world), and stiffen by the body's spin²: a twirling body
    // (the tail's spin) flings its head outward with a pull that grows as spin² (its centrifugal force); capped at
    // 50 rad/s (over any strike: the tail's reach ~37) so a wild tumble can't make the neck stiff enough to kick
    const wt = v(this.body.torso.body.angvel());
    const pd = axis.multiplyScalar(HEAD_KP + Math.min(wt.lengthSq(), 2500)).sub(v(h.body.angvel()).sub(wt).multiplyScalar(HEAD_KD));
    pd.y = 0;
    const inertia = 0.4 * h.mass * h.seg.radius * h.seg.radius + m * lever.lengthSq();
    tq.addScaledVector(pd, inertia).multiplyScalar(str * dt);
    // the torque goes on the head alone, with no equal and opposite twist on the torso: the torso's own upright PD
    // soaks up the reaction through the joint (a muscle, as the spike's upright torques are)
    h.body.applyTorqueImpulse({ x: tq.x, y: tq.y, z: tq.z }, true);
  }

  /** Swing the legs in turn while walking (and flutter wings). */
  waddle(dt: number, str: number, face: Vector3, grounded: boolean): void {
    const vel = this.body.vel();
    const sp = Math.hypot(vel.x, vel.z);
    this.walkPhase += dt * (3 + sp * 2.5);
    if (grounded && str > 0.5 && sp > 0.4) {
      this.legs.forEach((chain, i) => {
        const s = Math.sin(this.walkPhase + i * Math.PI);
        const dir = face.clone().multiplyScalar(s).add(UP.clone().multiplyScalar(Math.max(0, s) * 0.6));
        for (const p of chain) push(p, dir, p.mass * 9 * dt);
      });
    }
    if (this.wings.length && sp > 0.3) for (const w of this.wings) push(w, UP, w.mass * Math.sin(this.walkPhase * 3) * 14 * dt);
  }

  /** Wings: a lucky flap back in off the edge (60% chance each time it is possible, then 1.1 s to recharge). */
  flapSave(dt: number, R: number, rng: () => number): void {
    this.flapCd -= dt;
    if (!this.wings.length || this.flapCd > 0) return;
    const p = this.body.pos(), flat = new Vector3(p.x, 0, p.z);
    if (flat.length() > R - 0.2 && p.y > -2.2 && rng() < 0.6) {
      this.flapCd = 1.1;
      push(this.body.torso, flat.normalize().multiplyScalar(-6).add(new Vector3(0, 9, 0)), this.body.mass);
      for (const w of this.wings) push(w, UP, w.mass * 8);
    }
  }

  /** Wind-up: pull the weapon (or the body) back from `dir`, once per tick. */
  windup(dt: number, move: Move, dir: Vector3, w: Piece): void {
    const back = dir.clone().negate();
    if (move === 'punch' || move === 'jab') push(w, back.add(UP.clone().multiplyScalar(0.7)), w.mass * 10 * dt);
    if (move === 'kick' || move === 'bump') push(this.body.torso, back, this.body.mass * 3 * dt);
    if (move === 'headbutt') push(w, back.add(UP.clone().multiplyScalar(-0.5)), w.mass * 12 * dt);
  }

  /** The strike's burst, once, as the strike window opens. */
  strike(move: Move, dir: Vector3, w: Piece): void {
    const M = this.body.mass, torso = this.body.torso, up = (y: number) => UP.clone().multiplyScalar(y);
    switch (move) {
      case 'punch': case 'jab':
        push(w, dir.clone().add(up(0.25)), w.mass * (move === 'punch' ? 26 : 16));
        push(torso, dir, M * 2.5);
        break;
      case 'kick':
        for (const p of new Set(this.weapons.flatMap((x) => this.limb(x)))) push(p, dir.clone().add(up(0.9)), p.mass * 22);
        break;
      case 'bump': push(torso, dir.clone().add(up(0.25)), M * 7); break;
      case 'headbutt': push(torso, dir.clone().add(up(0.15)), M * 10); push(w, dir, w.mass * 12); break;
      case 'divebomb': push(torso, dir.clone().multiplyScalar(5).add(up(9)), M); break;
      case 'spin': break;
    }
  }

  /** Spin: keeps twisting the body round through the strike window. */
  spin(dt: number): void {
    this.body.torso.body.applyTorqueImpulse({ x: 0, y: this.body.mass * 2.2 * this.k * this.k * dt * 10, z: 0 }, true);
  }
}

/**
 * PD torque keeping a piece the way up it was built (and turning it toward `face`), scaled by strength. Orientation is
 * measured against the piece's rest pose, so a slightly tilted torso capsule is not forced straight.
 */
function upright(part: Piece, dt: number, str: number, face: Vector3 | null, m: number, rad: number, kp: number, kd: number): void {
  if (str <= 0) return;
  const r = part.body.rotation();
  const q = new Quaternion(r.x, r.y, r.z, r.w).multiply(part.restQ.clone().invert()); // creature-frame turn
  const u = UP.clone().applyQuaternion(q);
  const w = v(part.body.angvel());
  const tq = u.clone().cross(UP).multiplyScalar(kp).sub(w.clone().multiplyScalar(kd));
  if (face) {
    const f = FORWARD.clone().applyQuaternion(q);
    let err = Math.atan2(face.x, face.z) - Math.atan2(f.x, f.z);
    err = Math.atan2(Math.sin(err), Math.cos(err));
    tq.y = YAW_KP * err - YAW_KD * w.y;
  } else tq.y = 0;
  const k = 0.4 * m * rad * rad * str * dt;
  part.body.applyTorqueImpulse({ x: tq.x * k, y: tq.y * k, z: tq.z * k }, true);
}
