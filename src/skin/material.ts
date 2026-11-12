import { Vector3, Vector4, Color, type Node } from 'three/webgpu';
import {
  abs, attribute, color, float, fract, int, mix, mx_noise_float, mx_worley_noise_float,
  select, sin, smoothstep, step, uniform, uniformArray, varying, vec3,
} from 'three/tsl';
import { COVERINGS, MAX_REGIONS, type Covering } from '../recipe/schema';
import { COVERING_LOOK, type RegionPack } from './patterns';

type F = ReturnType<typeof float>;
type C = ReturnType<typeof vec3>;
type V4 = ReturnType<typeof uniformArray>;
const NO_TINT = new Vector3(1, 1, 1);

/** The surface relief a covering gets: cells for scales and shell, ripples for feathers, a fine grain otherwise. */
export function reliefKind(covering: Covering): 'cells' | 'ripple' | 'grain' {
  return covering === 'scales' || covering === 'shell' ? 'cells' : covering === 'feathers' ? 'ripple' : 'grain';
}
/** True where the covering index `cov` (into COVERINGS) has relief `kind` (the shader's twin of `reliefKind`). */
const isRelief = (cov: F, kind: ReturnType<typeof reliefKind>) =>
  COVERINGS.flatMap((c, i) => (reliefKind(c) === kind ? [cov.equal(i)] : [])).reduce((a, b) => a.or(b));

/**
 * Region settings as six vec4 arrays (WebGPU allows 12 uniform buffers per shader stage):
 *  colA = base rgb, hasBelly · colB = belly rgb, patKind
 *  · colC = pattern rgb, patScale
 *  parA = patAmount, patAlong, furLength, fluff · parB = covering, roughness, sheen, clearcoat · parC = bump
 *  (parC[0].yzw = the nose rgb, parC[1].yzw = the inner-ear rgb: lanes otherwise unused)
 */
export function packUniforms(pack: RegionPack) {
  const rgb = (hex: string, w: number) => {
    const c = new Color(hex);
    return new Vector4(c.r, c.g, c.b, w);
  };
  const look = pack.covering.map((c) => COVERING_LOOK[COVERINGS[c]]);
  // named, so equal materials (two animals of one species) get equal shader code and share a GPU pipeline
  const arr = (name: string, v: Vector4[]) => uniformArray(v, 'vec4').setName(name) as V4;
  return {
    colA: arr('skinColA', pack.base.map((h, i) => rgb(h, pack.hasBelly[i]))),
    colB: arr('skinColB', pack.belly.map((h, i) => rgb(h, pack.patKind[i]))),
    colC: arr('skinColC', pack.patColor.map((h, i) => rgb(h, pack.patScale[i]))),
    parA: arr('skinParA', pack.patAmount.map((a, i) => new Vector4(a, pack.patAlong[i], pack.furLength[i], pack.fluff[i]))),
    parB: arr('skinParB', look.map((l, i) => new Vector4(pack.covering[i], l.roughness, l.sheen, l.clearcoat))),
    parC: arr('skinParC', look.map((l, i) => {
      const c = i < 2 ? new Color(i === 0 ? pack.nose : pack.earInner) : null;
      return new Vector4(l.bump, c?.r ?? 0, c?.g ?? 0, c?.b ?? 0);
    })),
  };
}

