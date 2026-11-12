import { describe, expect, it } from 'vitest';
import { AUTO_SECONDS, AutoPick, QUALITY_CHOICES, autoQuality, startQuality } from '../../src/render/quality';

describe('startQuality', () => {
  it('starts Auto on High and measures when nothing is remembered (or the setting is junk)', () => {
    for (const junk of [undefined, null, 'ultra', 3]) expect(startQuality(junk, undefined)).toEqual({ choice: 'auto', tier: 'high', measure: true });
    expect(startQuality('auto', null)).toEqual({ choice: 'auto', tier: 'high', measure: true });
  });

  it('keeps the tier Auto picked before and does not measure again', () => {
    expect(startQuality('auto', 'medium')).toEqual({ choice: 'auto', tier: 'medium', measure: false });
    expect(startQuality(undefined, 'low')).toEqual({ choice: 'auto', tier: 'low', measure: false });
  });

  it('uses a chosen tier as it is', () => {
    expect(startQuality('low', 'high')).toEqual({ choice: 'low', tier: 'low', measure: false });
    expect(startQuality('medium', undefined)).toEqual({ choice: 'medium', tier: 'medium', measure: false });
  });

  it('lists Auto first', () => {
    expect(QUALITY_CHOICES).toEqual(['auto', 'high', 'medium', 'low']);
  });
});

describe('AutoPick', () => {
  it('picks with autoQuality once, after AUTO_SECONDS of frames', () => {
    const p = new AutoPick();
    const out: (string | null)[] = [];
    for (let i = 0; i < 30 * (AUTO_SECONDS + 2); i++) out.push(p.push(1 / 30));
    const picks = out.map((x, i) => [x, i] as const).filter(([x]) => x !== null);
    expect(picks).toHaveLength(1);
    expect(picks[0][0]).toBe('low'); // 30 fps
    expect(picks[0][1]).toBeGreaterThanOrEqual(30 * AUTO_SECONDS - 1);
    expect(picks[0][1]).toBeLessThan(30 * AUTO_SECONDS + 1);
    expect(autoQuality([30])).toBe('low');
  });

  it('reads 45 fps as Medium and 60 as High, and skips empty frames', () => {
    const run = (fps: number) => {
      const p = new AutoPick();
      for (let i = 0; i < fps * AUTO_SECONDS + 5; i++) {
        p.push(0);
        const x = p.push(1 / fps);
        if (x) return x;
      }
      return null;
    };
    expect(run(45)).toBe('medium');
    expect(run(60)).toBe('high');
  });

  it('can read each frame by its working time (a screen capped at 42 fps that works 10 ms a frame is High)', () => {
    const p = new AutoPick();
    let pick = null, frames = 0;
    while (!pick && frames < 1000) (pick = p.push(1 / 42, 0.01)), frames++;
    expect(pick).toBe('high');
    expect(frames).toBe(42 * AUTO_SECONDS); // the window is still 4 s of real frames
  });
});
