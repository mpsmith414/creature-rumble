import { describe, expect, it } from 'vitest';
import { anatomy, anatomyBounds, type Anatomy } from '../../src/builder/anatomy';
import { boneFrame, feature, shapeSdf, smax, type Feature } from '../../src/builder/anatomy/shapes';
import { surfaceNets, surfaceNetsSparse } from '../../src/builder/mesher';
import { blendFor, bodySdf, coarseBodySdf, smin } from '../../src/builder/sdf';
import { sampleSparse } from '../../src/builder/sparse';
import { buildSkeleton, type Skeleton } from '../../src/builder/skeleton';
import { CAST } from '../fixtures/cast';
import type { Recipe } from '../../src/recipe/schema';
import { dist, dot, v3, type Vec3 } from '../../src/util/vec';
import { badEdges, productionMesh } from '../fixtures/mesh';
import { biped, blob, hexapod, quadruped, snake } from '../fixtures/recipes';
import { sampleBody } from '../../src/builder/build';

const fox = CAST.find((c) => c.recipe.id === 'fox')!.recipe;
const detail = (sk: Skeleton) => ({ cell: Math.max(sk.max.x - sk.min.x, sk.max.y - sk.min.y, sk.max.z - sk.min.z) / 330 });
const anat = (r: Recipe) => { const sk = buildSkeleton(r); return { sk, a: anatomy(sk, r, detail(sk)) }; };
const named = (a: Anatomy, name: string) => a.features.filter((f) => f.name === name);
const withMuscle = (r: Recipe, muscle: number): Recipe => ({ ...r, build: { ...r.build, muscle } });
const MUSCLE = ['haunch', 'shoulder', 'blade', 'crest'];
const cast = (id: string) => CAST.find((c) => c.recipe.id === id)!.recipe;
/** Edges not in exactly two triangles in the production-cell mesh (0 for a closed mesh). */
const openEdges = (recipe: Recipe) => badEdges(productionMesh(recipe));

describe('shapes', () => {
  it('an ellipsoid is negative inside, ~0 on its surface, positive outside', () => {
    const s = { type: 'ellipsoid' as const, c: v3(1, 0, 0), ax: [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)] as [Vec3, Vec3, Vec3], r: v3(0.3, 0.1, 0.2) };
    expect(shapeSdf(v3(1, 0, 0), s)).toBeLessThan(0);
    expect(Math.abs(shapeSdf(v3(1.3, 0, 0), s))).toBeLessThan(1e-6);
    expect(Math.abs(shapeSdf(v3(1, 0.1, 0), s))).toBeLessThan(1e-6);
    expect(shapeSdf(v3(1, 0.3, 0), s)).toBeCloseTo(0.2, 2);
  });

  it('a feature reach box holds the shape plus its blend', () => {
    const f = feature('add', { type: 'cone', a: v3(0, 0, 0), b: v3(0, 1, 0), r0: 0.1, r1: 0.2 }, 0.05);
    expect(f.min).toEqual(v3(-0.25, -0.25, -0.25));
    expect(f.max).toEqual(v3(0.25, 1.25, 0.25));
  });

  it('smax is max at k = 0 and never below max', () => {
    expect(smax(0.3, 0.5, 0)).toBe(0.5);
    expect(smax(0.3, 0.32, 0.1)).toBeGreaterThan(0.32);
  });

  it('a bone frame is orthonormal, even for a bone pointing straight down', () => {
    const sk = buildSkeleton(quadruped);
    for (const b of [sk.bones[0], { ...sk.bones[0], start: v3(0, 1, 0), end: v3(0, 0, 0) }]) {
      const { a, up, side } = boneFrame(b);
      for (const [u, w] of [[a, up], [a, side], [up, side]]) expect(Math.abs(dot(u, w))).toBeLessThan(1e-9);
      for (const u of [a, up, side]) expect(dot(u, u)).toBeCloseTo(1, 9);
    }
  });
});

