import { DataTexture, MeshToonNodeMaterial, NearestFilter, RedFormat, type Node } from 'three/webgpu';
import { float, mix, normalView, positionViewDirection, smoothstep, vec3 } from 'three/tsl';
import { markedColor, regionNodes } from '../skin/material';
import type { RegionPack } from '../skin/patterns';

/**
 * The three hard shades of the cartoon look (× the light), from facing away to facing the light (the spike's
 * gradient, 90/170/255, rounded).
 */
export const TOON_BANDS = [0.35, 0.7, 1] as const;

/**
 * The shade for `u` = N·L × ½ + ½ (0 facing away from the light … 1 facing it): the darkest band below ⅓, the middle
 * one below ⅔, full above. The CPU twin of what the GPU reads from `toonGradient` (three's toon lighting samples it at u).
 */
export function toonBand(u: number): number {
  const i = Math.min(TOON_BANDS.length - 1, Math.max(0, Math.floor(u * TOON_BANDS.length)));
  return TOON_BANDS[i];
}

let gradient: DataTexture | null = null;
/** The bands as a 3 × 1 texture, unfiltered, so the shader steps hard between them. One for every fighter. */
export function toonGradient(): DataTexture {
  if (gradient) return gradient;
  const t = new DataTexture(new Uint8Array(TOON_BANDS.map((b) => Math.round(b * 255))), TOON_BANDS.length, 1, RedFormat);
  t.minFilter = t.magFilter = NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return (gradient = t);
}

/** A toon material with the emissive node every lit node material reads (three r186's types leave it off the toon one). */
export type ToonMaterial = MeshToonNodeMaterial & { emissiveNode: Node | null };

/** Where the rim starts (1 − N·V: 0 facing the camera … 1 at the silhouette) and how bright it gets at the edge. */
const RIM_FROM = 0.55, RIM_STRENGTH = 0.35;
/** The rim's light: the body's own colour, half way to white. */
const RIM_WHITE = 0.5;

/**
 * A fighter's cartoon skin: the region colours, patterns and face marks (the valley's `regionNodes`, unchanged), lit in
 * three hard bands (`TOON_BANDS`) by three's toon lighting, plus a soft rim of light round the silhouette. No relief
 * (bump), no cavity darkening, no fur. Equal packs give equal shader code (named uniforms), so they share a pipeline.
 */
export function createToonMaterial(pack: RegionPack): ToonMaterial {
  const r = regionNodes(pack);
  const col = markedColor(r);
  const m = new MeshToonNodeMaterial() as ToonMaterial;
  m.gradientMap = toonGradient();
  m.colorNode = col;
  const edge = float(1).sub(normalView.dot(positionViewDirection).clamp(0, 1));
  const rim = smoothstep(RIM_FROM, 1, edge).mul(RIM_STRENGTH);
  m.emissiveNode = mix(col, vec3(1, 1, 1), RIM_WHITE).mul(rim);
  return m;
}
