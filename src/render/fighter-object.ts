import {
  BackSide, Bone, BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshBasicNodeMaterial, Skeleton, SkinnedMesh, SphereGeometry, Vector3,
  type Material, type Matrix4,
} from 'three/webgpu';
import type { BodyData, LodMesh } from '../builder/build';
import type { RagdollLayout } from '../physics/layout';
import type { Recipe } from '../recipe/schema';
import { eyePlaces, gaze, type EyePlace } from '../skin/eyes';
import { packRegions } from '../skin/patterns';
import { lodGeometry, restStarts } from './creature';
import { GooglyEye, restBoneMatrices } from './drive';
import { createToonMaterial } from './toon';

/**
 * A fighter's body for the ring: the skinned body (its finest level of detail) in toon colours, a dark outline on the
 * same skeleton, and googly eyes. Its bones are placed straight in the world each frame by `driveBones`.
 */
export type FighterObject = {
  /** Scaled by the layout's ring scale; never turned or moved (the bones carry the fighter round the ring). */
  root: Group;
  bones: Bone[];
  mesh: SkinnedMesh;
  outline: SkinnedMesh;
  eyes: GooglyEye[];
  /** Each bone's world matrix in the rest pose (standing at the origin facing +z), the jaw raised shut. */
  restBones: Matrix4[];
  /** Bone → ragdoll segment (the layout's, plus a jaw it never saw on its head's segment). */
  boneSegment: number[];
  dispose(): void;
};

/** The outline's colour and thickness (× the ring height, pushed out along the normals). */
export const OUTLINE_COLOR = '#1a1030';
export const OUTLINE_PUSH = 0.012;
/** The pupil's radius and how far forward it sits (× the eye's radius): the spike's. */
const PUPIL_SIZE = 0.5, PUPIL_FORWARD = 0.62;
const EYE_WHITE = '#ffffff', PUPIL_BLACK = '#111111';

/**
 * The outline's geometry: the body's vertices pushed out along their normals by `push` (creature metres), sharing its
 * triangles and skin weights. Drawn back faces only, it shows as a rim round the silhouette.
 */
