import RAPIER from '@dimforge/rapier3d-compat';
import type { Tune } from '../fight/tune';

/** The ring is a slab this thick; its top is the floor at y = 0. */
const RING_HALF_THICK = 0.7;
/** The bumper ring of padded blocks round the edge (the spike's `buildWall`). */
const BUMPER_SEGMENTS = 56;
const BUMPER_OUT = 0.15;
const BUMPER_HALF_WIDTH = 0.2;

/** The ring's own bounce wins over a body's (the higher of the two): fliers bounce off the floor and the bumper. */
const MAX = RAPIER.CoefficientCombineRule.Max;

/**
 * The ring's physics: a fixed cylinder whose top is the floor (y = 0) out to `ringRadius`, and a padded bumper of
 * `tune.bumper` m round the edge that stops shoves, while big hits fly over it. Both are bouncy (`floorBounce`,
 * `bumperBounce`): the bumper is a trampoline wall that sends fliers back in. Visuals live elsewhere.
 */
export function addArenaColliders(world: RAPIER.World, tune: Tune): { rebuildBumper(height: number): void } {
  const R = tune.ringRadius;
  world.createCollider(
    RAPIER.ColliderDesc.cylinder(RING_HALF_THICK, R).setTranslation(0, -RING_HALF_THICK, 0).setFriction(0.9)
      .setRestitution(tune.floorBounce).setRestitutionCombineRule(MAX),
  );

  const bumper: RAPIER.Collider[] = [];
  const rebuildBumper = (h: number) => {
    for (const c of bumper) world.removeCollider(c, false);
    bumper.length = 0;
    if (h <= 0) return;
    const r = R + BUMPER_OUT;
    const seg = (2 * Math.PI * r) / BUMPER_SEGMENTS;
    for (let i = 0; i < BUMPER_SEGMENTS; i++) {
      const a = (i / BUMPER_SEGMENTS) * Math.PI * 2;
      // turned by -a about +y: the block's local x points out from the centre, its local z runs along the edge
      const q = { x: 0, y: Math.sin(-a / 2), z: 0, w: Math.cos(-a / 2) };
      bumper.push(world.createCollider(
        RAPIER.ColliderDesc.cuboid(BUMPER_HALF_WIDTH, h / 2, seg * 0.55)
          .setTranslation(Math.cos(a) * r, h / 2, Math.sin(a) * r)
          .setRotation(q)
          .setFriction(0.3)
          .setRestitution(tune.bumperBounce)
          .setRestitutionCombineRule(MAX),
      ));
    }
  };
  rebuildBumper(tune.bumper);
  return { rebuildBumper };
}
