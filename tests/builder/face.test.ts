import { describe, expect, it } from 'vitest';
import { anatomy, type Anatomy } from '../../src/builder/anatomy';
import { faceFeatures, frameAlong, LIPS_PART, mouthFrame, noseRadius, PAD } from '../../src/builder/anatomy/face';
import { buildBody } from '../../src/builder/build';
import { boneFrame, feature, marksAt, shapeSdf, smax, type Shape } from '../../src/builder/anatomy/shapes';
import { bodySdf, smin, thinAxis } from '../../src/builder/sdf';
import { buildSkeleton, type Skeleton } from '../../src/builder/skeleton';
import { CAST } from '../fixtures/cast';
import type { Recipe } from '../../src/recipe/schema';
import { add, cross, dist, dot, lerp, norm, scale, sub, v3, type Vec3 } from '../../src/util/vec';
import { jawPose, jawWeight } from '../fixtures/jaw';
import { badEdges, productionMesh } from '../fixtures/mesh';
import { biped, bird, blob, hexapod, P, quadruped, snake, upright } from '../fixtures/recipes';

const cast = (id: string) => CAST.find((c) => c.recipe.id === id)!.recipe;
const fox = cast('fox');
const FINE = { cell: 0.0005 }; // fine enough that nothing is skipped
const detail = (sk: Skeleton) => ({ cell: Math.max(sk.max.x - sk.min.x, sk.max.y - sk.min.y, sk.max.z - sk.min.z) / 330 });
const faceOf = (r: Recipe, d = FINE) => { const sk = buildSkeleton(r); return { sk, f: faceFeatures(sk, r, d) }; };
const xyz = (p: Vec3) => [p.x, p.y, p.z] as const;
const at = (p: Vec3, d: Vec3, s: number) => add(p, scale(d, s));
const count = (fs: { name?: string }[], name: string) => fs.filter((f) => f.name === name).length;
/** The anatomy without its face features (the body and feet only). */
const noFace = (a: Anatomy, faceCount: number): Anatomy => ({ ...a, features: a.features.slice(0, a.features.length - faceCount) });

describe('the slab shape', () => {
  const slab: Shape = { type: 'slab', c: v3(10, 0, 0), ax: [v3(1, 0, 0), v3(0, 0, 1), v3(0, 1, 0)], r: v3(0.4, 0.1, 0.01) };

  it('is an ellipse extruded evenly: the same thickness near its rim as at its centre', () => {
    expect(shapeSdf(v3(10, 0, 0), slab)).toBeCloseTo(-0.01, 9);
    expect(shapeSdf(v3(10.39, 0, 0), slab)).toBeCloseTo(-0.01, 9); // an ellipsoid would be 0.0022 thick here
    expect(shapeSdf(v3(10, 0.02, 0), slab)).toBeCloseTo(0.01, 9);
    expect(Math.abs(shapeSdf(v3(10.4, 0, 0), slab))).toBeLessThan(1e-9);
    expect(shapeSdf(v3(10.5, 0, 0), slab)).toBeGreaterThan(0.09);
  });

  it('bodySdf evaluates it (and its exact skip) as shapeSdf does, add and carve, plain and shallow', () => {
    const sk = buildSkeleton(blob), slim = new Float32Array(sk.bones.length).fill(1);
    for (const op of ['add', 'carve'] as const) {
      // a carve needs a body to cut: a big add sphere around the slab
      const ball = feature('add', { type: 'ellipsoid', c: v3(10, 0, 0), ax: [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)], r: v3(0.3, 0.3, 0.3) }, 0.01);
      const f = feature(op, slab, 0.005), feats = op === 'add' ? [f] : [ball, f];
      // margin 1e3: no box culls (exact only near the surface), so only the exact bounding-sphere skip is left
      const sdf = bodySdf(sk, { features: feats, slim, mouth: null }, 1e3), shallow = bodySdf(sk, { features: feats, slim, mouth: null }, 1e3, true);
      const far = bodySdf(sk, { features: [], slim, mouth: null }, 1e3);
      for (let i = 0; i < 3000; i++) {
        const g = (j: number) => (((i * 7919 + j * 104729) % 1000) / 1000) * 2 - 1;
        const p = v3(10 + 0.6 * g(1), 0.05 * g(2), 0.2 * g(3));
        let d = far(p.x, p.y, p.z);
        for (const h of feats) d = h.op === 'add' ? smin(d, shapeSdf(p, h.shape), h.k) : smax(d, -shapeSdf(p, h.shape), h.k);
        expect(sdf(p.x, p.y, p.z)).toBeCloseTo(d, 9);
        if (op === 'carve' && d > 0) expect(shallow(p.x, p.y, p.z)).toBeLessThanOrEqual(d + 1e-9); // never overstates the gap
      }
    }
  });
});

