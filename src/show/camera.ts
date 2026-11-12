import { Quaternion, Vector3, type PerspectiveCamera } from 'three/webgpu';
import { SHOW_JUMP, WALK_TO } from './timeline';

/**
 * The camera director (the spike's updateCamera, spike/main.ts): a slowly orbiting wide shot that follows half the
 * action's centre, an entrance shot on the bridge, a push-in on the champion. Every shot eases in with the same
 * frame-rate-independent smoothing. Allocates nothing per frame.
 */

/** Wide shot: orbit speed (rad/s), distance out and height (m), how much of the action's centre it follows, look lift. */
export const ORBIT_RATE = 0.06, WIDE_DIST = 11.5, WIDE_HEIGHT = 7, FOLLOW = 0.5, LOOK_UP = 0.5;
/**
 * Entrance shot (the spike's, measured from the walker's torso): this far in front of it (toward the ring), aside and
 * up (m), looking this far above the torso.
 */
export const ENTRANCE_FRONT = 5.5, ENTRANCE_ASIDE = 2.5, ENTRANCE_UP = 2.4, ENTRANCE_LOOK_UP = 0.6;
/** The show-off shot swings round to this much in front and this much aside (× the same distance): outside the bumper. */
export const SHOW_FRONT = 2.5, SHOW_ASIDE = 5.5;
/** The torso sits this far up a fighter (× its ring height). */
const TORSO_AT = 0.55;
/** Room (m) kept round the fighter's whole jump when sizing the entrance shot; lines of sight pass this far over the bumper. */
const FIT_MARGIN = 0.4, BUMPER_CLEAR = 0.2;
/** The bumper's tube (m, half its width round the ring's edge) and its middle, past the ring's radius (see arena). */
const BUMPER_HALF = 0.28, BUMPER_MID = 0.15;
/**
 * Champion shot: the champion fills this fraction of the frame's height, no nearer than this (m), seen from in front
 * of its face this far (rad) above its eye level (eyes about EYE_AT × its height up), looking at LOOK_AT × its height.
 */
export const CHAMPION_FILL = 0.4, CHAMPION_NEAR = 0.8, CHAMPION_ANGLE = (15 * Math.PI) / 180, EYE_AT = 0.8, CHAMPION_LOOK_AT = 0.6;
/**
 * Smoothing rates (1/s): every shot; the champion shot follows faster, as it is close on a strutting fighter; it swings
 * round to the champion's front slowly, so a sudden turn never whips it round.
 */
export const EASE = 2.5, CHAMPION_EASE = 6, CHAMPION_TURN = 1.5;
const SPIKE_DIST = Math.hypot(ENTRANCE_FRONT, ENTRANCE_ASIDE);

/** How far (0 … 1) the camera closes on its target in `dt` s: 1 − exp(−rate dt) (2.5 by default). */
export const smoothing = (dt: number, rate = EASE) => 1 - Math.exp(-rate * Math.max(0, dt));

/** Anything with a torso to frame (a Fighter). */
export type Tracked = { readonly ragdoll: { readonly torso: { readonly body: { translation(): { x: number; y: number; z: number } } } } };
/** Where a shot puts the camera and what it looks at. */
export type Frame = { pos: Vector3; look: Vector3 };
/** The ring the entrance shot keeps its line of sight clear of, and the camera's vertical field of view (degrees). */
export type Stage = { ringRadius: number; bumper: number; fov: number };

/** The entrance shot swings from the walk shot to the show-off shot as the walker comes from this far past the edge to WALK_TO. */
const SWING_FROM = 4.5;

/** How far (0 … 1) the entrance shot has swung aside for a walker `offset` m past the ring's edge (`entranceFrame`'s `side`). */
export function swing(offset: number): number {
  const k = Math.min(1, Math.max(0, (SWING_FROM - offset) / (SWING_FROM - WALK_TO)));
  return k * k * (3 - 2 * k);
}

const newFrame = (): Frame => ({ pos: new Vector3(), look: new Vector3() });

