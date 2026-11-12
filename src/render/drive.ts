import { Matrix4, Quaternion, Vector2, Vector3, type Object3D } from 'three/webgpu';
import type { RagdollLayout } from '../physics/layout';
import { restPlacement, type Ragdoll } from '../physics/ragdoll';
import type { Vec3 } from '../util/vec';
import type { FighterObject } from './fighter-object';

const ONE = new Vector3(1, 1, 1);

/**
 * Each bone's world matrix in the rest pose (bones carry no turn at rest): at its start × `scale` (the ring scale),
 * scaled by it. `starts` are creature space, the jaw already raised shut.
 */
export function restBoneMatrices(starts: Vec3[], scale: number): Matrix4[] {
  const s = new Vector3(scale, scale, scale), q = new Quaternion();
  return starts.map((p) => new Matrix4().compose(new Vector3(p.x, p.y, p.z).multiplyScalar(scale), q, s));
}

/** Each segment's piece at rest (the ragdoll's `restP`/`restQ`), as a matrix. */
export function pieceRestMatrices(layout: Pick<RagdollLayout, 'segments'>): Matrix4[] {
  return layout.segments.map((seg) => {
    const { p, q } = restPlacement(seg);
    return new Matrix4().compose(p, q, ONE);
  });
}

/**
 * Where each bone is now: bone i rides rigidly on its segment's piece s = `boneSegment[i]`, so its world matrix is
 * pieceNow[s] × pieceRest[s]⁻¹ × restBones[i]. Pure; writes into `out` when given (no new matrices each frame).
 */
export function boneWorld(layout: Pick<RagdollLayout, 'boneSegment'>, restBones: Matrix4[], pieceRest: Matrix4[], pieceNow: Matrix4[],
  out: Matrix4[] = restBones.map(() => new Matrix4())): Matrix4[] {
  while (moved.length < pieceNow.length) moved.push(new Matrix4());
  pieceNow.forEach((now, s) => moved[s].multiplyMatrices(now, _move.copy(pieceRest[s]).invert()));
  restBones.forEach((rest, i) => out[i].multiplyMatrices(moved[layout.boneSegment[i]], rest));
  return out;
}
/** boneWorld's scratch: each piece's move from rest. */
const moved: Matrix4[] = [];
const _move = new Matrix4();

/** The pupil's spring (the spike's): stiffness (1/s²), damping (1/s), and how far it may slide (× the eye's radius). */
export const PUPIL_STIFFNESS = 90, PUPIL_DAMPING = 6, PUPIL_MAX = 0.42;
/** How far the pupil leans per m/s of the head's motion, per rad/s of its turn and of its nod (m). */
const LEAN_MOVE = 0.02, LEAN_TURN = 0.01, LEAN_NOD = 0.005;
/** The spring takes steps no longer than this (s): a slow frame does not kick it. */
const PUPIL_STEP = 1 / 60;
/** A pupil hitting the eye's edge bounces back with this much of its speed. */
const PUPIL_BOUNCE = 0.6;

/**
 * A googly eye's pupil: a damped spring that lags behind the head's motion and settles when it stops (the spike's).
 * Its `offset` (m, in the eye's own frame: x across, y up) never goes past PUPIL_MAX × `radius`; the pupil object, a
 * child of the eyeball (whose geometry has radius 1 and which is scaled by the eye's radius), slides by offset / radius.
 */
export class GooglyEye {
  readonly offset = new Vector2();
  readonly vel = new Vector2();
  /** The eye bone it sits on (−1 when not on a fighter). */
  bone = -1;
  private readonly max: number;
  private readonly target = new Vector2();

  /** `radius`: the eyeball's radius (m, in the ring). */
  constructor(readonly radius: number, readonly pupil: { position: Vector3 } | null = null, readonly ball: Object3D | null = null) {
    this.max = PUPIL_MAX * radius;
  }