describe('face features', () => {
  it('the fox gets a cranium, sockets, brows, cheeks, a pad nose with nostrils, a mouth and ear cups', () => {
    const { f } = faceOf(fox);
    expect(count(f, 'cranium')).toBe(1);
    expect(count(f, 'socket')).toBe(2);
    expect(count(f, 'brow')).toBe(2);
    expect(count(f, 'cheek')).toBe(2);
    expect(count(f, 'nose')).toBe(1);
    expect(count(f, 'nostril')).toBe(2);
    expect(count(f, 'mouth')).toBe(1);
    expect(count(f, 'lipLine')).toBe(1);
    expect(count(f, 'earCup')).toBe(2);
    expect(count(f, 'chin')).toBe(1); // the lower jaw under the slit
    const nose = f.find((g) => g.name === 'nose')!, mouth = f.find((g) => g.name === 'mouth')!;
    expect(nose).toMatchObject({ op: 'add', mark: 'nose' });
    expect(mouth).toMatchObject({ op: 'carve', mark: 'mouth' });
    for (const g of f.filter((h) => h.name === 'nostril' || h.name === 'socket')) expect(g.op).toBe('carve');
    for (const g of f.filter((h) => h.name === 'earCup')) expect(g.mark).toBe('earInner');
  });

  it('the mouth frame: tip in front of the hinge, hinge below both eyes, a slit at least 1.1 cells thick', () => {
    const sk = buildSkeleton(fox), d = detail(sk), m = mouthFrame(sk, fox, d)!;
    expect(m).not.toBeNull();
    expect(m.tip.z).toBeGreaterThan(m.hinge.z);
    for (const e of sk.bones.filter((b) => b.role === 'eye')) expect(m.hinge.y).toBeLessThan(lerp(e.start, e.end, 0.5).y); // the eyeball centre
    expect(m.halfThick).toBeGreaterThanOrEqual(1.1 * d.cell);
    expect(sk.bones[m.head].role).toBe('head');
    expect(sk.bones[m.mouth].role).toBe('mouth');
    // an orthonormal frame
    for (const [u, w] of [[m.forward, m.up], [m.forward, m.side], [m.up, m.side]]) expect(Math.abs(dot(u, w))).toBeLessThan(1e-9);
    for (const u of [m.forward, m.up, m.side]) expect(dot(u, u)).toBeCloseTo(1, 9);
    expect(m.up.y).toBeGreaterThan(0);
  });

  it('the slit plane holds the hinge and the tip (forward runs between them); the slit opens where the lips part', () => {
    for (const id of ['fox', 'deer', 'wolf', 'duck', 'frog']) {
      const r = cast(id), sk = buildSkeleton(r), d = detail(sk), m = mouthFrame(sk, r, d)!;
      const f = norm(sub(m.tip, m.hinge));
      expect(dot(f, m.forward), id).toBeCloseTo(1, 9);
      const L = dist(m.tip, m.hinge);
      expect(m.lips / L, id).toBeCloseTo(LIPS_PART, 9);
      const face = faceFeatures(sk, r, d), slit = face.find((g) => g.name === 'mouth')!.shape;
      if (slit.type !== 'slab') throw new Error('slab');
      // its back end is where the lips part (behind it the cheeks close the mouth's sides: no daylight through an open mouth)
      expect(dot(sub(slit.c, m.hinge), m.forward) - slit.r.x, id).toBeCloseTo(m.lips, 9);
      // and a lip line is painted on the cheeks from the corner into the parted lips
      const line = face.find((g) => g.name === 'lipLine')!;
      expect(line).toMatchObject({ op: 'mark', mark: 'mouth' });
      if (line.shape.type !== 'slab') throw new Error('slab');
      expect(dot(sub(line.shape.c, m.hinge), m.forward) - line.shape.r.x, id).toBeCloseTo(0, 9);
      expect(dot(sub(line.shape.c, m.hinge), m.forward) + line.shape.r.x, id).toBeGreaterThan(m.lips);
    }
  });

  it('nose shapes sit at the front of the tip, not inside the head (T is the tip surface): a pad sunk a little, to sit flush', () => {
    const { sk, f } = faceOf(fox), M = sk.bones.find((b) => b.role === 'mouth')!, H = sk.bones.find((b) => b.role === 'head')!;
    const nose = f.find((g) => g.name === 'nose')!.shape;
    if (nose.type !== 'ellipsoid') throw new Error('ellipsoid');
    const a = norm(sub(M.end, M.start)), rp = Math.min(noseRadius(H, M), PAD * Math.max(H.r0, H.r1));
    expect(dot(sub(nose.c, M.end), a)).toBeCloseTo(M.r1 - 0.15 * rp, 9);
    expect(dot(sub(nose.c, M.end), a) + nose.r.x).toBeGreaterThan(M.r1); // it stands a little proud of the tip
  });

  it('pad noses are in proportion to the head: a rabbit gets a small flush nose, not a ball; fox, wolf and deer keep a dark pad', () => {
    for (const id of ['fox', 'wolf', 'deer', 'rabbit']) {
      const { sk, f } = faceOf(cast(id)), H = sk.bones.find((b) => b.role === 'head')!, rH = Math.max(H.r0, H.r1);
      const nose = f.find((g) => g.name === 'nose')!;
      expect(nose, id).toMatchObject({ op: 'add', mark: 'nose' });
      if (nose.shape.type !== 'ellipsoid') throw new Error('ellipsoid');
      const r = nose.shape.r;
      // at most a quarter of the head's radius wide either side, and at least a tenth
      expect(Math.max(r.x, r.y, r.z) / rH, id).toBeLessThanOrEqual(0.25);
      expect(Math.max(r.x, r.y, r.z) / rH, id).toBeGreaterThan(0.1);
    }
    // the rabbit's nostrils are dark (the mouth's colour) openings in it, not bumps
    const rabbit = faceOf(cast('rabbit')).f;
    expect(count(rabbit, 'nostril')).toBe(2);
    for (const g of rabbit.filter((h) => h.name === 'nostril')) expect(g.op).toBe('carve');
    expect(rabbit.filter((h) => h.name === 'nostrilDark').map((h) => [h.op, h.mark])).toEqual([['mark', 'mouth'], ['mark', 'mouth']]);
  });

  it("the mouth's length follows the diet: a hunter's corner below the front of its eye, a plant-eater's well ahead of it", () => {
    const corner = (id: string) => {
      const r = cast(id), sk = buildSkeleton(r), m = mouthFrame(sk, r, detail(sk))!, H = sk.bones[m.head], a = norm(sub(H.end, H.start));
      const eyes = sk.bones.filter((b) => b.role === 'eye'), E = eyes[0], re = Math.max(E.r0, E.r1);
      // along the head's axis: the hinge, and the eyeball's centre and front
      const along = (p: Vec3) => dot(sub(p, H.start), a);
      return { hinge: along(m.hinge), eye: along(lerp(E.start, E.end, 0.5)), front: along(lerp(E.start, E.end, 0.5)) + re, re, L: dist(m.tip, m.hinge) };
    };
    for (const id of ['fox', 'wolf']) {
      const c = corner(id);
      expect(c.hinge, id).toBeCloseTo(c.front, 9); // below the eye's front
    }
    for (const id of ['rabbit', 'deer']) {
      const c = corner(id);
      expect(c.hinge - c.front, id).toBeGreaterThan(2 * c.re); // well ahead of the eye
    }
    // a short mouth: the plant-eaters' hinge-to-tip is a smaller part of the head than the hunters'
    const share = (id: string) => { const r = cast(id), sk = buildSkeleton(r), H = sk.bones.find((b) => b.role === 'head')!; return corner(id).L / Math.max(H.r0, H.r1); };
    for (const plant of ['rabbit', 'deer']) for (const hunter of ['fox', 'wolf']) expect(share(plant), `${plant} < ${hunter}`).toBeLessThan(share(hunter));
    // a bird's mouth is its beak: whatever it eats, its corner is at or ahead of the beak's base (at the head's surface)
    for (const id of ['duck', 'hawk'])
      for (const preyMax of [0, 0.5]) {
        const r = { ...cast(id), mind: { ...cast(id).mind, preyMax } }, sk = buildSkeleton(r), m = mouthFrame(sk, r, detail(sk))!;
        const H = sk.bones[m.head], B = sk.bones[m.mouth], lH = dist(H.start, H.end), a = norm(sub(H.end, H.start));
        // along the head bone, then along the beak (its line bends at the head's end)
        const along = dot(sub(m.hinge, H.end), a) > 0 ? lH + dot(sub(m.hinge, B.start), norm(sub(B.end, B.start))) : dot(sub(m.hinge, H.start), a);
        expect(along, `${id} preyMax ${preyMax}`).toBeGreaterThanOrEqual(lH + Math.max(B.r0, B.r1) - 1e-9);
      }
    // diet is what moves it: the same fox fed only plants gets the short mouth
    const veg = { ...fox, mind: { ...fox.mind, preyMax: 0 } }, sk = buildSkeleton(fox);
    expect(dist(mouthFrame(sk, veg, detail(sk))!.tip, mouthFrame(sk, veg, detail(sk))!.hinge)).toBeLessThan(dist(mouthFrame(sk, fox, detail(sk))!.tip, mouthFrame(sk, fox, detail(sk))!.hinge));
  });

  it("no brow over an eye that looks up (a frog's); the cranium is as thin as a squashed head", () => {
    expect(count(faceOf(cast('frog')).f, 'brow')).toBe(0);
    const { sk, f } = faceOf(cast('trout')), h = sk.bones.find((b) => b.role === 'head')!;
    const c = f.find((g) => g.name === 'cranium')!.shape;
    if (c.type !== 'ellipsoid') throw new Error('ellipsoid');
    expect(c.r.y).toBeCloseTo(0.85 * Math.max(h.r0, h.r1) * h.squash, 9); // the trout's head is thin sideways
  });

  it('anatomy carries the mouth frame', () => {
    const sk = buildSkeleton(fox), d = detail(sk);
    expect(anatomy(sk, fox, d).mouth).toEqual(mouthFrame(sk, fox, d));
    const bs = buildSkeleton(blob);
    expect(anatomy(bs, blob, detail(bs)).mouth).toBeNull();
  });

  it('the hawk gets a beak hook and no cheeks; the duck a bill; the trout slits; the blob nothing', () => {
    const hawk = faceOf(cast('hawk')).f;
    expect(count(hawk, 'hook')).toBe(1);
    expect(count(hawk, 'cheek')).toBe(0);
    const duck = faceOf(cast('duck')).f;
    expect(count(duck, 'bill')).toBe(1);
    expect(count(duck, 'cheek')).toBe(0);
    const trout = faceOf(cast('trout')).f;
    expect(count(trout, 'slit')).toBe(2);
    expect(count(trout, 'cheek')).toBe(2);
    expect(count(trout, 'chin')).toBe(0); // no muzzle bone: the head's own bulk is under the slit
    const b = faceOf(blob);
    expect(b.f).toHaveLength(0);
    expect(mouthFrame(b.sk, blob, FINE)).toBeNull();
  });

  it('a pad nose gets its philtrum groove, and creases where they are wider than a cell', () => {
    const { f } = faceOf(cast('wolf'), { cell: 0.0005 });
    expect(count(f, 'philtrum')).toBe(1);
    expect(count(f, 'crease')).toBe(2);
    expect(count(faceOf(cast('wolf'), { cell: 0.01 }).f, 'crease')).toBe(0);
  });

  it('carves the mouth and the sockets out of the head', () => {
    const sk = buildSkeleton(fox), d = detail(sk), a = anatomy(sk, fox, d), face = faceFeatures(sk, fox, d);
    const full = bodySdf(sk, a), plain = bodySdf(sk, noFace(a, face.length));
    const mouth = face.find((g) => g.name === 'mouth')!.shape;
    if (mouth.type !== 'slab') throw new Error('slab');
    expect(full(mouth.c.x, mouth.c.y, mouth.c.z)).toBeGreaterThan(0);
    for (const s of face.filter((g) => g.name === 'socket')) {
      if (s.shape.type !== 'ellipsoid') throw new Error('sphere');
      // the socket centre and the eyeball centre (a little behind it) are opened up by the carve
      const eye = sk.bones[s.bone!], c = add(eye.start, scale(sub(eye.end, eye.start), 0.5)), p = s.shape.c;
      expect(full(p.x, p.y, p.z)).toBeGreaterThan(Math.max(0, plain(p.x, p.y, p.z)));
      expect(full(c.x, c.y, c.z)).toBeGreaterThan(plain(c.x, c.y, c.z));
    }
  });

  it("a head, neck or torso leaning backward from upright keeps its frame's up on the dorsal side (the back)", () => {
    const sk = buildSkeleton(fox), h = sk.bones.find((b) => b.role === 'head')!;
    for (const role of ['head', 'neck', 'torso'] as const) {
      const back = { ...h, role, end: add(h.start, v3(0, 0.09, -0.02)) };
      const f = boneFrame(back);
      expect(f.up.z, role).toBeLessThan(0);
      expect(dot(f.up, f.a)).toBeCloseTo(0, 9);
      expect(dot(f.side, f.side)).toBeCloseTo(1, 9);
      expect(dot(cross(f.up, f.a), f.side)).toBeCloseTo(1, 9); // still right-handed
      // leaning forward from upright: up is world up made perpendicular, already on the back
      expect(boneFrame({ ...back, end: add(h.start, v3(0, 0.09, 0.02)) }).up.z, role).toBeLessThan(0);
    }
    // a tail rising behind keeps world up (its dorsal side faces forward as it curls up); a head lying level keeps the top
    expect(boneFrame({ ...h, role: 'tail', end: add(h.start, v3(0, 0.09, -0.02)) }).up.z).toBeGreaterThan(0);
    expect(boneFrame({ ...h, end: add(h.start, v3(0, 0.02, -0.09)) }).up.y).toBeGreaterThan(0.9);
    expect(boneFrame(h).up.y).toBeGreaterThan(0.9);
  });

  it('ear cups sit on the ear front; thin ears get only a front mark', () => {
    const { sk, f } = faceOf(fox);
    for (const g of f.filter((h) => h.name === 'earCup')) {
      expect(g.op).toBe('carve');
      expect(g.facing).toBeDefined();
      const e = sk.bones[g.bone!];
      if (g.shape.type !== 'ellipsoid') throw new Error('ellipsoid');
      expect(dot(sub(g.shape.c, e.start), g.facing!)).toBeGreaterThan(0);
    }
    const coarse = faceOf(fox, { cell: 0.01 }).f.filter((h) => h.name === 'earCup');
    expect(coarse).toHaveLength(2);
    for (const g of coarse) expect(g).toMatchObject({ op: 'mark', mark: 'earInner' });
  });

  it('every mark has a band (Task 9 shades by distance / markBand)', () => {
    for (const r of [...CAST.map((c) => c.recipe), quadruped, snake, hexapod, biped, bird, upright])
      for (const d of [FINE, { cell: 0.01 }])
        for (const g of anatomy(buildSkeleton(r), r, d).features.filter((h) => h.mark)) expect(g.markBand, `${r.id} ${g.name}`).toBeGreaterThan(0);
  });

  it("slit nostrils run inward through the skin (their inner end is deep inside the head)", () => {
    for (const r of [cast('frog'), cast('trout'), hexapod]) {
      const sk = buildSkeleton(r), a = anatomy(sk, r, FINE), face = faceFeatures(sk, r, FINE), plain = bodySdf(sk, noFace(a, face.length));
      const slits = face.filter((g) => g.name === 'slit');
      expect(slits, r.id).toHaveLength(2);
      for (const s of slits) {
        if (s.shape.type !== 'cone') throw new Error('cone');
        const { a: inner, b: outer, r0 } = s.shape;
        expect(plain(inner.x, inner.y, inner.z), r.id).toBeLessThan(-r0);
        expect(plain(outer.x, outer.y, outer.z), r.id).toBeGreaterThan(-r0); // and it reaches the skin
      }
    }
  });

  it('marksAt: inside a mark shape is fully marked; add and carve marks fade with distance from their surface', () => {
    const ball: Shape = { type: 'ellipsoid', c: v3(), ax: [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)], r: v3(0.1, 0.1, 0.1) };
    const out = new Float32Array(8).fill(7), up = v3(0, 1, 0);
    const w = (op: 'mark' | 'add', p = v3(), mark: 'hoof' | 'earInner' = 'hoof', n = up) => {
      marksAt([feature(op, ball, 0, { mark, markBand: 0.02, facing: v3(0, 0, 1) })], p, n, out, 4);
      return out[4 + ['nose', 'earInner', 'mouth', 'hoof'].indexOf(mark)];
    };
    expect(w('mark')).toBe(1); // deep inside
    expect(w('add')).toBe(0); // far from the surface
    expect(w('add', v3(0.1, 0, 0))).toBeCloseTo(1, 6);
    expect(w('mark', v3(0.11, 0, 0))).toBeCloseTo(0.5, 2);
    expect(w('mark', v3(0.13, 0, 0))).toBe(0);
    expect(w('mark', v3(), 'earInner', v3(0, 0, -1))).toBe(0); // faces away from the ear's front
    expect(w('mark', v3(), 'earInner', v3(0, 0, 1))).toBe(1);
    expect(out.slice(0, 4)).toEqual(new Float32Array(4).fill(7)); // writes only its own four lanes
    marksAt([], v3(), up, out, 4);
    expect(out.slice(4)).toEqual(new Float32Array(4));
    // cuts trim a mark-only shape (keep x < 0.05: the plane through x = 0.05 facing −x) and nothing else
    const cut = { cuts: [{ p: v3(0.05, 0, 0), n: v3(-1, 0, 0) }] };
    const cutW = (op: 'mark' | 'add', p: Vec3) => (marksAt([feature(op, ball, 0, { mark: 'hoof', markBand: 0.02, ...cut })], p, up, out, 0), out[3]);
    expect(cutW('mark', v3())).toBe(1);
    expect(cutW('mark', v3(0.09, 0, 0))).toBe(0); // inside the ball, past the cut
    expect(cutW('add', v3(0.1, 0, 0))).toBeCloseTo(1, 6); // an add's surface mark is not cut
  });

  // thin, long ears (a hare's, a fennec's from the designer) take the mark-only path too
  const longEars = (k: number): Recipe => ({ ...fox, parts: fox.parts.map((p) => (p.role === 'ear' ? { ...p, length: p.length * k } : p)) });

  it("the fox's inner ear is marked on its front face, not on the head round its base (cupped, thin and long thin ears)", () => {
    for (const k of [1, 1.6, 2]) {
      const r = longEars(k), sk = buildSkeleton(r);
      for (const d of [detail(sk), { cell: 0.01 }]) {
        const a = anatomy(sk, r, d), sdf = bodySdf(sk, a), out = new Float32Array(4), tag = `×${k} cell ${d.cell}`;
        const h = 1e-4, grad = (p: Vec3) => norm(v3(
          sdf(p.x + h, p.y, p.z) - sdf(p.x - h, p.y, p.z), sdf(p.x, p.y + h, p.z) - sdf(p.x, p.y - h, p.z), sdf(p.x, p.y, p.z + h) - sdf(p.x, p.y, p.z - h)));
        // the surface along `dir` from `p` (inside): march out, then bisect
        const surface = (p: Vec3, dir: Vec3) => {
          let lo = 0, hi = 0;
          while (sdf(...xyz(at(p, dir, hi))) < 0) { lo = hi; hi += 2e-4; }
          for (let j = 0; j < 40; j++) { const m = (lo + hi) / 2; if (sdf(...xyz(at(p, dir, m))) < 0) lo = m; else hi = m; }
          return at(p, dir, hi);
        };
        const ear = (q: Vec3) => (marksAt(a.features, q, grad(q), out, 0), out[1]);
        const ears = sk.bones.filter((b) => b.role === 'ear');
        expect(ears).toHaveLength(2);
        for (const E of ears) {
          const t = thinAxis(E), ea = norm(sub(E.end, E.start)), across = norm(cross(t, ea));
          expect(ear(surface(lerp(E.start, E.end, 0.5), t)), `front ${tag}`).toBeGreaterThanOrEqual(0.9);
          // head skin round the ear's base, from inside the head up through the skin: behind it, in front of it (a round
          // cone round the ear reached r0 into the forehead) and to its sides
          const H = sk.bones.find((b) => b.role === 'head')!, inside = lerp(H.start, H.end, 0.3);
          for (const [side, dir, s] of [['behind', t, -1.5], ['in front', t, 1.5], ['left', across, 1], ['right', across, -1]] as const)
            expect(ear(surface(inside, norm(sub(at(E.start, dir, s * E.r0), inside)))), `${side} ${tag}`).toBeLessThanOrEqual(0.2);
          // and below it, in the ear's plane: forward-facing head skin under the base (where a slab running on past the
          // base would reach)
          for (const s of [0.5, 1, 1.5, 2, 3]) {
            const p = at(E.start, ea, -s * E.r0);
            if (sdf(...xyz(p)) < 0) expect(ear(surface(p, t)), `below ${s} ${tag}`).toBeLessThanOrEqual(0.2);
          }
        }
      }
    }
  });

  it('no vertex off the ears gets the inner-ear mark, even with long thin ears', () => {
    for (const k of [1, 1.6, 2]) {
      const body = buildBody(longEars(k), [0]), lod = body.lods[0], bones = body.skeleton.bones;
      let worst = 0;
      for (let v = 0; v < lod.boneOf.length; v++) if (bones[lod.boneOf[v]].role !== 'ear') worst = Math.max(worst, lod.feature[v * 4 + 1]);
      expect(worst, `×${k}`).toBeLessThanOrEqual(0.2);
    }
  }, 60_000);

  it('frameAlong stays orthonormal when the axis is parallel to up', () => {
    for (const a of [v3(0, 1, 0), v3(0, -1, 0)]) {
      const fr = frameAlong(a, v3(0, 1, 0));
      for (const [u, w] of [[fr.a, fr.up], [fr.a, fr.side], [fr.up, fr.side]]) expect(Math.abs(dot(u, w))).toBeLessThan(1e-9);
      for (const u of [fr.up, fr.side]) expect(dot(u, u)).toBeCloseTo(1, 9);
    }
  });

  it('is deterministic', () => {
    expect(faceOf(fox).f).toEqual(faceOf(fox).f);
  });
});

