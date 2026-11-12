import type { Recipe } from '../../recipe/schema';
import { add, cross, dot, lerp, norm, scale, sub, v3, type Vec3 } from '../../util/vec';
import { boneSdf, thinAxis, tipRadius } from '../sdf';
import type { BoneDef, Skeleton } from '../skeleton';
import { boneFrame, feature, shapeSize, type Feature, type Frame, type Shape } from './shapes';
import type { Detail } from '.';

/**
 * Where the mouth opens: the hinge (mouth corners' midpoint), the tip, and the slit's plane. `lips`: how far ahead of the
 * hinge (metres along forward) the slit reaches the sides of the muzzle; behind it the cheeks close the mouth's sides, and
 * the jaw stretches them as it opens (src/builder/weights.ts). `chin`: how far below the slit the jaw carries all of the
 * skin, fading out by twice that (Infinity: all the way down; an upright face's chin, which would otherwise take the
 * throat down to the chest).
 */
export type MouthFrame = { hinge: Vec3; tip: Vec3; forward: Vec3; up: Vec3; side: Vec3; halfThick: number; lips: number; chin: number; head: number /* head bone */; mouth: number /* front mouth bone or -1 */ };

/** The lips part over the front of the mouth, ahead of this fraction of the hinge-to-tip length (the cheeks close the rest). */
export const LIPS_PART = 0.75;
/**
 * Behind the lips' corner, where the cheeks close the mouth's sides, the jaw's pull (src/builder/weights.ts) ramps in over
 * this many slit widths instead of one: the rest lift squeezes that skin to a third rather than a twentieth (slivers turned
 * over), and opening the mouth stretches it a little less. It narrows to the slit over the 0.25 L before the corner (over
 * 0.1 L the rest lift varied along the cheek enough to turn a sliver over).
 */
export const CHEEK_SPAN = 1.5;

const R = (b: BoneDef) => Math.max(b.r0, b.r1);
const length = (b: BoneDef) => Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y, b.end.z - b.start.z);

/**
 * A head within this angle of vertical (cos 35°) is upright, a kid's standing creature's: its face looks along the
 * body's +z, not along the bone (whose end is the crown), and its mouth is a level slit across the front.
 */
export const UPRIGHT = Math.cos((35 * Math.PI) / 180);
/** An upright head's face frame: forward the body's +z (level), up world up. */
const LEVEL: Frame = { a: v3(0, 0, 1), up: v3(0, 1, 0), side: v3(1, 0, 0) };

/**
 * A frame along `a` with `up` made perpendicular to it (side = up × a). When `a` is parallel to `up`, up falls back to
 * backward (−z), then to +x, made perpendicular (as boneFrame does for an exactly vertical bone).
 */
export function frameAlong(a: Vec3, up: Vec3): Frame {
  let t = v3();
  for (const r of [up, v3(0, 0, -1), v3(1, 0, 0)]) {
    t = sub(r, scale(a, dot(r, a)));
    if (Math.hypot(t.x, t.y, t.z) > 1e-6) break;
  }
  const u = norm(t);
  return { a, up: u, side: norm(cross(u, a)) };
}

const descends = (sk: Skeleton, i: number, from: number) => { for (let p = sk.bones[i].parent; p >= 0; p = sk.bones[p].parent) if (p === from) return true; return false; };

/** The radius at the front of the muzzle (the mouth bone's tip, else a third of the head's). */
export const noseRadius = (H: BoneDef, M: BoneDef | null) => (M ? Math.max(M.r1, 0.35 * M.r0) : 0.35 * R(H));

/** The point `s` metres along a bone from its start (clamped to the bone), and its radius there. */
function alongBone(B: BoneDef, s: number): { p: Vec3; r: number } {
  const t = Math.min(Math.max(s / length(B), 0), 1);
  return { p: lerp(B.start, B.end, t), r: B.r0 + (B.r1 - B.r0) * t };
}

/** The head bone's surface straight ahead (+z) of the point `s` metres up its axis; null if not within 3 radii. */
function ahead(H: BoneDef, s: number): Vec3 | null {
  const c = alongBone(H, s).p, thin = thinAxis(H), d = (t: number) => boneSdf(v3(c.x, c.y, c.z + t), H, thin);
  let lo = 0, hi = 3 * R(H);
  if (d(lo) >= 0 || d(hi) <= 0) return null;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (d(mid) < 0) lo = mid; else hi = mid; }
  return v3(c.x, c.y, c.z + hi);
}

