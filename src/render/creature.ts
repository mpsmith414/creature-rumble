import { BufferAttribute, BufferGeometry } from 'three/webgpu';
import type { BodyData, LodMesh } from '../builder/build';
import type { EyePlace } from '../skin/eyes';
import type { Vec3 } from '../util/vec';
import './skinning-patch'; // equal fighter materials share one shader (see there)

const BELLY_ROLES = new Set(['torso', 'neck', 'head', 'tail']);
/** Round each eye (in eyeball radii) the belly fades out, from none inside the first to full past the second. */
const EYE_NO_BELLY = [1.3, 1.6] as const;

/**
 * How much a vertex may show the belly colour: 1 on the belly roles' bones, fading to 0 near the eyes (a socket's ceiling
 * faces down like a belly and showed a pale crescent over the eye).
 */
function bellyFlag(ok: number, x: number, y: number, z: number, eyes: EyePlace[]): number {
  if (!ok) return 0;
  let f = 1;
  for (const e of eyes) {
    const d = Math.hypot(x - e.centre.x, y - e.centre.y, z - e.centre.z) / e.r;
    const t = Math.min(1, Math.max(0, (d - EYE_NO_BELLY[0]) / (EYE_NO_BELLY[1] - EYE_NO_BELLY[0])));
    f = Math.min(f, t * t * (3 - 2 * t));
  }
  return f;
}


/**
 * One level of detail's geometry. Pass the eyes (`eyePlaces`) to keep the belly colour out of their sockets. `cavity`:
 * bind the builder's groom (its w is the cavity the realistic skin darkens creases by); the toon fighters leave it out.
 */
export function lodGeometry(l: LodMesh, body: BodyData, eyes: EyePlace[] = [], cavity = true): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(l.positions, 3));
  g.setAttribute('normal', new BufferAttribute(l.normals, 3));
  g.setAttribute('skinIndex', new BufferAttribute(l.skinIndex, 4));
  g.setAttribute('skinWeight', new BufferAttribute(l.skinWeight, 4));
  // region, partT, partS and "may show a belly" share one attribute (WebGPU allows only 8 vertex buffers)
  const info = new Float32Array(l.region.length * 4);
  const bellyOk = body.skeleton.bones.map((b) => (BELLY_ROLES.has(b.role) ? 1 : 0));
  for (let v = 0; v < l.region.length; v++) {
    info[v * 4] = l.region[v];
    info[v * 4 + 1] = l.partT[v];
    info[v * 4 + 2] = l.partS[v];
    info[v * 4 + 3] = bellyFlag(bellyOk[l.boneOf[v]], l.positions[v * 3], l.positions[v * 3 + 1], l.positions[v * 3 + 2], eyes);
  }
  g.setAttribute('partInfo', new BufferAttribute(info, 4));
  // the rest position, and the region index squared: with the index itself (partInfo.x) the fragment shader can tell
  // which two regions a border triangle joins (see regionNodes)
  const bodyPos = new Float32Array(l.region.length * 4);
  for (let v = 0; v < l.region.length; v++) {
    bodyPos.set(l.positions.subarray(v * 3, v * 3 + 3), v * 4);
    bodyPos[v * 4 + 3] = l.region[v] * l.region[v];
  }
  g.setAttribute('bodyPos', new BufferAttribute(bodyPos, 4));
  // the cavity (the groom's w), bound as `tangent` (WebGPU allows only 8 vertex buffers); its xyz, the hair direction,
  // is unused (no fur). The rest normal is `normal`, read unskinned.
  if (cavity) g.setAttribute('tangent', new BufferAttribute(l.groom, 4));
  g.setAttribute('feature', new BufferAttribute(l.feature, 4)); // the 8th and last vertex buffer WebGPU allows
  g.setIndex(new BufferAttribute(l.indices, 1));
  g.computeBoundingSphere();
  return g;
}

/** Each bone's rest-pose start (creature space), the jaw's raised by the body's `jawLift` to shut the mouth. */
export function restStarts(body: BodyData): Vec3[] {
  const m = body.mouth, jd = body.skeleton.jaw, lift = body.jawLift;
  return body.skeleton.bones.map((d, i) => (i === jd && m
    ? { x: d.start.x + m.up.x * lift, y: d.start.y + m.up.y * lift, z: d.start.z + m.up.z * lift } : { ...d.start }));
}