  /** `headVel` (m/s) and `headAngVel` (rad/s) are the head's motion in the eye's own frame (x across, y up, z out). */
  update(dt: number, headVel: Vector3, headAngVel: Vector3): void {
    const t = this.target.set(-headVel.x * LEAN_MOVE + headAngVel.y * LEAN_TURN, -headVel.y * LEAN_MOVE - Math.abs(headAngVel.x) * LEAN_NOD);
    t.clampLength(0, this.max * 3);
    for (let left = dt; left > 1e-9; left -= PUPIL_STEP) this.step(Math.min(left, PUPIL_STEP));
    if (this.pupil) {
      this.pupil.position.x = this.offset.x / this.radius;
      this.pupil.position.y = this.offset.y / this.radius;
    }
  }

  private step(h: number): void {
    const { offset: o, vel: v, target: t } = this;
    v.x += (t.x - o.x) * PUPIL_STIFFNESS * h;
    v.y += (t.y - o.y) * PUPIL_STIFFNESS * h;
    v.multiplyScalar(1 - PUPIL_DAMPING * h);
    o.addScaledVector(v, h);
    if (o.length() > this.max) {
      o.setLength(this.max);
      v.multiplyScalar(-PUPIL_BOUNCE);
    }
  }
}

/** Per fighter: the pieces' rest matrices (for the ragdoll they were read from) and scratch for every frame. */
type Scratch = { ragdoll: Ragdoll; rest: Matrix4[]; now: Matrix4[]; q: Quaternion[]; out: Matrix4[] };
const scratches = new WeakMap<FighterObject, Scratch>();
const _p = new Vector3(), _inv = new Matrix4(), _q = new Quaternion(), _qi = new Quaternion(), _lv = new Vector3(), _av = new Vector3();

function scratchFor(obj: FighterObject, ragdoll: Ragdoll): Scratch {
  let s = scratches.get(obj);
  if (!s || s.ragdoll !== ragdoll) {
    s = {
      ragdoll,
      rest: ragdoll.pieces.map((p) => new Matrix4().compose(p.restP, p.restQ, ONE)),
      now: ragdoll.pieces.map(() => new Matrix4()),
      q: ragdoll.pieces.map(() => new Quaternion()),
      out: obj.bones.map(() => new Matrix4()),
    };
    scratches.set(obj, s);
  }
  return s;
}

/**
 * Puts the fighter's bones where its ragdoll's pieces are (`boneWorld`), and, given the frame's `dt` (s), wobbles its
 * googly eyes with the motion of the piece each one sits on. Call once a frame after the physics step. The fighter's
 * root may be scaled but not turned or moved (its bones are placed in the world).
 */
export function driveBones(obj: FighterObject, ragdoll: Ragdoll, dt = 0): void {
  const s = scratchFor(obj, ragdoll);
  ragdoll.pieces.forEach((p, k) => {
    const t = p.body.translation(), r = p.body.rotation();
    s.q[k].set(r.x, r.y, r.z, r.w);
    s.now[k].compose(_p.set(t.x, t.y, t.z), s.q[k], ONE);
  });
  boneWorld(obj, obj.restBones, s.rest, s.now, s.out);
  obj.root.updateWorldMatrix(true, false);
  _inv.copy(obj.root.matrixWorld).invert();
  obj.bones.forEach((b, i) => {
    b.matrix.multiplyMatrices(_inv, s.out[i]); // the scene's next update gives it back: root × matrix
    b.matrixWorld.copy(s.out[i]);
    b.matrixWorldNeedsUpdate = true;
  });
  if (!(dt > 0)) return;
  for (const e of obj.eyes) {
    const k = obj.boneSegment[e.bone], piece = ragdoll.pieces[k];
    if (!piece) continue;
    // the eye's frame now: its gaze on the bone, turned as the piece has turned from rest; motion is read in it
    _q.copy(s.q[k]).multiply(_qi.copy(piece.restQ).invert());
    if (e.ball) _q.multiply(e.ball.quaternion);
    _q.invert();
    const lv = piece.body.linvel(), av = piece.body.angvel();
    e.update(dt, _lv.set(lv.x, lv.y, lv.z).applyQuaternion(_q), _av.set(av.x, av.y, av.z).applyQuaternion(_q));
  }
}
