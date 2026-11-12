import { PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';
import { describe, expect, test } from 'vitest';
import {
  CameraDirector, CHAMPION_ANGLE, CHAMPION_FILL, championFrame, EYE_AT, facingYaw, clearHeight, ENTRANCE_ASIDE, ENTRANCE_FRONT, ENTRANCE_LOOK_UP, ENTRANCE_UP, entranceFrame,
  ORBIT_RATE, smoothing, swing, WIDE_DIST, WIDE_HEIGHT, type Stage,
} from '../../src/show/camera';
import { entranceAt, SHOW_JUMP, WALK_FROM, WALK_TO } from '../../src/show/timeline';

const STAGE: Stage = { ringRadius: 6.5, bumper: 0.65, fov: 50 };
const DIR = new Vector3(Math.cos(-0.55), 0, Math.sin(-0.55));
/** A camera at `pos` looking at `look` with the stage's field of view and a TV's (or the dev pane's) shape. */
function cam(pos: Vector3, look: Vector3, aspect: number): PerspectiveCamera {
  const c = new PerspectiveCamera(STAGE.fov, aspect, 0.1, 300);
  c.position.copy(pos);
  c.lookAt(look);
  c.updateMatrixWorld();
  return c;
}
/** Inside the frame (normalised device coordinates), with a little margin. */
const inFrame = (p: Vector3, c: PerspectiveCamera) => {
  const q = p.clone().project(c);
  return Math.abs(q.x) < 0.97 && Math.abs(q.y) < 0.97 && q.z < 1;
};
/** The lowest height over the bumper band of the straight line from `a` to `b`. */
function overBumper(a: Vector3, b: Vector3): number {
  let low = Infinity;
  for (let i = 0; i <= 400; i++) {
    const p = a.clone().lerp(b, i / 400);
    if (Math.abs(Math.hypot(p.x, p.z) - (STAGE.ringRadius + 0.15)) <= 0.28) low = Math.min(low, p.y);
  }
  return low;
}

const at = (x: number, y: number, z: number) => ({ ragdoll: { torso: { body: { translation: () => ({ x, y, z }) } } } });
/** Runs `step` for `secs` at 60 fps. */
const run = (secs: number, step: (dt: number) => void) => { for (let t = 0; t < secs; t += 1 / 60) step(1 / 60); };

describe('smoothing', () => {
  test('is the spike’s 1 − exp(−2.5 dt)', () => {
    expect(smoothing(0)).toBe(0);
    expect(smoothing(1 / 60)).toBeCloseTo(1 - Math.exp(-2.5 / 60));
    expect(smoothing(100)).toBeCloseTo(1);
  });
  test('two half steps move as far as one whole step (the same at any frame rate)', () => {
    const half = smoothing(0.05);
    expect(1 - (1 - half) * (1 - half)).toBeCloseTo(smoothing(0.1));
  });
});

describe('CameraDirector', () => {
  test('the wide shot orbits at 11.5 m out, 7 m up, looking at half the action’s centre', () => {
    const c = new CameraDirector();
    c.cut();
    const fs = [at(4, 1, 0), at(2, 1, 2)];
    c.wide(1 / 60, fs);
    expect(c.look.x).toBeCloseTo(1.5);
    expect(c.look.y).toBeCloseTo(0.5);
    expect(c.look.z).toBeCloseTo(0.5);
    const off = c.pos.clone().sub(c.look);
    expect(Math.hypot(off.x, off.z)).toBeCloseTo(WIDE_DIST);
    expect(off.y).toBeCloseTo(WIDE_HEIGHT);
  });

  test('the orbit turns at 0.06 rad/s', () => {
    const c = new CameraDirector();
    const o = c.orbit;
    run(10, (dt) => c.wide(dt, []));
    expect(c.orbit - o).toBeCloseTo(10 * ORBIT_RATE, 2);
  });

  test('eases toward a new shot instead of cutting', () => {
    const c = new CameraDirector();
    c.cut();
    c.wide(1 / 60, []);
    const before = c.look.clone();
    c.wide(1 / 60, [at(8, 0, 0), at(8, 0, 0)]); // the action jumps to x = 8: the target look is x = 4
    expect(c.look.x).toBeGreaterThan(before.x);
    expect(c.look.x).toBeCloseTo(4 * smoothing(1 / 60));
    run(5, (dt) => c.wide(dt, [at(8, 0, 0)]));
    expect(c.look.x).toBeCloseTo(4, 3);
  });

  test('the entrance shot of a walker far out on the bridge is the spike’s: 5.5 m in front, 2.5 m aside, 2.4 m over its torso', () => {
    const c = new CameraDirector();
    c.cut();
    const dir = new Vector3(1, 0, 0), walker = new Vector3(20, 0, 0), H = 1, torso = 0.55 * H;
    c.entrance(1 / 60, walker, dir, H, 0, 0);
    expect(c.pos.x).toBeCloseTo(20 - ENTRANCE_FRONT);
    expect(Math.abs(c.pos.z)).toBeCloseTo(ENTRANCE_ASIDE);
    expect(c.pos.y).toBeCloseTo(torso + ENTRANCE_UP);
    expect(c.look.x).toBeCloseTo(20);
    expect(c.look.z).toBeCloseTo(0);
    expect(c.look.y).toBeCloseTo(torso + ENTRANCE_LOOK_UP);
    expect([ENTRANCE_FRONT, ENTRANCE_ASIDE, ENTRANCE_UP]).toEqual([5.5, 2.5, 2.4]);
  });

  test('the entrance shot looks at the torso, lifted with the fighter', () => {
    const c = new CameraDirector();
    c.cut();
    c.entrance(1 / 60, new Vector3(20, 0, 0), new Vector3(1, 0, 0), 1, 1.5, 0);
    expect(c.look.y).toBeCloseTo(1.5 + 0.55 + ENTRANCE_LOOK_UP);
  });

  test('the champion shot eases in on the champion', () => {
    const c = new CameraDirector();
    c.cut();
    c.champion(1 / 60, new Vector3(2, 0, -1), 1, 0);
    expect(c.look.x).toBeCloseTo(2);
    expect(c.look.z).toBeCloseTo(-1);
  });

  test('apply puts a camera there, looking at the target', () => {
    const c = new CameraDirector();
    c.cut();
    c.champion(1 / 60, new Vector3(), 1.4, 0);
    const cam = new PerspectiveCamera();
    c.apply(cam);
    expect(cam.position.distanceTo(c.pos)).toBeLessThan(1e-9);
    const fwd = new Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    expect(fwd.angleTo(c.look.clone().sub(c.pos))).toBeLessThan(1e-3);
  });
});

describe('entranceFrame', () => {
  test('the whole show-off jump stays in frame (eased as the director eases it), whatever the fighter’s size', () => {
    for (const H of [0.5, 1.4, 2.2]) for (const aspect of [2, 16 / 9]) {
      const c = new CameraDirector(STAGE);
      c.cut();
      let apex = 0;
      for (let t = 0; t < 6; t += 1 / 60) {
        const a = entranceAt(t, false);
        const offset = WALK_FROM + (WALK_TO - WALK_FROM) * a.walk;
        const ground = DIR.clone().multiplyScalar(STAGE.ringRadius + offset);
        const lift = a.bob + a.jump * SHOW_JUMP * H;
        c.entrance(1 / 60, ground, DIR, H, lift, a.phase === 'walk' ? swing(offset) : 1);
        if (a.phase !== 'showOff') continue;
        const view = cam(c.pos, c.look, aspect);
        for (const y of [lift, lift + H]) {
          expect(inFrame(ground.clone().setY(y), view), `H ${H}, aspect ${aspect}, t ${t.toFixed(2)}, y ${y.toFixed(2)}`).toBe(true);
        }
        apex = Math.max(apex, a.jump);
      }
      expect(apex).toBeGreaterThan(0.99); // the top of the jump was checked
    }
  });

  test('its line of sight to the fighter passes over the bumper, all the way down the bridge and through the show-off', () => {
    for (const H of [0.5, 1.4, 2.2]) {
      for (let offset = WALK_FROM; offset >= WALK_TO - 1e-9; offset -= 0.1) {
        for (const lift of [0, SHOW_JUMP * H]) {
          const at = DIR.clone().multiplyScalar(STAGE.ringRadius + offset);
          const f = entranceFrame(at, DIR, H, lift, swing(offset), STAGE);
          for (const y of [lift, lift + H]) expect(overBumper(f.pos, at.clone().setY(y))).toBeGreaterThan(STAGE.bumper + 0.15);
          expect(f.pos.y).toBeGreaterThan(STAGE.bumper + 0.5);
        }
      }
    }
  });

  test('it stands back far enough for a tall fighter’s jump', () => {
    const at = DIR.clone().multiplyScalar(20);
    const small = entranceFrame(at, DIR, 1, 0, 1, STAGE), big = entranceFrame(at, DIR, 3, 0, 1, STAGE);
    expect(big.pos.distanceTo(big.look)).toBeGreaterThan(small.pos.distanceTo(small.look) * 1.5);
  });

  test('clearHeight: nothing to clear for a line that never crosses the bumper', () => {
    expect(clearHeight(20, 0, 0, 25, 0, STAGE)).toBe(-Infinity);
    expect(clearHeight(8, 0, 0, 3, 0, STAGE)).toBeGreaterThan(STAGE.bumper);
  });

  test('a camera the walk shot would put behind the bumper is lifted over it', () => {
    const at = DIR.clone().multiplyScalar(STAGE.ringRadius + WALK_TO);
    const f = entranceFrame(at, DIR, 1.4, 0, 0, STAGE); // no swing: the spike's shot from inside the ring
    expect(overBumper(f.pos, at)).toBeGreaterThan(STAGE.bumper + 0.15);
  });

  test('swing goes 0 → 1 as the walker nears the ring', () => {
    expect(swing(WALK_FROM)).toBe(0);
    expect(swing(WALK_TO)).toBe(1);
    expect(swing(3)).toBeGreaterThan(0);
    expect(swing(3)).toBeLessThan(1);
  });
});

describe('championFrame', () => {
  /** The flat angle (rad) between the way the champion faces (`yaw`) and the way from it out to the camera. */
  const offFront = (pos: Vector3, at: Vector3, yaw: number) => {
    const a = Math.atan2(pos.x - at.x, pos.z - at.z);
    return Math.abs(Math.atan2(Math.sin(a - yaw), Math.cos(a - yaw)));
  };

  test('the champion fills about 35–45% of the frame’s height, however big, whichever way it faces', () => {
    for (const H of [0.45, 0.8, 1.4, 2.5, 3.5]) for (const yaw of [0, 1.3, 4]) {
      const at = new Vector3(1.5, 0, -2);
      const f = championFrame(at, H, yaw, STAGE.fov);
      const c = cam(f.pos, f.look, 16 / 9);
      const feet = at.clone().project(c), top = at.clone().setY(H).project(c);
      const fill = (top.y - feet.y) / 2;
      expect(fill, `H ${H}, yaw ${yaw}`).toBeGreaterThan(0.35);
      expect(fill, `H ${H}, yaw ${yaw}`).toBeLessThan(0.45);
      expect(inFrame(at.clone().setY(H * 1.25), c)).toBe(true); // room for the crown
    }
    expect(CHAMPION_FILL).toBe(0.4);
  });

  test('it looks at the champion’s face: from in front of it, 10–20° above its eye level', () => {
    for (const H of [0.45, 1.4, 3]) for (const yaw of [0, 2, -2.5]) {
      const at = new Vector3(-1, 0, 2);
      const f = championFrame(at, H, yaw, STAGE.fov);
      expect(offFront(f.pos, at, yaw)).toBeLessThan(1e-6);
      const eyes = at.clone().setY(EYE_AT * H);
      const down = Math.atan2(f.pos.y - eyes.y, Math.hypot(f.pos.x - eyes.x, f.pos.z - eyes.z));
      expect(down).toBeGreaterThan((10 * Math.PI) / 180);
      expect(down).toBeLessThan((20 * Math.PI) / 180);
    }
    expect(CHAMPION_ANGLE).toBeCloseTo((15 * Math.PI) / 180);
  });

  test('the director keeps in front of the champion (within 45°) as it struts round, and in frame', () => {
    const c = new CameraDirector(STAGE);
    c.cut();
    const H = 0.5, at = new Vector3();
    for (let t = 0; t < 8; t += 1 / 60) {
      const a = t * 0.6;
      at.set(Math.sin(a) * 2.73, 0, Math.cos(a) * 2.73); // the strut circle, facing the way it walks
      const yaw = a + Math.PI / 2;
      c.champion(1 / 60, at, H, yaw);
      if (t < 1) continue;
      expect(offFront(c.pos, at, yaw)).toBeLessThan(Math.PI / 4);
      const view = cam(c.pos, c.look, 16 / 9);
      expect(inFrame(at, view) && inFrame(at.clone().setY(H), view)).toBe(true);
    }
  });

  test('a sudden about-turn swings the camera round smoothly, not in one jump, and it ends up in front again', () => {
    const c = new CameraDirector(STAGE);
    c.cut();
    const at = new Vector3(), H = 1;
    c.champion(1 / 60, at, H, 0);
    let last = Math.atan2(c.pos.x, c.pos.z), most = 0;
    for (let t = 0; t < 4; t += 1 / 60) {
      c.champion(1 / 60, at, H, Math.PI * 0.95); // turned round
      const now = Math.atan2(c.pos.x, c.pos.z);
      most = Math.max(most, Math.abs(Math.atan2(Math.sin(now - last), Math.cos(now - last))));
      last = now;
    }
    expect(most).toBeLessThan(0.06); // rad per frame: under 3.5 rad/s at its fastest
    expect(offFront(c.pos, at, Math.PI * 0.95)).toBeLessThan(Math.PI / 4);
  });

  test('facingYaw reads the way a piece faces from its turn since rest', () => {
    const restQ = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.3);
    const piece = (yaw: number) => {
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw).multiply(restQ);
      return { body: { rotation: () => ({ x: q.x, y: q.y, z: q.z, w: q.w }) }, restQ };
    };
    expect(facingYaw(piece(0))).toBeCloseTo(0);
    expect(facingYaw(piece(1.2))).toBeCloseTo(1.2);
    expect(facingYaw(piece(-2.9))).toBeCloseTo(-2.9);
  });
});
