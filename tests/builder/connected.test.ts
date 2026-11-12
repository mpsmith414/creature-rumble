import { describe, expect, it } from 'vitest';
import { buildBody, type BodyData } from '../../src/builder/build';
import { skinWeights } from '../../src/builder/weights';
import { CAST } from '../fixtures/cast';
import { add, dot, scale, sub } from '../../src/util/vec';
import { flippedTriangles, jawPose, jawWeight, rayHits } from '../fixtures/jaw';
import { biped, bird, blob, hexapod, quadruped, snake, upright } from '../fixtures/recipes';

/** Number of connected components of a triangle mesh (vertices joined by shared triangles). */
function components(indices: Uint32Array, vertexCount: number): number {
  const p = Int32Array.from({ length: vertexCount }, (_, i) => i);
  const find = (x: number): number => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
  for (let t = 0; t < indices.length; t += 3) { p[find(indices[t])] = find(indices[t + 1]); p[find(indices[t + 1])] = find(indices[t + 2]); }
  return new Set(Array.from(indices, find)).size; // only vertices a triangle uses count
}

describe('connected bodies, and a jaw that opens without tearing', () => {
  for (const recipe of [...CAST.map((c) => c.recipe), quadruped, snake, hexapod, blob, biped, bird, upright]) {
    let built: BodyData | null = null;
    const body = () => (built ??= buildBody(recipe)); // every LOD: LOD0 is exactly what buildBody(recipe, [0]) gives

    it(`${recipe.name} meshes as one piece at LOD0 (no carve or feature severs a part)`, () => {
      const m = body().lods[0];
      expect(components(m.indices, m.positions.length / 3)).toBe(1);
    }, 60_000);

    it(`${recipe.name}'s jaw: only below the slit, other bones' pull untouched, shut without folds, opens without tears`, () => {
      const b = body(), jaw = b.skeleton.jaw, mf = b.mouth, sk = b.skeleton;
      expect(jaw >= 0).toBe(mf !== null);
      if (!mf) return;
      const H = sk.bones[mf.head], rH = Math.max(H.r0, H.r1), h = mf.halfThick;
      const shares = (i: number) => i === mf.head || (sk.bones[i].role === 'mouth' && !sk.bones[i].jaw);
      b.lods.forEach((m, l) => {
        const P = m.positions, n = P.length / 3, I = m.indices;
        const at = (A: Float32Array, v: number) => sub({ x: A[v * 3], y: A[v * 3 + 1], z: A[v * 3 + 2] }, mf.hinge);
        // the jaw pass leaves every bone it does not share from (ears, wings, neck, chest) exactly as it was
        const plain = skinWeights(P, { ...sk, jaw: -1 }, b.regions, null);
        const pull = (W: { skinIndex: Uint16Array; skinWeight: Float32Array }, v: number, i: number) => { let w = 0; for (let k = 0; k < 4; k++) if (W.skinIndex[v * 4 + k] === i) w += W.skinWeight[v * 4 + k]; return w; };
        for (let v = 0; v < n; v++) {
          // the jaw (skinning, not topology) never reaches above the slit: opening the mouth tears nothing off the head
          if (dot(at(P, v), mf.up) > 2 * h) expect(jawWeight(m, jaw, v)).toBe(0);
          expect(m.skinWeight[v * 4] + m.skinWeight[v * 4 + 1] + m.skinWeight[v * 4 + 2] + m.skinWeight[v * 4 + 3]).toBeCloseTo(1, 5);
          for (let k = 0; k < 4; k++) {
            const i = plain.skinIndex[v * 4 + k];
            if (plain.skinWeight[v * 4 + k] > 0 && !shares(i)) expect(pull(m, v, i), `LOD${l} ${sk.bones[i].name}`).toBeCloseTo(pull(plain, v, i), 6);
          }
        }
        // at rest the jaw is raised to shut the slit: no triangle folds over, and the slit's lower face meets the upper one.
        // (The weights fold nothing: across the slit the lift squeezes the side walls to a twentieth of their height, and
        // nothing else changes the height of the skin. Only slivers under a tenth of the median triangle, nearly edge-on to
        // the lift, can turn over between their sampled corners: measured 4 in all bodies and LODs, the largest 6%.)
        const shut = jawPose(m, jaw, mf, b.jawLift, 0);
        expect(flippedTriangles(I, P, shut, 0.1), `LOD${l}`).toBe(0);
        const L = Math.hypot(mf.tip.x - mf.hinge.x, mf.tip.y - mf.hinge.y, mf.tip.z - mf.hinge.z), gaps: number[] = [];
        for (let v = 0; v < n; v++) {
          const q = at(P, v), u = dot(q, mf.up), f = dot(q, mf.forward);
          const nu = m.normals[v * 3] * mf.up.x + m.normals[v * 3 + 1] * mf.up.y + m.normals[v * 3 + 2] * mf.up.z;
          if (jawWeight(m, jaw, v) > 0.5 && u < -0.4 * h && u > -1.6 * h && f > 0.15 * L && f < 0.95 * L && nu > 0.5) gaps.push(h - dot(at(shut, v), mf.up));
        }
        gaps.sort((x, y) => x - y);
        if (gaps.length >= 10) expect(gaps[gaps.length >> 1], `LOD${l} slit gap / halfThick`).toBeLessThan(0.25 * h); // 2h in the bind pose
        // opening 0.4 rad at full detail: along no edge does the jaw's pull jump enough to stretch it by more than a quarter
        // of the head's radius (a head-only jaw tore the rabbit's chin off its chest; the far LODs' long edges span the ramps).
        // The mouth's own skin is the exception: the lips and the lip line on the cheeks (both ends carrying the mouth's
        // mark) stretch by design into the open mouth's dark inside (the cheeks close its sides behind the parted lips);
        // they only must not run far beyond the opening itself
        const arm = (v: number) => { const q = at(P, v); return Math.hypot(dot(q, mf.forward), dot(q, mf.up)); };
        const lip = (v: number) => m.feature[v * 4 + 2] >= 0.5; // (where the lip colour starts)
        let worst = 0, mouthWorst = 0;
        for (let t = 0; t < I.length; t += 3)
          for (const [a, c] of [[I[t], I[t + 1]], [I[t + 1], I[t + 2]], [I[t + 2], I[t]]]) {
            const jump = 0.4 * Math.abs(jawWeight(m, jaw, a) - jawWeight(m, jaw, c)) * Math.max(arm(a), arm(c));
            if (lip(a) && lip(c)) mouthWorst = Math.max(mouthWorst, jump);
            else worst = Math.max(worst, jump);
          }
        if (l === 0) {
          expect(worst / rH).toBeLessThan(0.25);
          expect(mouthWorst / rH).toBeLessThan(0.6); // measured 0.40 (the wolf; the other edges at most 0.14)
        }
        // and opening 0.3 rad barely moves skin that another bone leads (neck, chest, torso)
        const open = jawPose(m, jaw, mf, b.jawLift, 0.3);
        let far = 0;
        for (let v = 0; v < n; v++) if (!shares(m.boneOf[v])) far = Math.max(far, Math.hypot(open[v * 3] - shut[v * 3], open[v * 3 + 1] - shut[v * 3 + 1], open[v * 3 + 2] - shut[v * 3 + 2]));
        expect(far / rH, `LOD${l}`).toBeLessThan(0.1);
      });
    }, 60_000);

    it(`${recipe.name}'s open mouth shows no daylight from the side: the cheeks close it from the corner to 70% of the way to the tip`, () => {
      const b = body(), mf = b.mouth;
      if (!mf) return;
      const L = Math.hypot(mf.tip.x - mf.hinge.x, mf.tip.y - mf.hinge.y, mf.tip.z - mf.hinge.z), theta = 0.3;
      // planes through the open mouth: the slit's plane turned down a quarter, half and three quarters of the jaw's angle
      // about the hinge (the gap's upper, middle and lower parts)
      const planes = [0.25, 0.5, 0.75].map((k) => add(scale(mf.forward, Math.cos(k * theta)), scale(mf.up, -Math.sin(k * theta))));
      b.lods.forEach((m, l) => {
        const open = jawPose(m, b.skeleton.jaw, mf, b.jawLift, theta);
        planes.forEach((dir, j) => {
          for (let k = 1; k <= 14; k++) {
            const o = add(mf.hinge, scale(dir, 0.05 * k * L));
            for (const s of [1, -1]) expect(rayHits(m.indices, open, o, scale(mf.side, s)), `LOD${l} at ${(0.05 * k).toFixed(2)} L, ${(j + 1) / 4} down the gap, side ${s}`).toBe(true);
          }
        });
      });
    }, 60_000);
  }
});