describe('body anatomy', () => {
  it("a fox's hind thigh gets one haunch behind and outward of its start; a front leg gets a shoulder", () => {
    const { sk, a } = anat(fox);
    const thigh = sk.bones.findIndex((b) => b.partId === 'thigh' && !b.mirrored);
    const haunch = named(a, 'haunch').filter((f) => f.bone === thigh);
    expect(haunch).toHaveLength(1);
    const s = haunch[0].shape;
    if (s.type !== 'ellipsoid') throw new Error('haunch is an ellipsoid');
    const start = sk.bones[thigh].start;
    expect(Math.sign(start.x)).not.toBe(0);
    expect(s.c.x * Math.sign(start.x)).toBeGreaterThan(Math.abs(start.x)); // outward
    expect(s.c.z).toBeLessThan(start.z + 0.25 * (sk.bones[thigh].end.z - start.z)); // pushed back
    const arm = sk.bones.findIndex((b) => b.partId === 'arm' && !b.mirrored);
    expect(named(a, 'shoulder').filter((f) => f.bone === arm)).toHaveLength(1);
    expect(named(a, 'haunch')).toHaveLength(2);
    expect(named(a, 'shoulder')).toHaveLength(2);
  });

  it("a quadruped's knees get one knob per leg-to-leg joint", () => {
    const { sk, a } = anat(quadruped);
    const joints = sk.bones.filter((b) => b.role === 'leg' && b.parent >= 0 && sk.bones[b.parent].role === 'leg');
    expect(joints).toHaveLength(4);
    const knobs = named(a, 'knob');
    expect(knobs).toHaveLength(4);
    for (const k of knobs) {
      if (k.shape.type !== 'ellipsoid') throw new Error('knob is a sphere');
      expect(k.shape.c).toEqual(sk.bones[k.bone!].start);
    }
  });

  it('muscle 0 gives no muscle shapes, but keeps the joints', () => {
    const { a } = anat(withMuscle(quadruped, 0));
    expect(a.features.filter((f) => MUSCLE.includes(f.name!))).toHaveLength(0);
    expect(named(a, 'knob')).toHaveLength(4);
    expect([...a.slim].every((s) => s === 1)).toBe(true);
    const lean = anat(withMuscle(quadruped, 0.6)).a;
    for (const n of MUSCLE) expect(named(lean, n).length).toBeGreaterThan(0);
  });

  it('slims only lower leg bones', () => {
    const { sk, a } = anat(withMuscle(quadruped, 1));
    sk.bones.forEach((b, i) => {
      const lower = b.role === 'leg' && b.parent >= 0 && sk.bones[b.parent].role === 'leg';
      expect(a.slim[i]).toBeCloseTo(lower ? 0.88 : 1, 6);
    });
  });

  it('a legless body gets no leg or belly features; a hexapod gets no shoulder blades', () => {
    for (const r of [snake, blob]) {
      const { a } = anat(r);
      for (const n of ['haunch', 'shoulder', 'knob', 'ribcage', 'belly', 'blade']) expect(named(a, n)).toHaveLength(0);
    }
    const { a } = anat(hexapod);
    expect(named(a, 'blade')).toHaveLength(0);
    expect(named(a, 'knob').length).toBeGreaterThan(0);
  });

  it('adds only lower the body inside a haunch; the belly tuck only raises it', () => {
    const { sk, a } = anat(fox);
    const plain = bodySdf(sk), full = bodySdf(sk, a);
    const h = named(a, 'haunch')[0].shape, b = named(a, 'belly')[0].shape;
    if (h.type !== 'ellipsoid' || b.type !== 'ellipsoid') throw new Error('ellipsoids');
    expect(full(h.c.x, h.c.y, h.c.z)).toBeLessThanOrEqual(plain(h.c.x, h.c.y, h.c.z));
    // the top of the tuck, where it bites into the belly
    const top = { x: b.c.x + b.ax[1].x * b.r.y, y: b.c.y + b.ax[1].y * b.r.y, z: b.c.z + b.ax[1].z * b.r.y };
    expect(full(top.x, top.y, top.z)).toBeGreaterThan(plain(top.x, top.y, top.z));
  });

  it('features change the body only inside their reach boxes', () => {
    const { sk, a } = anat(fox);
    const plain = bodySdf(sk), full = bodySdf(sk, { features: a.features, slim: new Float32Array(sk.bones.length).fill(1), mouth: null });
    const inAny = (x: number, y: number, z: number) => a.features.some((f: Feature) =>
      f.op !== 'mark' && x >= f.min.x - 0.03 && y >= f.min.y - 0.03 && z >= f.min.z - 0.03 && x <= f.max.x + 0.03 && y <= f.max.y + 0.03 && z <= f.max.z + 0.03);
    let changed = 0;
    for (let i = 0; i < 20_000; i++) {
      const f = (j: number) => ((i * 7919 + j * 104729) % 1000) / 1000;
      const x = sk.min.x + (sk.max.x - sk.min.x) * f(1), y = sk.min.y + (sk.max.y - sk.min.y) * f(2), z = sk.min.z + (sk.max.z - sk.min.z) * f(3);
      if (plain(x, y, z) === full(x, y, z)) continue;
      changed++;
      expect(inAny(x, y, z)).toBe(true);
    }
    expect(changed).toBeGreaterThan(0);
  });

  it('evaluates each feature as shapeSdf does, adds then carves', () => {
    const { sk, a } = anat(fox);
    const plain = bodySdf(sk, { features: [], slim: a.slim, mouth: null }, 1e3), full = bodySdf(sk, a, 1e3); // margin 1e3: nothing is culled
    const ordered = [...a.features.filter((f) => f.op === 'add'), ...a.features.filter((f) => f.op === 'carve')];
    for (let i = 0; i < 2000; i++) {
      const f = (j: number) => ((i * 7919 + j * 104729) % 1000) / 1000;
      const p = v3(sk.min.x + (sk.max.x - sk.min.x) * f(1), sk.min.y + (sk.max.y - sk.min.y) * f(2), sk.min.z + (sk.max.z - sk.min.z) * f(3));
      let d = plain(p.x, p.y, p.z);
      for (const g of ordered) d = g.op === 'add' ? smin(d, shapeSdf(p, g.shape), g.k) : smax(d, -shapeSdf(p, g.shape), g.k);
      expect(full(p.x, p.y, p.z)).toBeCloseTo(d, 9);
    }
  });

  it('the coarse SDF with anatomy keeps the sparse mesh equal to a dense one', () => {
    for (const recipe of [fox, quadruped, hexapod]) {
      const sk = buildSkeleton(recipe), a = anatomy(sk, recipe, detail(sk));
      const { min, max } = sk;
      const cell = Math.max(max.x - min.x, max.y - min.y, max.z - min.z) / 28;
      const sdf = bodySdf(sk, a);
      const sparse = surfaceNetsSparse(sampleSparse(sdf, min, max, cell, 4, coarseBodySdf(sk, a, cell)));
      const dense = surfaceNets(sdf, v3(min.x - 6 * cell, min.y - 6 * cell, min.z - 6 * cell), v3(max.x + 6 * cell, max.y + 6 * cell, max.z + 6 * cell), cell);
      expect(sparse.positions.length).toBe(dense.positions.length);
      expect(sparse.indices.length).toBe(dense.indices.length);
    }
  });

  it('the body bounds hold every add feature (a rabbit haunch sticks out past its bones)', () => {
    const { sk, a } = anat(CAST.find((c) => c.recipe.id === 'rabbit')!.recipe);
    const { min, max } = anatomyBounds(sk, a);
    expect(min.x).toBeLessThan(sk.min.x);
    for (const f of a.features.filter((g) => g.op === 'add'))
      for (const k of ['x', 'y', 'z'] as const) { expect(f.min[k]).toBeGreaterThanOrEqual(min[k]); expect(f.max[k]).toBeLessThanOrEqual(max[k]); }
  });

  it('meshes closed at the production cell (long hexapod belly, big frog features)', () => {
    for (const recipe of [hexapod, CAST.find((c) => c.recipe.id === 'frog')!.recipe]) expect(openEdges(recipe)).toBe(0);
  }, 60_000);

  it('the coarse (shallow) SDF never overstates depth inside a long ellipsoid', () => {
    // one add ellipsoid (4 : 1) far from every bone, so the body SDF there is the ellipsoid alone
    const sk = buildSkeleton(blob), c = v3(10, 0, 0), r = v3(0.4, 0.1, 0.15);
    const shape = { type: 'ellipsoid' as const, c, ax: [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)] as [Vec3, Vec3, Vec3], r };
    const a = { features: [feature('add', shape, 0.01)], slim: new Float32Array(sk.bones.length).fill(1), mouth: null };
    const shallow = bodySdf(sk, a, 0.03, true), plain = bodySdf(sk, a, 0.03);
    const surface: Vec3[] = [];
    for (let i = 0; i <= 120; i++)
      for (let j = 0; j < 240; j++) {
        const th = (Math.PI * i) / 120, ph = (2 * Math.PI * j) / 240;
        surface.push(v3(r.x * Math.sin(th) * Math.cos(ph), r.y * Math.sin(th) * Math.sin(ph), r.z * Math.cos(th)));
      }
    let overstated = 0;
    for (let i = 0; i < 300; i++) {
      const f = (j: number) => (((i * 7919 + j * 104729) % 1000) / 1000) * 2 - 1;
      const q = v3(r.x * f(1) * 0.7, r.y * f(2) * 0.7, r.z * f(3) * 0.7);
      if ((q.x / r.x) ** 2 + (q.y / r.y) ** 2 + (q.z / r.z) ** 2 >= 1) continue;
      const depth = Math.min(...surface.map((s) => Math.hypot(s.x - q.x, s.y - q.y, s.z - q.z)));
      expect(-shallow(c.x + q.x, c.y + q.y, c.z + q.z)).toBeLessThanOrEqual(depth + 1e-3);
      if (-plain(c.x + q.x, c.y + q.y, c.z + q.z) > depth + 1e-3) overstated++;
    }
    expect(overstated).toBeGreaterThan(0); // the plain bound does overstate: the test has teeth
  });

  it('puts the neck crest on the dorsal side and the throat on the ventral side (duck neck, near upright)', () => {
    const duck = CAST.find((c) => c.recipe.id === 'duck')!.recipe;
    const { sk, a } = anat(duck);
    const neck = sk.bones.find((b) => b.role === 'neck')!;
    const crest = named(a, 'crest')[0].shape, throat = named(a, 'throat')[0].shape;
    if (crest.type !== 'cone' || throat.type !== 'cone') throw new Error('cones');
    expect(crest.a.z).toBeLessThan(neck.start.z); // behind the neck (it leans forward from upright)
    expect(throat.a.z).toBeGreaterThan(neck.start.z);
  });

  it("carves an upright biped's belly tuck into its front, not its back", () => {
    const { sk, a } = anat(biped);
    const belly = named(a, 'belly')[0];
    if (belly.shape.type !== 'ellipsoid') throw new Error('ellipsoid');
    const t = sk.bones[belly.bone!], mid = { z: t.start.z + 0.7 * (t.end.z - t.start.z) };
    expect(belly.shape.c.z).toBeGreaterThan(mid.z);
  });

  it('never cuts a limb: the duck (legs rooted under the belly) gets no belly tuck; the deer, fox and wolf keep theirs', () => {
    expect(named(anat(cast('duck')).a, 'belly')).toHaveLength(0);
    for (const id of ['deer', 'fox', 'wolf']) expect(named(anat(cast(id)).a, 'belly'), id).toHaveLength(1);
  });

  it("gives a sprawled leg's muscle its front/back radius along z", () => {
    const { a } = anat(hexapod);
    const legs = [...named(a, 'haunch'), ...named(a, 'shoulder')];
    expect(legs.length).toBeGreaterThan(0);
    for (const f of legs) {
      if (f.shape.type !== 'ellipsoid') throw new Error('ellipsoid');
      const { ax, r } = f.shape;
      const zAxis = Math.abs(ax[1].z) > Math.abs(ax[2].z) ? r.y : r.z, other = Math.abs(ax[1].z) > Math.abs(ax[2].z) ? r.z : r.y;
      expect(zAxis).toBeGreaterThan(other); // front/back r·(1 + 0.4m) > side r·(0.85 + 0.35m)
    }
  });

  it('is deterministic', () => {
    const sk = buildSkeleton(fox);
    expect(anatomy(sk, fox, detail(sk))).toEqual(anatomy(sk, fox, detail(sk)));
  });

  it('skips features smaller than two fine cells', () => {
    const sk = buildSkeleton(fox);
    const coarse = anatomy(sk, fox, { cell: 0.05 });
    expect(coarse.features.length).toBeLessThan(anatomy(sk, fox, detail(sk)).features.length);
  });
});