/** The colour/finish nodes of a creature's surface, read from the region uniforms. */
export function regionNodes(pack: RegionPack) {
  const U = packUniforms(pack);
  // each animal's own colour shift is read per object (`userData.tint`), so a whole species can share one material
  const tint = uniform(new Vector3(1, 1, 1)).onObjectUpdate(({ object }) => (object?.userData.tint as Vector3 | undefined) ?? NO_TINT);
  const info = attribute('partInfo', 'vec4');
  const bp4 = attribute('bodyPos', 'vec4');
  // The region. Rounding the interpolated index draws a smooth border, but across a triangle whose corners lie in regions
  // 0 and 4 it passes through 1, 2 and 3: a seam of other regions' colours. So: a = the index at the triangle's first
  // corner (flat), and the other region b from the interpolated index v and index² s (v = a + w(b − a), s = a² + w(b² − a²)
  // give b = (s − a²)/(v − a) − a); b wins past the midline, w > ½. Exact where two regions meet; in a triangle whose
  // three corners lie in three regions the formula is only approximate, so a sliver of another region's colour can show there.
  const a = float(varying(int(info.x.add(0.5).floor()))).toVar();
  const dv = info.x.sub(a).toVar();
  const b = bp4.w.sub(a.mul(a)).div(select(abs(dv).greaterThan(1e-4), dv, float(1))).sub(a).toVar();
  const mixed = abs(dv).greaterThan(1e-4);
  const past = abs(dv).mul(2).greaterThan(abs(b.sub(a))).and(mixed);
  const index = (x: ReturnType<typeof select>) => int((x as unknown as F).add(0.5).floor().clamp(0, MAX_REGIONS - 1));
  const i = index(select(past, b, a));
  // the triangle's other region (itself where the triangle lies in one region)
  const across = index(select(mixed, select(past, a, b), a));
  const at = (a: V4) => a.element(i) as unknown as ReturnType<typeof vec3> & { w: F; xyz: C };
  const colA = at(U.colA), colB = at(U.colB), colC = at(U.colC), parA = at(U.parA), parB = at(U.parB), parC = at(U.parC);
  const pt = info.y;
  const ps = info.z;
  const bp = bp4.xyz;
  const rn = attribute('normal', 'vec3'); // the rest normal: the vertex stage skins `normal`, so read it here as the raw attribute

  const hasBelly = colA.w;
  const kind = colB.w;
  const scale = colC.w;
  const amount = parA.x as unknown as F;
  const coord = mix(bp.z, bp.y, parA.y);
  const wobble = mx_noise_float(bp.mul(3).div(scale)).mul(0.9);
  const stripes = float(1).sub(smoothstep(amount.sub(0.04), amount.add(0.04), sin(coord.mul(6.2832).div(scale).add(wobble)).mul(0.5).add(0.5)));
  const spotR = amount.mul(0.7);
  const spots = float(1).sub(smoothstep(spotR.sub(0.06), spotR.add(0.06), mx_worley_noise_float(bp.div(scale))));
  const thr = float(1).sub(amount.mul(2));
  const patches = smoothstep(thr.sub(0.08), thr.add(0.08), mx_noise_float(bp.div(scale)));
  const rings = float(1).sub(step(amount, fract(ps.div(scale))));
  const gradient = pt.mul(amount);
  const mask = select(kind.lessThan(-0.5), float(0),
    select(kind.lessThan(0.5), stripes,
      select(kind.lessThan(1.5), spots,
        select(kind.lessThan(2.5), patches,
          select(kind.lessThan(3.5), rings, gradient))))) as unknown as F;

  // a lighter underside where the rest-pose surface (normal `n`) faces down
  const bellyOf = (n: Node<'vec3'>) => float(1).sub(smoothstep(-0.75, -0.3, n.y)).mul(hasBelly).mul(info.w);
  const bellyAmt = bellyOf(rn as unknown as Node<'vec3'>);
  const mottle = mx_noise_float(bp.mul(18)).mul(0.06).add(0.97);
  const base = mix(colA.xyz, colB.xyz, bellyAmt);
  /** How much of the pattern's colour shows, for the rest normal `n` (fainter on the belly). */
  const patternOf = (n: Node<'vec3'>) => mask.mul(float(1).sub(bellyOf(n).mul(0.6))) as unknown as F;
  const plainColor = base.mul(mottle).mul(tint) as unknown as Node<'vec3'>, patternColor = colC.xyz.mul(mottle).mul(tint) as unknown as Node<'vec3'>;
  const colorNode = mix(plainColor, patternColor, patternOf(rn as unknown as Node<'vec3'>)) as unknown as C;

  // surface relief by covering: cells for scales and shell, ripples for feathers, fine grain otherwise
  const cov = parB.x as unknown as F;
  const cells = mx_worley_noise_float(bp.mul(90));
  const ripple = mx_worley_noise_float(bp.mul(vec3(40, 70, 25)));
  const grain = mx_noise_float(bp.mul(160));
  const height = (select(isRelief(cov, 'cells'), cells, select(isRelief(cov, 'ripple'), ripple, grain)) as unknown as F).mul(parC.x);

  // the colour marks (nose, inner ear, mouth, hoof) and the face colours
  const feature = attribute('feature', 'vec4');
  // the cavity (w of the groom, bound as `tangent`: see lodGeometry)
  const groom4 = attribute('tangent', 'vec4');
  const nose = (U.parC.element(0) as unknown as { yzw: C }).yzw, earInner = (U.parC.element(1) as unknown as { yzw: C }).yzw;

  return {
    tint, i, across, bp, rn, pt, colorNode, plainColor, patternColor, patternOf, height, mask, feature, nose, earInner,
    cavity: groom4.w as unknown as F,
    roughness: parB.y as unknown as F, sheen: parB.z as unknown as F, clearcoat: parB.w as unknown as F,
  };
}

const LIPS = color(new Color('#3a2220')), GUMS = color(new Color('#9a4a48')), GUM_TONE = 0.2;

/**
 * The region colour with the face marks painted on: the nose, the inner ears, dark lips with a gum tone deep in the
 * mouth, and dark hooves.
 */
export function markedColor(r: ReturnType<typeof regionNodes>): C {
  const f = r.feature;
  const c1 = mix(r.colorNode, r.nose, f.x);
  const c2 = mix(c1, r.earInner, f.y.mul(0.85));
  // the lip colour over the mark's upper half (a wide band, so it fades over several edges rather than flipping within
  // one); only a hint of the gum tone, deepest in the mouth (the closed slit shows its walls, and at full strength it read
  // as a gaping pink mouth); none in the nostrils, dark openings in the nose
  const c3 = mix(mix(c2, LIPS, smoothstep(0.5, 1, f.z)), GUMS, smoothstep(0.92, 1, f.z).mul(float(1).sub(f.x)).mul(GUM_TONE));
  return mix(c3, r.colorNode.mul(0.3), f.w) as unknown as C;
}