/**
 * An upright head's face levels, metres up its axis from its start: the eyes (their centres' mean; without eyes, 65% of
 * the way to the crown), the mouth and the nose halfway between. The mouth sits below the eyes by 0.6 head radii or 1.5
 * eye radii, whichever is more, but no lower than where the face clears the head's parent by 0.45 head radii (a head set
 * on a torso is half buried in it; nearer, the torso takes enough of the lips' skin that the jaw cannot shut them) nor
 * below 15% of the bone. `fits`: the mouth stays clear of the eyes (an eye radius, or 0.3 head radii, below them); else
 * the face has no room for one.
 */
function faceLevels(sk: Skeleton, h: number, H: BoneDef, axis: Vec3) {
  let sum = 0, n = 0, re = 0;
  sk.bones.forEach((E, i) => {
    if (E.role !== 'eye' || !descends(sk, i, h)) return;
    sum += dot(sub(lerp(E.start, E.end, 0.5), H.start), axis);
    n++;
    re = Math.max(re, R(E));
  });
  const lH = length(H), rH = R(H), eye = n ? sum / n : 0.65 * (lH + tipRadius(H));
  const P = H.parent >= 0 ? sk.bones[H.parent] : null, thin = P ? thinAxis(P) : null;
  let clear = 0;
  for (; P && thin && clear < lH; clear += lH / 16) {
    const p = ahead(H, clear);
    if (p && boneSdf(p, P, thin) >= 0.45 * rH) break;
  }
  const mouth = Math.max(eye - Math.max(0.6 * rH, 1.5 * re), clear, 0.15 * lH);
  return { eye, mouth, nose: (eye + mouth) / 2, fits: mouth <= eye - Math.max(re, 0.3 * rH) };
}

/**
 * The head bone H, its bone frame `hf` (the cranium follows it), the face frame `f` (the bone frame; an upright head's
 * is LEVEL), the front mouth bone M (−1), the muzzle frame (along M), the tip T and its radius rn. T is the front of the
 * tip's surface: the bone's end is its round cap's centre, where nose shapes would sit inside the head (and carves there
 * would leave sealed pockets). An upright head without a muzzle has its tip on its face, at the nose's level.
 */
function head(sk: Skeleton) {
  const h = sk.bones.findIndex((b) => b.role === 'head');
  if (h < 0) return null;
  const H = sk.bones[h], hf = boneFrame(H), rH = R(H), upright = hf.a.y >= UPRIGHT, f = upright ? LEVEL : hf;
  let m = -1;
  sk.bones.forEach((b, i) => { if (b.role === 'mouth' && !b.jaw && descends(sk, i, h) && (m < 0 || b.end.z > sk.bones[m].end.z)) m = i; });
  const M = m >= 0 ? sk.bones[m] : null;
  const muzzle = M ? frameAlong(norm(sub(M.end, M.start)), f.up) : f;
  const levels = upright ? faceLevels(sk, h, H, hf.a) : null;
  const T = M ? add(M.end, scale(muzzle.a, tipRadius(M))) : (levels && ahead(H, levels.nose)) || add(H.end, scale(f.a, tipRadius(H)));
  return { h, H, hf, f, upright, levels, rH, m, M, muzzle, T, rn: noseRadius(H, M) };
}

/**
 * How far along the head's line (the head bone, then the front mouth bone) the mouth's corner sits, in metres from the
 * head's start. The diet rule is binary (`prey`: recipe.mind.preyMax > 0). A hunter keeps a long gape, its corner below
 * the front of the eye (without eyes, 55% along the head bone); a plant-eater's mouth is short, its corner a fifth of the
 * way along the muzzle (without a muzzle bone, 60% of the way from the head's start to its tip). A hunter's corner is never
 * ahead of a plant-eater's. A bird's (`bird`: a beak or bill), whatever it eats, is never behind its beak's base (at the
 * head's surface): its mouth is its beak.
 */
function corner(sk: Skeleton, hd: NonNullable<ReturnType<typeof head>>, prey: boolean, bird: boolean): number {
  const { h, H, M, f } = hd, lH = length(H);
  const plant = M ? lH + 0.2 * length(M) : 0.6 * (lH + tipRadius(H));
  let c = plant;
  if (prey) {
    let eye = -1;
    sk.bones.forEach((E, i) => {
      if (E.role !== 'eye' || !descends(sk, i, h)) return;
      // the eyeball's front, as far along the head as it reaches
      eye = Math.max(eye, dot(sub(lerp(E.start, E.end, 0.5), H.start), f.a) + R(E));
    });
    c = Math.min(eye >= 0 ? eye : 0.55 * lH, plant);
  }
  return bird && M ? Math.max(c, lH + R(M)) : c;
}