export function outlineGeometry(l: LodMesh, push: number): BufferGeometry {
  const p = new Float32Array(l.positions.length);
  for (let k = 0; k < p.length; k++) p[k] = l.positions[k] + l.normals[k] * push;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(p, 3));
  g.setAttribute('normal', new BufferAttribute(l.normals, 3));
  g.setAttribute('skinIndex', new BufferAttribute(l.skinIndex, 4));
  g.setAttribute('skinWeight', new BufferAttribute(l.skinWeight, 4));
  g.setIndex(new BufferAttribute(l.indices, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * How far in front of its centre (× its radius) the body may start before an eye counts as buried: a socket carved
 * inside a fat torso is a closed pocket whose front wall stands about 1.55 radii out.
 */
const BURIED = 3;

/**
 * Where a googly eye really goes. The face places each eye on its head (`eyePlaces`), but a head sunk into a fatter
 * torso (a blob's, a big fist's) leaves it inside the body, or in a sealed socket pocket in it, so nothing of it shows.
 * Such an eye is moved straight out along its gaze until its centre sits on the surface it was hidden behind, and rides
 * on the bone that surface follows most (by the mesh's skin weights). An eye already in the open is left alone.
 * The mesh is what is drawn, so it decides: a ray from the centre along the gaze is cast through its triangles, each hit
 * read as leaving the body or entering it by the side its normals face.
 */
export function seatEye(l: LodMesh, place: EyePlace): EyePlace {
  const { centre: c, dir: d, r } = place, P = l.positions, N = l.normals, I = l.indices;
  const hits: { t: number; out: boolean; v: number }[] = [];
  for (let k = 0; k < I.length; k += 3) {
    const a = I[k] * 3, b = I[k + 1] * 3, e = I[k + 2] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[e] - P[a], e2y = P[e + 1] - P[a + 1], e2z = P[e + 2] - P[a + 2];
    // Möller–Trumbore
    const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-14) continue;
    const inv = 1 / det;
    const sx = c.x - P[a], sy = c.y - P[a + 1], sz = c.z - P[a + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (d.x * qx + d.y * qy + d.z * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t <= 1e-9) continue;
    const w = 1 - u - v, corner = [[w, a], [u, b], [v, e]] as const;
    const facing = corner.reduce((s, [f, o]) => s + f * (N[o] * d.x + N[o + 1] * d.y + N[o + 2] * d.z), 0);
    hits.push({ t, out: facing > 0, v: corner.reduce((best, x) => (x[0] > best[0] ? x : best))[1] / 3 });
  }
  hits.sort((x, y) => x.t - y.t);
  const first = hits[0];
  let exit: (typeof hits)[number] | undefined;
  if (first?.out) exit = first; // the centre is inside the body
  else if (first && first.t < BURIED * r) exit = hits.find((h) => h.out && h.t > first.t); // in a sealed pocket, or the front buried
  if (!exit) return place;
  // the bone that surface follows most
  let bone = place.bone, most = -1;
  for (let j = 0; j < 4; j++) {
    const wgt = l.skinWeight[exit.v * 4 + j];
    if (wgt > most) { most = wgt; bone = l.skinIndex[exit.v * 4 + j]; }
  }
  return { ...place, bone, centre: { x: c.x + d.x * exit.t, y: c.y + d.y * exit.t, z: c.z + d.z * exit.t } };
}

/** Made once and shared by every fighter (never disposed): flat colours, untouched by tone mapping. */
let shared: { outline: Material; white: Material; black: Material; ball: SphereGeometry } | null = null;
function sharedParts() {
  if (shared) return shared;
  const flat = (hex: string, back = false) => {
    const m = new MeshBasicNodeMaterial({ color: new Color(hex) });
    if (back) m.side = BackSide;
    m.toneMapped = false;
    return m;
  };
  return (shared = { outline: flat(OUTLINE_COLOR, true), white: flat(EYE_WHITE), black: flat(PUPIL_BLACK), ball: new SphereGeometry(1, 20, 14) });
}

/**
 * Bone i's segment: the layout's, or (a bone it never saw, such as the jaw the builder appends after meshing) its
 * parent's.
 */
function segmentsFor(body: BodyData, layout: RagdollLayout): number[] {
  const defs = body.skeleton.bones;
  if (layout.boneSegment.length > defs.length) throw new Error(`the layout has ${layout.boneSegment.length} bones, the body ${defs.length}`);
  const out: number[] = [];
  defs.forEach((d, i) => out.push(layout.boneSegment[i] ?? (d.parent >= 0 ? out[d.parent] : 0)));
  return out;
}

/**
 * A fighter ready for the ring: its finest level of detail skinned in toon colours (`createToonMaterial`), scaled by
 * `layout.scale`, with a back-face outline sharing its skeleton (pushed out by OUTLINE_PUSH × the ring height, colour
 * OUTLINE_COLOR) and a googly eye with a black pupil on every eye bone (the valley's eye placement). It stands at rest
 * until `driveBones` moves it.
 */
export function createFighterObject(body: BodyData, recipe: Recipe, layout: RagdollLayout): FighterObject {
  const defs = body.skeleton.bones;
  const boneSegment = segmentsFor(body, layout);
  const root = new Group();
  root.name = 'fighter';
  root.scale.setScalar(layout.scale);
  // flat: every bone hangs straight off the root, so driveBones can place each one in the world on its own
  const bones = defs.map((d) => {
    const b = new Bone();
    b.name = d.name;
    b.position.set(d.start.x, d.start.y, d.start.z);
    root.add(b);
    return b;
  });
  root.updateMatrixWorld(true);
  const skeleton = new Skeleton(bones);

  const lod = body.lods[0];
  const places = eyePlaces(body, recipe.skin.eyes.size).map((p) => seatEye(lod, p));
  const material = createToonMaterial(packRegions(recipe, body.regions));
  const mesh = new SkinnedMesh(lodGeometry(lod, body, places, false), material);
  mesh.name = 'fighter:body';
  mesh.castShadow = true;
  const parts = sharedParts();
  const outline = new SkinnedMesh(outlineGeometry(lod, (OUTLINE_PUSH * layout.ringHeight) / layout.scale), parts.outline);
  outline.name = 'fighter:outline';
  outline.castShadow = false;
  for (const m of [mesh, outline]) {
    m.frustumCulled = false; // the bones fly round the ring, far from the bounds of the bind pose
    root.add(m);
    m.bind(skeleton);
  }

  // the rest pose: the jaw rises after binding, so the bind pose keeps the carved slit and the lift shuts it
  const starts = restStarts(body);
  bones.forEach((b, i) => {
    b.position.set(starts[i].x, starts[i].y, starts[i].z);
    b.updateMatrix();
    b.matrixAutoUpdate = false; // driveBones sets `matrix`
  });
  root.updateMatrixWorld(true);
  const restBones = restBoneMatrices(starts, layout.scale);

  const eyes = places.map(({ bone, centre, dir, r }) => {
    const d = defs[bone], at = starts[bone];
    const ball = new Mesh(parts.ball, parts.white);
    ball.name = `eye:${d.name}`;
    ball.scale.setScalar(r);
    ball.quaternion.copy(gaze(new Vector3(dir.x, dir.y, dir.z)));
    ball.position.set(centre.x - at.x, centre.y - at.y, centre.z - at.z); // relative to its bone's rest start
    const pupil = new Mesh(parts.ball, parts.black);
    pupil.name = 'pupil';
    pupil.scale.setScalar(PUPIL_SIZE);
    pupil.position.set(0, 0, PUPIL_FORWARD);
    ball.add(pupil);
    bones[bone].add(ball);
    const eye = new GooglyEye(r * layout.scale, pupil, ball);
    eye.bone = bone;
    return eye;
  });
  root.updateMatrixWorld(true);

  return {
    root, bones, mesh, outline, eyes, restBones, boneSegment,
    dispose() {
      mesh.geometry.dispose();
      outline.geometry.dispose();
      material.dispose();
      skeleton.dispose(); // its bone texture (the outline shares the skeleton)
      // sharedParts() and toonGradient() are shared by every fighter and intentionally never freed
      root.removeFromParent();
    },
  };
}