describe('upright faces (a head within 35° of vertical)', () => {
  /** The head bone's axis point at the height of `p` (the bone is near vertical), and the head's radius there. */
  const axisAt = (H: Skeleton['bones'][number], p: Vec3) => {
    const t = (p.y - H.start.y) / (H.end.y - H.start.y);
    return { c: lerp(H.start, H.end, t), r: H.r0 + (H.r1 - H.r0) * t };
  };
  const eyes = (sk: Skeleton) => sk.bones.filter((b) => b.role === 'eye').map((e) => lerp(e.start, e.end, 0.5));

  it('the mouth runs level across the front of the face, below the eyes, on the front half of the head', () => {
    for (const r of [biped, upright]) {
      const sk = buildSkeleton(r), m = mouthFrame(sk, r, detail(sk))!, H = sk.bones[m.head];
      expect(m, r.id).not.toBeNull();
      expect(Math.abs(m.forward.y), r.id).toBeLessThan(0.5); // was (0, 0.998, 0.07) for the biped: a cut up the face
      expect(m.forward.z, r.id).toBeGreaterThan(0.85);
      expect(m.up.y, r.id).toBeGreaterThan(0.85);
      for (const p of [m.hinge, m.tip]) {
        const { c, r: rr } = axisAt(H, p);
        expect(p.z - c.z, `${r.id} front half`).toBeGreaterThan(0);
        expect(p.z - c.z, `${r.id} inside the head's front`).toBeLessThanOrEqual(1.3 * rr);
        expect(p.y, `${r.id} below the crown`).toBeLessThan(H.end.y);
        for (const e of eyes(sk)) expect(p.y, `${r.id} below the eyes`).toBeLessThan(e.y);
      }
      // the slit is a level slab across the face, and there is a nose on the face (not on the crown)
      const face = faceFeatures(sk, r, detail(sk)), slit = face.find((g) => g.name === 'mouth')!.shape;
      if (slit.type !== 'slab') throw new Error('slab');
      expect(Math.abs(slit.ax[2].y), r.id).toBeGreaterThan(0.85);
      const nose = face.find((g) => g.name === 'nose' || g.name === 'slit');
      if (nose) expect(nose.min.y, r.id).toBeLessThan(H.end.y);
    }
    expect(eyes(buildSkeleton(upright))).toHaveLength(2);
  });

  it('the jaw takes only the face below the slit; opening 0.3 rad drops the chin and leaves the forehead and eyes be', () => {
    for (const r of [biped, upright]) {
      const b = buildBody(r, [0]), m = b.mouth!, sk = b.skeleton, lod = b.lods[0], P_ = lod.positions, n = P_.length / 3;
      const H = sk.bones[m.head], rH = Math.max(H.r0, H.r1), h = m.halfThick;
      expect(sk.jaw, r.id).toBeGreaterThanOrEqual(0);
      const shut = jawPose(lod, sk.jaw, m, b.jawLift, 0), open = jawPose(lod, sk.jaw, m, b.jawLift, 0.3);
      let carried = 0, chinDown = 0, chinN = 0, forehead = 0;
      for (let v = 0; v < n; v++) {
        const q = sub(v3(P_[v * 3], P_[v * 3 + 1], P_[v * 3 + 2]), m.hinge), w = jawWeight(lod, sk.jaw, v);
        const d = v3(open[v * 3] - shut[v * 3], open[v * 3 + 1] - shut[v * 3 + 1], open[v * 3 + 2] - shut[v * 3 + 2]);
        if (w > 0.5) {
          carried++;
          expect(dot(q, m.up), r.id).toBeLessThan(h); // below the slit
        }
        if (w > 0.9) { chinDown += dot(d, m.up); chinN++; }
        if (dot(q, m.up) > 2 * h) forehead = Math.max(forehead, Math.hypot(d.x, d.y, d.z));
      }
      expect(carried, r.id).toBeGreaterThan(100);
      expect(chinDown / chinN / rH, `${r.id} chin goes down`).toBeLessThan(-0.05);
      expect(forehead / rH, `${r.id} forehead`).toBeLessThan(0.1);
      // the eyes ride on the head bone, not the jaw
      for (const e of sk.bones.filter((x) => x.role === 'eye')) expect(e.parent).toBe(m.head);
    }
  }, 30_000);

  it('an upright head with a muzzle opens along the muzzle; a muzzle pointing up gets no mouth', () => {
    const snout = (dir: [number, number, number]): Recipe => ({ ...upright, parts: [...upright.parts, P('snout', 'head', 'mouth', 0.3, dir, 0.08, 0.05, 0.03, { offset: [0, 0, 0.07] })] });
    const r = snout([0, -0.15, 1]), sk = buildSkeleton(r), m = mouthFrame(sk, r, detail(sk))!;
    expect(m).not.toBeNull();
    expect(sk.bones[m.mouth].role).toBe('mouth');
    expect(Math.abs(m.forward.y)).toBeLessThan(0.5);
    expect(m.up.y).toBeGreaterThan(0.85);
    const M = sk.bones[m.mouth];
    expect(m.tip.z).toBeGreaterThan(M.end.z); // at the muzzle's front
    expect(count(faceFeatures(sk, r, detail(sk)), 'chin')).toBe(1);
    const up = snout([0, 1, 0.3]), su = buildSkeleton(up);
    expect(mouthFrame(su, up, detail(su))).toBeNull();
  });

  it('no mouth beats a wrong one: a head hanging straight down, or a face with no room under its eyes, gets no slit, chin or jaw', () => {
    const hanging: Recipe = { ...quadruped, parts: quadruped.parts.map((p) => (p.role === 'head' ? { ...p, dir: norm(v3(0, -1, 0.15)) } : p)) };
    // eyes set low on a head sunk into its torso: the face clears the torso only above them
    const sunk: Recipe = { ...upright, parts: upright.parts.map((p) => (p.role === 'eye' ? { ...p, attach: 0.35 } : p)) };
    for (const r of [hanging, sunk]) {
      const sk = buildSkeleton(r), d = detail(sk);
      expect(mouthFrame(sk, r, d), r.id).toBeNull();
      const face = faceFeatures(sk, r, d);
      for (const name of ['mouth', 'chin', 'lipLine']) expect(count(face, name), `${r.id} ${name}`).toBe(0);
      expect(count(face, 'cranium'), r.id).toBe(1); // the rest of the face is still there
      expect(anatomy(sk, r, d).mouth).toBeNull();
    }
    const b = buildBody(hanging, [2]);
    expect(b.mouth).toBeNull();
    expect(b.skeleton.jaw).toBe(-1);
    expect(b.jawLift).toBe(0);
    expect(b.skeleton.bones.some((x) => x.jaw)).toBe(false);
    expect(badEdges(b.lods[0])).toBe(0);
  }, 30_000);
});

describe('faces mesh cleanly', () => {
  it('every native and fixture meshes closed at the production cell', () => {
    for (const r of [...CAST.map((c) => c.recipe), quadruped, snake, hexapod, blob, biped, bird, upright]) expect(badEdges(productionMesh(r)), r.id).toBe(0);
  }, 120_000);

  it('the fox builds closed meshes at all three LODs (the slit does not tear)', () => {
    for (const m of buildBody(fox).lods) expect(badEdges(m)).toBe(0);
  }, 60_000);
});
