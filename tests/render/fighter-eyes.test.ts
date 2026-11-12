import { Quaternion, Vector3 } from 'three/webgpu';
import { describe, expect, test } from 'vitest';
import { anatomy } from '../../src/builder/anatomy';
import { buildBody, FINE_CELLS } from '../../src/builder/build';
import { bodySdf } from '../../src/builder/sdf';
import { buildSkeleton } from '../../src/builder/skeleton';
import { planFor } from '../../src/fight/moves';
import { ragdollLayout } from '../../src/physics/layout';
import { createFighterObject } from '../../src/render/fighter-object';
import { eyePlaces } from '../../src/skin/eyes';
import { KINDS, loadFixture } from '../fixtures/fighters';

describe('googly eyes on every fighter fixture', () => {
  test.each(KINDS)('%s: each eye sits on or outside the body, in the open, on the side it faces', (k) => {
    const recipe = loadFixture(k);
    const body = buildBody(recipe, [2]);
    const layout = ragdollLayout(body.skeleton, planFor(recipe, body.skeleton));
    const f = createFighterObject(body, recipe, layout);
    // the body's true shape (bones and anatomy at the builder's fine detail), in creature space
    const sk = buildSkeleton(recipe);
    const longest = Math.max(sk.max.x - sk.min.x, sk.max.y - sk.min.y, sk.max.z - sk.min.z);
    const sdf = bodySdf(sk, anatomy(sk, recipe, { cell: longest / FINE_CELLS }));
    const torso = sk.bones[0], torsoZ = (torso.start.z + torso.end.z) / 2;

    expect(f.eyes.length).toBe(eyePlaces(body, recipe.skin.eyes.size).length);
    expect(f.eyes.length).toBeGreaterThan(0);
    f.root.updateMatrixWorld(true);
    for (const e of f.eyes) {
      const c = new Vector3().setFromMatrixPosition(e.ball!.matrixWorld).divideScalar(layout.scale);
      const gaze = new Vector3(0, 0, 1).applyQuaternion(e.ball!.getWorldQuaternion(new Quaternion()));
      const r = e.radius / layout.scale;
      expect(sdf(c.x, c.y, c.z), `${k} eye centre inside the body`).toBeGreaterThan(-0.15 * r);
      // in the open: nothing of the body in front of it along its gaze (a socket carved deep inside a fat torso is a
      // closed pocket of air, so the centre alone can read "outside")
      for (let s = r; s <= 8 * r; s += 0.1 * r) {
        const p = c.clone().addScaledVector(gaze, s);
        expect(sdf(p.x, p.y, p.z), `${k} eye covered ${(s / r).toFixed(1)} radii out`).toBeGreaterThan(0);
      }
      expect(gaze.z).toBeGreaterThan(0); // looking the way the fighter faces
      expect(c.z).toBeGreaterThan(torsoZ); // on its front
    }
    f.dispose();
  }, 30_000);

  test('an eye already in the open is left where the face put it', () => {
    const recipe = loadFixture('legs');
    const body = buildBody(recipe, [2]);
    const layout = ragdollLayout(body.skeleton, planFor(recipe, body.skeleton));
    const f = createFighterObject(body, recipe, layout);
    f.root.updateMatrixWorld(true);
    eyePlaces(body, recipe.skin.eyes.size).forEach((p, i) => {
      const c = new Vector3().setFromMatrixPosition(f.eyes[i].ball!.matrixWorld).divideScalar(layout.scale);
      expect(c.distanceTo(new Vector3(p.centre.x, p.centre.y, p.centre.z))).toBeLessThan(1e-6);
      expect(f.eyes[i].bone).toBe(p.bone);
    });
    f.dispose();
  }, 30_000);
});