/**
 * The entrance shot of a fighter standing at `at` (its ground point), `height` m tall, lifted `lift` m off the ground
 * (bounce, jump, hop). It looks at the torso. It stands far enough back that the fighter's whole show-off jump
 * (SHOW_JUMP × height) fits in the frame around the torso as the eased camera follows it, however tall it is; never
 * nearer than the spike's shot.
 * `side` swings it from the spike's walk shot (0: in front, a little aside) to the show-off shot (1: mostly aside, out
 * past the bumper). It rises only as much as it must for its line of sight to the fighter's feet to pass over the
 * bumper. Pure; writes into `out`.
 */
export function entranceFrame(at: Vector3, entryDir: Vector3, height: number, lift: number, side: number, stage: Stage,
  out: Frame = newFrame()): Frame {
  const tanHalf = Math.tan((stage.fov * Math.PI) / 360);
  // half the frame's height holds the body and most of the jump, so the eased camera never loses it at the top or on landing
  const half = (0.5 + 0.75 * SHOW_JUMP) * height + FIT_MARGIN;
  const dist = Math.max(SPIKE_DIST, half / tanHalf);
  const k = dist / SPIKE_DIST;
  const front = (ENTRANCE_FRONT + (SHOW_FRONT - ENTRANCE_FRONT) * side) * k;
  const aside = (ENTRANCE_ASIDE + (SHOW_ASIDE - ENTRANCE_ASIDE) * side) * k;
  const torso = lift + TORSO_AT * height;
  out.look.set(at.x, torso + ENTRANCE_LOOK_UP * Math.min(1, height), at.z);
  const px = at.x - entryDir.x * front - entryDir.z * aside, pz = at.z - entryDir.z * front + entryDir.x * aside;
  // the camera rises with half the lift, so a jump still reads as a jump
  let y = TORSO_AT * height + lift * 0.5 + (ENTRANCE_UP - ENTRANCE_LOOK_UP) * k + ENTRANCE_LOOK_UP;
  y = Math.max(y, clearHeight(at.x, at.z, lift, px, pz, stage));
  out.pos.set(px, y, pz);
  return out;
}

/**
 * The lowest camera height at (px, pz) whose straight line to the feet at (fx, lift, fz) passes BUMPER_CLEAR over the
 * bumper wherever it crosses it (the bumper is a band BUMPER_HALF either side of ringRadius + BUMPER_MID).
 */
export function clearHeight(fx: number, fz: number, lift: number, px: number, pz: number, stage: Stage): number {
  const mid = stage.ringRadius + BUMPER_MID, top = stage.bumper + BUMPER_CLEAR;
  let need = -Infinity;
  for (let i = 1; i <= 48; i++) {
    const u = i / 48, x = fx + (px - fx) * u, z = fz + (pz - fz) * u;
    if (Math.abs(Math.hypot(x, z) - mid) > BUMPER_HALF + 0.1) continue;
    need = Math.max(need, lift + (top - lift) / u); // the line's height there is lift + u × (y − lift)
  }
  return need;
}

/**
 * The champion shot: in front of a champion `height` m tall standing at `at` (its ground point) and facing `yaw` (rad
 * round +y from +z, as `Math.atan2(x, z)` of its facing), CHAMPION_ANGLE above its eye level, near enough that it fills
 * CHAMPION_FILL of the frame's height (with room above for its crown): its face, crown and the confetti round it.
 * Pure; writes into `out`.
 */
export function championFrame(at: Vector3, height: number, yaw: number, fov: number, out: Frame = newFrame()): Frame {
  const tanHalf = Math.tan((fov * Math.PI) / 360);
  const dist = Math.max(CHAMPION_NEAR, height / (2 * CHAMPION_FILL * tanHalf));
  const flat = Math.cos(CHAMPION_ANGLE) * dist;
  out.look.set(at.x, CHAMPION_LOOK_AT * height, at.z);
  out.pos.set(at.x + Math.sin(yaw) * flat, EYE_AT * height + Math.sin(CHAMPION_ANGLE) * dist, at.z + Math.cos(yaw) * flat);
  return out;
}

