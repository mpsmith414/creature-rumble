import RAPIER from '@dimforge/rapier3d-compat';

/** A big fixed floor whose top is at y = 0. */
export function floor(w: RAPIER.World): RAPIER.Collider {
  const body = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  return w.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5, 50).setFriction(0.7), body);
}