describe('feet', () => {
  const FINE = { cell: 0.0005 }; // fine enough that nothing is skipped
  const feetOf = (r: Recipe, d = FINE) => { const sk = buildSkeleton(r); return { sk, a: anatomy(sk, r, d), feet: sk.bones.map((b, i) => [b, i] as const).filter(([b]) => b.role === 'foot') }; };
  const shrunk = (r: Recipe, k: number): Recipe => ({ ...r, life: { ...r.life, sizeM: r.life.sizeM * k }, parts: r.parts.map((p) => ({ ...p, length: p.length * k, r0: p.r0 * k, r1: p.r1 * k, offset: { x: p.offset.x * k, y: p.offset.y * k, z: p.offset.z * k } })) });
  const from = (p: Vec3, q: Vec3) => v3(q.x - p.x, q.y - p.y, q.z - p.z);

  it("a deer's four hooves each get a split and a hoof mark around the foot bone", () => {
    const { a, feet } = feetOf(cast('deer'));
    expect(feet).toHaveLength(4);
    const splits = named(a, 'split'), marks = a.features.filter((f) => f.op === 'mark' && f.mark === 'hoof');
    expect(splits.map((f) => f.bone)).toEqual(feet.map(([, i]) => i));
    expect(marks.map((f) => f.bone)).toEqual(feet.map(([, i]) => i));
    for (const [b, i] of feet) {
      const rf = Math.max(b.r0, b.r1), m = marks.find((f) => f.bone === i)!, s = splits.find((f) => f.bone === i)!;
      expect(m).toMatchObject({ mark: 'hoof', name: 'hoof' });
      expect(m.markBand).toBeCloseTo(0.3 * rf, 9);
      if (m.shape.type !== 'cone' || s.shape.type !== 'cone') throw new Error('cones');
      expect(m.shape.a).toEqual(b.start); expect(m.shape.b).toEqual(b.end);
      expect(m.shape.r0).toBeCloseTo(b.r0 + 0.1 * rf, 9);
      expect(s.op).toBe('carve'); expect(s.k).toBeCloseTo(0.04 * rf, 9);
    }
    expect(a.features.filter((f) => f.op === 'add' && ['pad', 'toe', 'web'].includes(f.name!))).toHaveLength(0);
  });

  it('hooves blend into the leg tighter (0.05) than other feet (0.15), and bodySdf uses it', () => {
    expect(blendFor('foot', 'hooves')).toBe(0.05);
    for (const f of ['paws', 'talons', 'webbed', 'plain'] as const) expect(blendFor('foot', f)).toBe(0.15);
    expect(blendFor('foot')).toBe(0.15);
    expect(blendFor('leg', 'hooves')).toBe(0.25);
    const deer = cast('deer'), sk = buildSkeleton(deer), a = anatomy(sk, deer, FINE);
    expect(a.feet).toBe('hooves');
    const hoofed = bodySdf(sk, { features: [], slim: a.slim, feet: 'hooves', mouth: null }), soft = bodySdf(sk, { features: [], slim: a.slim, feet: 'paws', mouth: null });
    let higher = 0;
    for (const b of sk.bones.filter((g) => g.role === 'foot'))
      for (let i = 0; i < 40; i++) {
        const p = v3(b.start.x + ((i % 5) - 2) * 0.01, b.start.y + (Math.floor(i / 5) - 4) * 0.01, b.start.z + 0.01);
        expect(hoofed(p.x, p.y, p.z)).toBeGreaterThanOrEqual(soft(p.x, p.y, p.z) - 1e-12);
        if (hoofed(p.x, p.y, p.z) > soft(p.x, p.y, p.z) + 1e-9) higher++;
      }
    expect(higher).toBeGreaterThan(0);
  });

  it("a hawk's talons: three forward toes and a back toe per foot, pointed, tilted down", () => {
    const { a, feet } = feetOf(cast('hawk'));
    expect(feet).toHaveLength(2);
    expect(named(a, 'toe')).toHaveLength(8);
    for (const [b, i] of feet) {
      const rf = Math.max(b.r0, b.r1), f = boneFrame(b), T = Math.max(dist(b.start, b.end), 2.5 * rf);
      const toes = named(a, 'toe').filter((t) => t.bone === i);
      expect(toes).toHaveLength(4);
      const dirs = toes.map((t, j) => {
        if (t.shape.type !== 'cone') throw new Error('cone');
        expect(t.shape.a).toEqual(b.end);
        const d = from(b.end, t.shape.b);
        expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(j < 3 ? T : 0.6 * T, 9);
        expect(dot(d, f.up)).toBeLessThan(0); // tilted down
        expect(dot(d, f.a) > 0).toBe(j < 3); // three forward, one back
        expect(t.shape.r0).toBeCloseTo(0.38 * rf, 9); expect(t.shape.r1).toBeCloseTo(0.07 * rf, 9);
        expect(t.k).toBeCloseTo(0.15 * rf, 9);
        return d;
      });
      // the forward toes fan out to both sides
      expect(dot(dirs[0], f.side)).toBeLessThan(0); expect(dot(dirs[2], f.side)).toBeGreaterThan(0);
      expect(Math.abs(dot(dirs[1], f.side))).toBeLessThan(1e-9);
    }
  });

  it("a duck's webbed feet: three blunt toes and one web per foot", () => {
    const { a, feet } = feetOf(cast('duck'));
    expect(feet).toHaveLength(2);
    expect(named(a, 'web')).toHaveLength(2);
    expect(named(a, 'toe')).toHaveLength(6);
    for (const [b, i] of feet) {
      const rf = Math.max(b.r0, b.r1), T = Math.max(dist(b.start, b.end), 2.5 * rf);
      const toe = named(a, 'toe').find((t) => t.bone === i)!, web = named(a, 'web').find((t) => t.bone === i)!;
      if (toe.shape.type !== 'cone' || web.shape.type !== 'ellipsoid') throw new Error('shapes');
      expect(toe.shape.r0).toBeCloseTo(0.3 * rf, 9); expect(toe.shape.r1).toBeCloseTo(0.2 * rf, 9);
      expect(web.shape.r.x).toBeCloseTo(0.5 * T, 9); expect(web.shape.r.y).toBeCloseTo(0.75 * T, 9);
      expect(web.shape.r.z).toBeCloseTo(Math.max(0.06 * rf, FINE.cell), 9);
      expect(web.k).toBeCloseTo(0.1 * rf, 9);
    }
  });

  it('a fox paw has four toe pads and three grooves between them', () => {
    const { a, feet } = feetOf(cast('fox'));
    expect(feet).toHaveLength(4);
    expect(named(a, 'pad')).toHaveLength(16);
    expect(named(a, 'groove')).toHaveLength(12);
    for (const [b, i] of feet) {
      const rf = Math.max(b.r0, b.r1), f = boneFrame(b);
      const pads = named(a, 'pad').filter((p) => p.bone === i);
      expect(pads).toHaveLength(4);
      pads.forEach((p, j) => {
        if (p.shape.type !== 'ellipsoid') throw new Error('ellipsoid');
        expect(dot(from(b.end, p.shape.c), f.side) / rf).toBeCloseTo([-0.6, -0.2, 0.2, 0.6][j], 9);
      });
      expect(named(a, 'groove').filter((g) => g.bone === i && g.op === 'carve')).toHaveLength(3);
    }
    expect(a.features.some((f) => f.op === 'mark' && f.mark === 'hoof')).toBe(false);
  });

  it('plain feet and legless bodies get nothing', () => {
    const names = ['pad', 'groove', 'split', 'toe', 'web', 'hoof'];
    const plainFox = { ...fox, build: { ...fox.build, feet: 'plain' as const } };
    for (const r of [snake, blob, plainFox, cast('trout')]) expect(anat(r).a.features.filter((f) => names.includes(f.name!))).toHaveLength(0);
  });

  it('tiny feet skip the grooves and the hoof split (thinner than a cell), but keep their pads', () => {
    const tiny = shrunk(fox, 0.1), sk = buildSkeleton(tiny);
    expect(sk.max.z - sk.min.z).toBeLessThan(0.15);
    const small = anatomy(sk, tiny, { cell: 0.0003 }); // 0.06 × the paw radius (0.0017) is under a cell
    expect(named(small, 'groove')).toHaveLength(0);
    expect(named(small, 'pad').length).toBeGreaterThan(0);
    expect(named(feetOf(fox).a, 'groove')).toHaveLength(12);
    const deer = cast('deer'), coarse = anatomy(buildSkeleton(deer), deer, { cell: 0.01 });
    expect(named(coarse, 'split')).toHaveLength(0);
    expect(coarse.features.filter((f) => f.mark === 'hoof')).toHaveLength(4);
  });

  it('at the production cell the hawk keeps its talons, the duck its toes and web, the fox its pads', () => {
    const at = (id: string) => { const r = cast(id); return sampleBody(buildSkeleton(r), r).anat; };
    expect(named(at('hawk'), 'toe')).toHaveLength(8);
    expect(named(at('duck'), 'toe')).toHaveLength(6);
    expect(named(at('duck'), 'web')).toHaveLength(2);
    expect(named(at('fox'), 'pad')).toHaveLength(16);
  }, 60_000);

  it('meshes closed at the production cell with hooves, paws, talons and webs', () => {
    for (const id of ['deer', 'fox', 'hawk', 'duck', 'rabbit']) expect(openEdges(cast(id)), id).toBe(0);
  }, 60_000);
});
