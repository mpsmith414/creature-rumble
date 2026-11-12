import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three/webgpu';
import type { RagdollLayout, Segment } from './layout';

/** One rigid body of a ragdoll, with where it sits when the creature stands at the origin facing +z. */
export type Piece = { seg: Segment; body: RAPIER.RigidBody; restP: Vector3; restQ: Quaternion; mass: number };

// Tuned in the spike (spike/creature.ts).
const FRICTION = 0.7;
const LINEAR_DAMPING = 0.15;
const ANGULAR_DAMPING = 0.8;
const TORSO_ANGULAR_DAMPING = 1.5;
const HEAD_ANGULAR_DAMPING = 2;
const DENSITY = 1;
/** A round belly (torso radius at least this × height, the blob) is a little denser: harder to shift. */
const BLOB_RATIO = 0.35;
const BLOB_DENSITY = 1.2;

const UP = new Vector3(0, 1, 0);
const STILL = { x: 0, y: 0, z: 0 };
/** `pose`'s scratch. */
const _turn = new Quaternion(), _rot = new Quaternion(), _pos = new Vector3();
const v = (p: { x: number; y: number; z: number }) => new Vector3(p.x, p.y, p.z);

/**
 * A creature's own pieces never collide with each other (spec §6.3), only with the world and other creatures. Each
 * ragdoll in a world takes one of Rapier's 16 collision-group bits: it is a member of that bit and filters it out.
 */
const GROUP_BITS = 16;
const slotUse = new WeakMap<RAPIER.World, number[]>();
function takeSlot(world: RAPIER.World): number {
  let use = slotUse.get(world);
  if (!use) slotUse.set(world, (use = new Array<number>(GROUP_BITS).fill(0)));
  const slot = use.indexOf(Math.min(...use)); // past 16 ragdolls, the least shared bit
  use[slot]++;
  return slot;
}
const groupsFor = (slot: number) => (((1 << slot) << 16) | (0xffff & ~(1 << slot))) >>> 0;

/**
 * Where a segment's piece sits when the creature stands at the origin facing +z: at the middle of its capsule, its
 * local +y along the capsule (a ball keeps no turn).
 */
export function restPlacement(seg: Segment): { p: Vector3; q: Quaternion } {
  const a = v(seg.a), b = v(seg.b);
  const axis = b.clone().sub(a);
  const len = axis.length();
  const p = a.clone().add(b).multiplyScalar(0.5);
  return { p, q: len > 1e-6 ? new Quaternion().setFromUnitVectors(UP, axis.divideScalar(len)) : new Quaternion() };
}

export class Ragdoll {
  readonly pieces: Piece[] = [];
  readonly torso: Piece;
  readonly head: Piece | null;
  readonly mass: number;
  private readonly slot: number;

  constructor(private readonly world: RAPIER.World, layout: RagdollLayout, opts: { bounce: number }) {
    this.slot = takeSlot(world);
    const groups = groupsFor(this.slot);
    const headSeg = layout.segments.find((s) => s.kind === 'head');
    const blobby = layout.segments[0].radius >= BLOB_RATIO * layout.ringHeight;

    for (const seg of layout.segments) {
      const len = v(seg.b).distanceTo(v(seg.a));
      const { p: restP, q: restQ } = restPlacement(seg);
      const root = seg.parent < 0;
      const angDamp = root ? TORSO_ANGULAR_DAMPING : seg === headSeg ? HEAD_ANGULAR_DAMPING : ANGULAR_DAMPING;
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(restP.x, restP.y, restP.z)
          .setRotation({ x: restQ.x, y: restQ.y, z: restQ.z, w: restQ.w })
          .setLinearDamping(LINEAR_DAMPING)
          .setAngularDamping(angDamp)
          .setCcdEnabled(true),
      );
      const shape = len > 1e-6 ? RAPIER.ColliderDesc.capsule(len / 2, seg.radius) : RAPIER.ColliderDesc.ball(seg.radius);
      world.createCollider(
        shape
          .setDensity(root && blobby ? BLOB_DENSITY : DENSITY)
          .setFriction(FRICTION)
          .setRestitution(opts.bounce)
          .setCollisionGroups(groups),
        body,
      );
      const piece: Piece = { seg, body, restP, restQ, mass: body.mass() };
      this.pieces.push(piece);

      if (!root) {
        // the joint sits at the anchor, given in each body's own frame
        const parent = this.pieces[seg.parent];
        const anchor = v(seg.anchor);
        const inParent = anchor.clone().sub(parent.restP).applyQuaternion(parent.restQ.clone().invert());
        const inChild = anchor.clone().sub(restP).applyQuaternion(restQ.clone().invert());
        const joint = world.createImpulseJoint(RAPIER.JointData.spherical(inParent, inChild), parent.body, body, true);
        joint.setContactsEnabled(false);
      }
    }
    this.torso = this.pieces[0];
    this.head = headSeg ? this.pieces[headSeg.id] : null;
    this.mass = this.pieces.reduce((t, p) => t + p.mass, 0);
  }

  /** The torso's position. */
  pos(): Vector3 { return v(this.torso.body.translation()); }
  /** The torso's velocity. */
  vel(): Vector3 { return v(this.torso.body.linvel()); }

  /**
   * Teleport the whole ragdoll as one rigid piece (entrances), as the spike's `Creature.pose`: the creature's origin
   * (the ground under it) goes to `root`, turned by `yaw + spin` about +y and lifted by `bob`; all motion stops.
   * Pieces in `free` are left where and as they are (a limb playing a move while the body is held). Allocates nothing.
   */
  pose(root: Vector3, yaw: number, bob = 0, spin = 0, free?: ReadonlySet<Piece> | null): void {
    _turn.setFromAxisAngle(UP, yaw + spin);
    for (const p of this.pieces) {
      if (free?.has(p)) continue;
      _pos.copy(p.restP).applyQuaternion(_turn).add(root);
      _pos.y += bob;
      _rot.copy(_turn).multiply(p.restQ);
      p.body.setTranslation(_pos, true);
      p.body.setRotation(_rot, true);
      p.body.setLinvel(STILL, true);
      p.body.setAngvel(STILL, true);
    }
  }

  setBounce(b: number): void {
    for (const p of this.pieces) for (let i = 0; i < p.body.numColliders(); i++) p.body.collider(i).setRestitution(b);
  }

  /** Removes every body (with its colliders and joints) from the world. */
  dispose(): void {
    if (!this.pieces.length) return; // already gone
    for (const p of this.pieces) this.world.removeRigidBody(p.body);
    this.pieces.length = 0;
    const use = slotUse.get(this.world);
    if (use) use[this.slot]--;
  }
}