/** The way a piece faces (its +z at rest), flat on the ground, as an angle round +y from +z (`Math.atan2(x, z)`). */
export function facingYaw(piece: { readonly body: { rotation(): { x: number; y: number; z: number; w: number } }; readonly restQ: Quaternion }): number {
  const r = piece.body.rotation();
  _turn.set(r.x, r.y, r.z, r.w).multiply(_restInv.copy(piece.restQ).invert());
  _fwd.set(0, 0, 1).applyQuaternion(_turn);
  return Math.hypot(_fwd.x, _fwd.z) > 1e-6 ? Math.atan2(_fwd.x, _fwd.z) : 0;
}
const _turn = new Quaternion(), _restInv = new Quaternion(), _fwd = new Vector3();

/** The shortest turn (rad, in −π … π) from `a` to `b`. */
const turnTo = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

export class CameraDirector {
  /** Radians round the ring. */
  orbit = 0.4;
  /** Where the camera is and what it looks at (eased). */
  readonly pos = new Vector3(0, 10, 16);
  readonly look = new Vector3();
  private snap = false;
  /** The champion shot's angle round the champion (eased toward its facing); NaN before the first champion shot. */
  private champYaw = NaN;
  private readonly want = newFrame();
  private readonly stage: Stage;

  /** `stage`: the ring (for the entrance shot's line of sight) and the camera's vertical field of view (degrees). */
  constructor(stage: Partial<Stage> = {}) {
    this.stage = { ringRadius: 6.5, bumper: 0.65, fov: 50, ...stage };
  }

  /** The next shot jumps straight there instead of easing (a page's first frame). */
  cut(): void { this.snap = true; }

  /** The wide shot over `fighters` (who to frame; none frames the ring's middle). Unchanged from the spike. */
  wide(dt: number, fighters: readonly Tracked[]): void {
    const look = this.want.look.set(0, 0, 0);
    for (const f of fighters) {
      const p = f.ragdoll.torso.body.translation();
      look.x += p.x;
      look.z += p.z;
    }
    if (fighters.length) look.multiplyScalar(FOLLOW / fighters.length);
    this.orbit += dt * ORBIT_RATE;
    look.y += LOOK_UP;
    this.want.pos.set(Math.sin(this.orbit) * WIDE_DIST, WIDE_HEIGHT, Math.cos(this.orbit) * WIDE_DIST).add(look);
    this.ease(dt, EASE);
  }

  /**
   * The entrance shot (`entranceFrame`) of a fighter at `at` (its ground point) `height` m tall lifted `lift` m; `side`
   * 0 while it walks, 1 once it shows off.
   */
  entrance(dt: number, at: Vector3, entryDir: Vector3, height = 1.4, lift = 0, side = 0): void {
    this.orbit += dt * ORBIT_RATE;
    entranceFrame(at, entryDir, height, lift, side, this.stage, this.want);
    this.ease(dt, EASE);
  }

  /**
   * The champion shot (`championFrame`) of a champion at `at` (its ground point), `height` m tall, facing `yaw`
   * (`facingYaw` of its torso). The camera swings round to its front at CHAMPION_TURN, never whipping round.
   */
  champion(dt: number, at: Vector3, height: number, yaw: number): void {
    if (Number.isNaN(this.champYaw) || this.snap) this.champYaw = yaw;
    else this.champYaw += turnTo(this.champYaw, yaw) * smoothing(dt, CHAMPION_TURN);
    championFrame(at, height, this.champYaw, this.stage.fov, this.want);
    this.ease(dt, CHAMPION_EASE);
  }

  apply(camera: PerspectiveCamera): void {
    camera.position.copy(this.pos);
    camera.lookAt(this.look);
  }

  private ease(dt: number, rate: number): void {
    const k = this.snap ? 1 : smoothing(dt, rate);
    this.snap = false;
    this.pos.lerp(this.want.pos, k);
    this.look.lerp(this.want.look, k);
  }
}
