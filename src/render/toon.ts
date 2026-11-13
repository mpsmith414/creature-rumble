import { DataTexture, MeshToonNodeMaterial, NearestFilter, RedFormat, type Node, type Object3D } from 'three/webgpu';
import { float, mix, normalView, positionViewDirection, smoothstep, uniform, vec3 } from 'three/tsl';
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
 * A special's glow (big-fights design §3): the body's own colour, this far toward white, lit over the whole body at
 * GLOW_BODY and strongly round the silhouette (GLOW_RIM, from GLOW_RIM_FROM), × the object's glow level (0 … 1).
 */
const GLOW_WHITE = 0.55, GLOW_BODY = 0.3, GLOW_RIM = 1.4, GLOW_RIM_FROM = 0.25;
/** Where a fighter's body mesh keeps its glow level (`userData`), read by its material each time it is drawn. */
export const GLOW_KEY = 'glow';

/**
 * Sets how strongly a fighter's body glows (0 … 1, clamped). It is a uniform read per object as it is drawn, so the
 * shader is never rebuilt: every fighter's material keeps the same code (and pipeline) whatever its glow.
 */
export function setGlow(mesh: Object3D, level: number): void {
  mesh.userData[GLOW_KEY] = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
}

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
  // the glow level is read per object as it is drawn (`setGlow`), so changing it never recompiles the shader
  const glow = uniform(0).onObjectUpdate(({ object }) => (object?.userData[GLOW_KEY] as number | undefined) ?? 0);
  const glowShape = smoothstep(GLOW_RIM_FROM, 1, edge).mul(GLOW_RIM).add(GLOW_BODY);
  const glowLight = mix(col, vec3(1, 1, 1), GLOW_WHITE).mul(glowShape).mul(glow);
  m.emissiveNode = mix(col, vec3(1, 1, 1), RIM_WHITE).mul(rim).add(glowLight);
  return m;
}
