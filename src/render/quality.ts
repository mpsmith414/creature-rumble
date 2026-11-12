export type Tier = 'low' | 'medium' | 'high';
export const TIERS: readonly Tier[] = ['low', 'medium', 'high'];
/** True for a known tier (remembered settings can hold anything). */
export const isTier = (v: unknown): v is Tier => TIERS.includes(v as Tier);
/** Per-tier settings for the renderer and the creatures. */
export type QualitySettings = { pixelRatio: number; shadowMap: number; lod: 0 | 1 | 2 };

export const QUALITY: Record<Tier, QualitySettings> = {
  high: { pixelRatio: 1, shadowMap: 2048, lod: 0 },
  medium: { pixelRatio: 1, shadowMap: 1024, lod: 1 },
  low: { pixelRatio: 0.75, shadowMap: 512, lod: 2 },
};

/** Pick a tier from measured frame rates (frames per second). */
export function autoQuality(fps: number[]): Tier {
  if (fps.length === 0) return 'high';
  const sorted = [...fps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return median > 55 ? 'high' : median > 35 ? 'medium' : 'low';
}

/** The Quality setting: a tier, or Auto (which measures the frame rate once and then keeps its pick). Auto is listed first. */
export type QualityChoice = 'auto' | Tier;
export const QUALITY_CHOICES: readonly QualityChoice[] = ['auto', 'high', 'medium', 'low'];
/** Seconds of frames Auto measures before it picks. */
export const AUTO_SECONDS = 4;

/**
 * The quality to start with, from the remembered setting (`valley.tier`) and Auto's earlier pick (`valley.autoTier`):
 * a chosen tier as it is; Auto (also the default, and what junk reads as) on its earlier pick, or on High and measuring when
 * it has not picked yet.
 */
export function startQuality(choice: unknown, picked: unknown): { choice: QualityChoice; tier: Tier; measure: boolean } {
  if (isTier(choice)) return { choice, tier: choice, measure: false };
  return isTier(picked) ? { choice: 'auto', tier: picked, measure: false } : { choice: 'auto', tier: 'high', measure: true };
}

/**
 * Auto's measurement: fed each frame's interval `dt` (s), it answers `autoQuality`'s tier once, after `AUTO_SECONDS` of
 * frames. Each frame counts as `1 / work` frames per second: `work` is its working time (s) when known (a screen that caps
 * the frame rate, or a throttled one, then does not hide what the computer can do), else its interval.
 */
export class AutoPick {
  private fps: number[] = [];
  private t = 0;
  private done = false;
  push(dt: number, work = dt): Tier | null {
    if (this.done || !(dt > 0) || !(work > 0)) return null;
    this.fps.push(1 / work);
    this.t += dt;
    if (this.t < AUTO_SECONDS - 1e-9) return null;
    this.done = true;
    return autoQuality(this.fps);
  }
}