/** The point `s` metres along the head's line (the head bone, then the front mouth bone), and the radius there. */
function alongHead(hd: NonNullable<ReturnType<typeof head>>, s: number): { p: Vec3; r: number } {
  const { H, M } = hd, lH = length(H);
  if (s <= lH || !M) { const t = Math.min(Math.max(s / lH, 0), 1); return { p: lerp(H.start, H.end, t), r: H.r0 + (H.r1 - H.r0) * t }; }
  const t = Math.min((s - lH) / length(M), 1);
  return { p: lerp(M.start, M.end, t), r: M.r0 + (M.r1 - M.r0) * t };
}

/**
 * The mouth's frame (Task 10 hangs the jaw on it); null without a head bone, and null where no sound frame is found (no
 * mouth beats a wrong one): a head hanging within 35° of straight down, an upright head whose muzzle points up or down
 * (more than 60° off level), an upright face with no room for a mouth below its eyes (see faceLevels), or a slit that
 * would not run within 30° of level across an upright face.
 *
 * The hinge is the mouth's corner (see `corner`: long for hunters, short for plant-eaters), on the head's centre plane,
 * below the head's line by 0.3 of its radius there. Forward runs from the hinge to the tip, so the slit's plane holds both
 * (along the mouth bone instead, a down-turned muzzle's slit cuts under the eye and shaves the chin to a blade); up is the
 * face's, made perpendicular. An upright head's face looks along +z with world up (its bone's frame would turn the slit
 * into a vertical cut up the face): with a muzzle the mouth runs along the muzzle alone (its corner by diet as before,
 * from the muzzle's root); without one the slit runs level across the face at the mouth's level (below the eyes), the tip
 * on the face's surface and the hinge 0.15 of the head's radius there ahead of its axis (the front half of the head), and
 * the jaw carries the face down to a chin half that radius below the slit.
 */
export function mouthFrame(sk: Skeleton, recipe: Pick<Recipe, 'face' | 'mind'>, detail: Detail): MouthFrame | null {
  const hd = head(sk);
  if (!hd || hd.hf.a.y <= -UPRIGHT) return null;
  const { h, H, M, m, f, muzzle, T, rn, rH, levels } = hd, nose = recipe.face.nose, bird = nose === 'beak' || nose === 'bill';
  let tip = bird ? T : sub(T, scale(muzzle.up, 0.35 * rn)); // mandibles meet on the axis
  let hinge: Vec3, chin = Infinity;
  if (levels && !M) {
    const at = alongBone(H, levels.mouth), front = ahead(H, levels.mouth);
    if (!front || !levels.fits) return null;
    tip = front;
    hinge = v3(at.p.x, at.p.y, at.p.z + 0.15 * at.r);
    chin = 0.5 * at.r;
  } else {
    if (levels && dot(muzzle.a, f.a) < 0.5) return null;
    const c = M && recipe.mind.preyMax <= 0 ? 0.2 * length(M) : 0; // along an upright head's muzzle
    const at = levels && M ? alongBone(M, bird ? Math.max(c, R(M)) : c) : alongHead(hd, corner(sk, hd, recipe.mind.preyMax > 0, bird));
    hinge = sub(at.p, scale(f.up, 0.3 * at.r));
    hinge.x = at.p.x;
  }
  const { a: forward, up, side } = frameAlong(norm(sub(tip, hinge), f.a), f.up);
  if (levels && Math.abs(forward.y) > 0.5) return null;
  const halfThick = Math.max(0.035 * (M ? R(M) : rH), 1.1 * detail.cell);
  const L = Math.hypot(tip.x - hinge.x, tip.y - hinge.y, tip.z - hinge.z);
  return { hinge, tip, forward, up, side, halfThick, lips: LIPS_PART * L, chin, head: h, mouth: m };
}

/**
 * The lips' mark fades out over LIP_BAND slit half-widths from the slit. The skin takes the lip colour only over the mark's
 * upper half (src/skin/material.ts), so the dark line is about half the band each side: at 3 with the colour from the
 * mark's lower half, a closed mouth read as a thick dark band; at 1.2 the colour flipped within one edge (ragged lips).
 */
