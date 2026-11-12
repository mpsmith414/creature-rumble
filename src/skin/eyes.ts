import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import type { BodyData } from '../builder/build';
import { lerp, norm, sub, type Vec3 } from '../util/vec';

/**
 * An eye's turn: local +z along `dir` (unit, creature space), local +y as near the creature's up as it can be (a frog's
 * upturned eye too: the shortest turn from +z would tip it on its side).
 */
export function gaze(dir: Vector3): Quaternion {
  const y = new Vector3(0, 1, 0).addScaledVector(dir, -dir.y);
  if (y.lengthSq() < 1e-8) return new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), dir); // straight up or down
  y.normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(new Vector3().crossVectors(y, dir), y, dir));
}

/** Where an eye bone's eyeball sits: its centre (creature space, rest pose), gaze (unit) and radius. */
export type EyePlace = { bone: number; centre: Vec3; dir: Vec3; r: number };

/** Every eye bone's eyeball: centred halfway along the bone, looking along it, radius max(r0, r1) × the recipe's eye size. */
export function eyePlaces(body: BodyData, eyeSize: number): EyePlace[] {
  return body.skeleton.bones.flatMap((d, bone) => {
    if (d.role !== 'eye') return [];
    const dir = sub(d.end, d.start);
    return [{ bone, centre: lerp(d.start, d.end, 0.5), dir: norm(dir), r: Math.max(d.r0, d.r1) * eyeSize }];
  });
}