const LIP_BAND = 2.5;
/** A pad nose is at most this many head radii across its tip (its half-width is 0.8 of that). */
export const PAD = 0.3;
/** Where a thin ear's inner-ear mark starts, in base radii up the ear from its (buried) start. */
const EAR_CUT = 0.5;
const ellipsoid = (c: Vec3, ax: [Vec3, Vec3, Vec3], r: Vec3): Shape => ({ type: 'ellipsoid', c, ax, r });
const sphere = (c: Vec3, r: number): Shape => ({ type: 'ellipsoid', c, ax: [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)], r: v3(r, r, r) });
const cone = (a: Vec3, b: Vec3, r0: number, r1: number): Shape => ({ type: 'cone', a, b, r0, r1 });
/** p + Σ dᵢ·sᵢ */
const at = (p: Vec3, ...terms: [Vec3, number][]) => terms.reduce((q, [d, s]) => add(q, scale(d, s)), p);

/**
 * The shapes that sculpt a face: skull, sockets, brows, cheeks, muzzle creases, nose, mouth slit and ear cups. `mf` is the
 * mouth's frame (`mouthFrame`, worked out here when not passed); without one there is no slit, chin or lip line.
 */
export function faceFeatures(sk: Skeleton, recipe: Pick<Recipe, 'build' | 'face' | 'skin' | 'mind'>, detail: Detail, mf = mouthFrame(sk, recipe, detail)): Feature[] {
  const hd = head(sk);
  if (!hd) return [];
  const out: Feature[] = [];
  const push = (f: Feature) => { if (shapeSize(f.shape) >= 2 * detail.cell) out.push(f); };
  const { h, H, hf, f, rH, M, m, muzzle, T, rn } = hd, { a, up, side } = f, cell = detail.cell;
  const nose = recipe.face.nose, brow = recipe.face.brow, muscle = recipe.build.muscle;

  // 1. cranium: the braincase, over the back of the head (as thin as the head across its squashed axis: a trout's, a
  // frog's), along the head bone (an upright head's runs up to the crown, over the back of the skull)
  const thin = thinAxis(H), sideThin = Math.abs(dot(thin, hf.side)) >= Math.abs(dot(thin, hf.up));
  const [sq, uq] = H.squash < 0.999 ? (sideThin ? [H.squash, 1] : [1, H.squash]) : [1, 1];
  push(feature('add', ellipsoid(at(lerp(H.start, H.end, 0.3), [hf.up, 0.25 * rH * uq]), [hf.a, hf.side, hf.up], v3(0.45 * length(H), 0.85 * rH * sq, 0.75 * rH * uq)), 0.5 * rH, { name: 'cranium', bone: h }));

  // per eye: socket, brow, cheek (eyeballs placed as src/skin/eyes.ts places them)
  sk.bones.forEach((E, i) => {
    if (E.role !== 'eye' || !descends(sk, i, h)) return;
    const d = sub(E.end, E.start), le = Math.hypot(d.x, d.y, d.z), o = norm(d);
    const c = add(E.start, scale(o, le / 2)), re = R(E) * recipe.skin.eyes.size;
    // 2. socket: the eyeball fills it, the lids (Task 11) sit in it
    push(feature('carve', sphere(at(c, [o, 0.35 * re]), 1.2 * re), 0.4 * re, { name: 'socket', bone: i }));
    // 3. brow: a ridge along the socket's upper rim (lower, the socket carves it to a loose shelf); none over an eye
    // that looks up (a frog's: it would stand as a knob behind it)
    if (brow >= 0.05 && dot(o, up) < 0.5) {
      const bf = frameAlong(o, up), across = norm(cross(bf.up, o));
      push(feature('add', ellipsoid(at(c, [bf.up, 1.2 * re], [o, -0.3 * re]), [across, bf.up, o], v3(1.2 * re, 0.35 * re * (0.5 + brow), 0.45 * re * (0.5 + brow))), 0.3 * re, { name: 'brow', bone: i }));
    }
    // 4. cheek: under and behind the eye (not on beaks and bills)
    if (nose === 'pad' || nose === 'slits' || nose === 'none') {
      const s = 0.6 + 0.4 * muscle;
      push(feature('add', ellipsoid(at(c, [up, -1.2 * re], [a, -0.5 * re], [o, -0.3 * re]), [a, side, up], v3(1.3 * re * s, 0.9 * re * s, 0.8 * re * s)), 0.6 * re, { name: 'cheek', bone: i }));
    }
    // 5. muzzle crease: from under the eye to the side of the nose
    if (nose === 'pad' && M && 0.05 * M.r0 >= cell) {
      const sgn = dot(sub(c, H.start), muzzle.side) >= 0 ? 1 : -1;
      const to = at(T, [muzzle.a, -0.5 * rn], [muzzle.up, 0.4 * rn], [muzzle.side, sgn * 0.5 * rn]);
      const r = Math.max(0.05 * M.r0, cell);
      out.push(feature('carve', cone(at(c, [up, -0.6 * re], [a, 0.6 * re]), to, r, r), 0.04 * M.r0, { name: 'crease', bone: i }));
    }
  });

  // 6. nose
  const { a: na, up: nu, side: ns } = muzzle;
  if (nose === 'pad') {
    // a pad in proportion to the head (the tip's radius alone gave a rabbit a big round ball), sunk into the tip so it
    // sits flush and soft rather than standing out
    const rp = Math.min(rn, PAD * rH), bone = m >= 0 ? m : h;
    push(feature('add', ellipsoid(at(T, [na, -0.15 * rp], [nu, 0.2 * rp]), [na, ns, nu], v3(0.5 * rp, 0.8 * rp, 0.55 * rp)), 0.3 * rp, { mark: 'nose', markBand: 0.25 * rp, name: 'nose', bone }));
    for (const s of [-1, 1]) {
      // nostrils: small dimples in the pad's front (where wider than a cell), dark inside (the mouth's dark colour)
      const c = at(T, [na, 0.3 * rp], [ns, s * 0.35 * rp], [nu, 0.1 * rp]);
      if (0.13 * rp >= 1.2 * cell) out.push(feature('carve', sphere(c, 0.13 * rp), 0.04 * rp, { mark: 'nose', markBand: 0.1 * rp, name: 'nostril', bone }));
      if (0.12 * rp >= 0.5 * cell) out.push(feature('mark', sphere(c, 0.1 * rp), 0, { mark: 'mouth', markBand: 0.1 * rp, name: 'nostrilDark', bone }));
    }
    if (0.07 * rp >= 0.7 * cell) {
      const r = Math.max(0.07 * rp, cell);
      out.push(feature('carve', cone(at(T, [nu, -0.15 * rp], [na, 0.2 * rp]), at(T, [nu, -0.8 * rp], [na, 0.1 * rp]), r, r), 0.5 * r, { name: 'philtrum', bone }));
    }
  } else if ((nose === 'beak' || nose === 'bill') && M) {
    const rM = R(M), lM = length(M);
    if (nose === 'beak') {
      // at least a cell thick at its root and 0.75 of a cell at its tip (as a talon's): thinner, the mesh drops it or
      // breaks it into shards
      const r0 = Math.max(0.45 * rn, cell), r1 = Math.max(0.06 * rn, 0.75 * cell);
      out.push(feature('add', cone(at(T, [na, -0.2 * rn]), at(T, [na, 0.6 * rn], [nu, -0.9 * rn]), r0, r1), 0.2 * rn, { name: 'hook', bone: m }));
    } else push(feature('add', ellipsoid(lerp(M.start, M.end, 0.6), [na, ns, nu], v3(0.55 * lM, 1.25 * rM, 0.35 * rM)), 0.3 * M.r0, { name: 'bill', bone: m }));
    if (0.12 * M.r0 >= 1.5 * cell)
      for (const s of [-1, 1]) out.push(feature('carve', sphere(at(M.start, [na, 0.3 * lM], [nu, 0.6 * M.r0], [ns, s * 0.4 * M.r0]), 0.12 * M.r0), 0.05 * M.r0, { mark: 'nose', markBand: 0.06 * M.r0, name: 'nostril', bone: m }));
  } else if (nose === 'slits' && 0.08 * rn >= 0.7 * cell) {
    const r = Math.max(0.08 * rn, cell);
    for (const s of [-1, 1]) {
      // from inside the head out through the skin (the tip's surface curves back from T, so p sits just outside it)
      const p = at(T, [nu, 0.4 * rn], [ns, s * 0.3 * rn]);
      out.push(feature('carve', cone(at(p, [na, -0.25 * rn]), p, r, r), 0.5 * r, { mark: 'nose', markBand: r, name: 'slit', bone: m >= 0 ? m : h }));
    }
  }

  // 7. mouth slit: a thin slab from where the lips part to past the tip (Task 10's jaw opens along it). Behind it the
  // cheeks close the mouth's sides (an open mouth shows no daylight through the head), so the lower jaw stays joined to
  // the head there; a lip line is painted on them back to the corner
  if (mf) {
    const L = Math.hypot(mf.tip.x - mf.hinge.x, mf.tip.y - mf.hinge.y, mf.tip.z - mf.hinge.z), rM = M ? R(M) : rH;
    // the lower jaw under a muzzle: a round cone up to the slit's plane, so a thin muzzle's chin is not shaved to a blade
    // whose tip crumbles off, and behind the parted lips it joins the muzzle above solidly (a thin beak's met it only at a
    // pinch: daylight through the closed cheeks); the slit, carved after it, still opens the lips (a head without a muzzle
    // bone has its own bulk under the slit)
    if (M) {
      const cf = Math.max(0.3 * rn, 1.2 * cell), cb = Math.max(0.35 * rH, cf), below = (r: number) => -r;
      out.push(feature('add', cone(at(mf.hinge, [mf.up, below(cb)]), at(mf.tip, [mf.up, below(cf)], [mf.forward, -cf]), cb, cf), 0.5 * cf, { name: 'chin', bone: m }));
    }
    // (a slab of even thickness: an ellipsoid thins to nothing towards its rim, and a slit thinner than a cell breaks into
    // sealed pockets and loose shards)
    const front = 1.27 * L, wide = 1.4 * Math.max(rM, 0.8 * rH), ax: [Vec3, Vec3, Vec3] = [mf.forward, mf.side, mf.up];
    out.push(feature('carve', { type: 'slab', c: at(mf.hinge, [mf.forward, (mf.lips + front) / 2]), ax, r: v3((front - mf.lips) / 2, wide, mf.halfThick) },
      0.5 * mf.halfThick, { mark: 'mouth', markBand: LIP_BAND * mf.halfThick, name: 'mouth', bone: m >= 0 ? m : h }));
    // the lip line on the cheeks, from the corner (the ellipse's round back end tapers it there) into the parted lips: it
    // covers the skin the jaw stretches there (from the slit's upper face down CHEEK_SPAN slit widths), so at rest it is a
    // dark line (the rest lift squeezes it) and open, the cheeks' stretched skin is the mouth's dark inside
    const back = mf.lips + 0.05 * L, ramp = 2 * CHEEK_SPAN * mf.halfThick;
    out.push(feature('mark', { type: 'slab', c: at(mf.hinge, [mf.forward, back / 2], [mf.up, mf.halfThick - ramp / 2]), ax, r: v3(back / 2, 1.5 * wide, ramp / 2 - 0.5 * mf.halfThick) },
      0, { mark: 'mouth', markBand: LIP_BAND * mf.halfThick, name: 'lipLine', bone: m >= 0 ? m : h }));
  }

  // 8. ear cups: a hollow in each flat ear's front, or only a front mark where the ear is too thin to hollow
  sk.bones.forEach((E, i) => {
    if (E.role !== 'ear' || E.squash >= 0.8) return;
    const t = thinAxis(E), ea = norm(sub(E.end, E.start)), rmid = (E.r0 + E.r1) / 2, hth = rmid * E.squash;
    if (hth < 1.5 * cell) {
      // the ear's round cone (as wide as the ear all along it) trimmed to the squashed ear's thickness (a round cone alone
      // reaches r0 into the head all round the base: the forehead took the mark) and cut half a base radius up from the
      // buried start (below it the cone runs on through the head, and beside the root lies head skin; the crotch between
      // two close ears too). Inside, it holds the whole ear, so the front face is marked (facing keeps the colour off the
      // back); the band only softens the edges. (A slab's ellipse bulges past a tapering ear and runs on below the base.)
      const th = E.r0 * E.squash, cut = (p: Vec3, n: Vec3) => ({ p, n });
      out.push(feature('mark', cone(E.start, E.end, E.r0, E.r1), 0, {
        mark: 'earInner', markBand: hth, facing: t, name: 'earCup', bone: i,
        cuts: [cut(at(E.start, [t, th]), scale(t, -1)), cut(at(E.start, [t, -th]), t), cut(at(E.start, [ea, EAR_CUT * E.r0]), ea)],
      }));
      return;
    }
    out.push(feature('carve', ellipsoid(at(lerp(E.start, E.end, 0.5), [t, 1.6 * hth]), [ea, norm(cross(t, ea)), t], v3(0.38 * length(E), 0.55 * rmid, 1.4 * hth)),
      0.3 * hth, { mark: 'earInner', markBand: 0.6 * hth, facing: t, name: 'earCup', bone: i }));
  });
  return out;
}
