import {
  ExtrudeGeometry, Group, Mesh, MeshToonNodeMaterial, Quaternion, Shape, Vector3, type Scene,
} from 'three/webgpu';
import { knockMultiplier } from '../fight/tune';
import type { Ragdoll } from '../physics/ragdoll';
import { toonGradient } from '../render/toon';

/**
 * Dizzy stars (spec §3.2): four gold stars spinning over a fighter's head once it is wobbly enough to be knocked out,
 * so kids can see it coming. They grow as it gets wobblier.
 */

/** Stars show once the knock multiplier passes this. */
export const STARS_AT = 0.8;
const STARS = 4;
/**
 * Sizes are × the fighter's ring height, never less than MIN_H (so a tiny fighter's stars still read on a TV): a star's
 * width; the scale it shows at, its growth per unit of knock multiplier past STARS_AT and its cap.
 */
const MIN_H = 0.9, STAR_SIZE = 0.12, MIN_SCALE = 0.7, GROW = 1.5, MAX_SCALE = 1.5;
/** The circle the stars spin on and how high over the head (× ring height), spin (rad/s), bob (× ring height). */
const CIRCLE = 0.3, ABOVE = 0.16, SPIN = 3.2, BOB = 0.04;

export const starsVisible = (wobble: number, build: number) => knockMultiplier(wobble, build) > STARS_AT;

/** How big the stars are (× their base size): from 0.7 as they appear, growing with the wobble, up to 1.5. */
export function starScale(wobble: number, build: number): number {
  return Math.min(MAX_SCALE, MIN_SCALE + Math.max(0, knockMultiplier(wobble, build) - STARS_AT) * GROW);
}

/** What the stars need of a fighter. */
type Dizzy = { readonly wobble: number; readonly state: string; readonly ragdoll: Ragdoll; readonly layout: { readonly ringHeight: number } };

/** A five-pointed star, 1 across, puffy (extruded), centred. Made once. */
let geo: ExtrudeGeometry | null = null;
let mat: MeshToonNodeMaterial | null = null;
function starParts() {
  if (!geo) {
    const s = new Shape();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + Math.PI / 2, r = i % 2 ? 0.22 : 0.5;
      if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    s.closePath();
    geo = new ExtrudeGeometry(s, { depth: 0.16, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.04, bevelSegments: 1 });
    geo.center();
    mat = new MeshToonNodeMaterial({ color: 0xffd23f });
    mat.gradientMap = toonGradient();
  }
  return { geo, mat: mat! };
}

const _head = new Vector3(), _q = new Quaternion(), UP = new Vector3(0, 1, 0);

export class DizzyStars {
  private readonly sets = new Map<Dizzy, { group: Group; spin: number }>();

  /** `tune.build` is read live (the dev sliders write it). */
  constructor(private readonly scene: Scene, private readonly tune: { readonly build: number }) {}

  /** Once a frame per fighter: shows, spins and places its stars over its head, or hides them. */
  update(fighter: Dizzy, dt: number): void {
    const show = fighter.state === 'fighting' && starsVisible(fighter.wobble, this.tune.build) && fighter.ragdoll.pieces.length > 0;
    let set = this.sets.get(fighter);
    if (!show) {
      if (set) set.group.visible = false;
      return;
    }
    if (!set) set = this.add(fighter);
    const H = Math.max(MIN_H, fighter.layout.ringHeight), head = fighter.ragdoll.head ?? fighter.ragdoll.torso;
    const p = head.body.translation();
    _head.set(p.x, p.y + head.seg.radius + ABOVE * H, p.z);
    set.spin += dt * SPIN;
    const g = set.group;
    g.visible = true;
    g.position.copy(_head);
    g.rotation.y = set.spin;
    g.scale.setScalar(starScale(fighter.wobble, this.tune.build) * H);
    for (let i = 0; i < g.children.length; i++) {
      const star = g.children[i];
      star.position.y = Math.sin(set.spin * 2 + i * 1.7) * BOB;
      star.quaternion.copy(_q.setFromAxisAngle(UP, -set.spin * 2.5 + i));
    }
  }

  /** Takes a fighter's stars out of the scene (it left the ring). */
  remove(fighter: Dizzy): void {
    const set = this.sets.get(fighter);
    if (!set) return;
    this.scene.remove(set.group);
    this.sets.delete(fighter);
  }

  /** Takes every fighter's stars out of the scene (a new round). The star geometry and material are shared and kept. */
  clear(): void {
    for (const set of this.sets.values()) this.scene.remove(set.group);
    this.sets.clear();
  }

  private add(fighter: Dizzy) {
    const { geo, mat } = starParts();
    const group = new Group();
    group.name = 'dizzy-stars';
    for (let i = 0; i < STARS; i++) {
      const star = new Mesh(geo, mat);
      const a = (i / STARS) * Math.PI * 2;
      star.position.set(Math.cos(a) * CIRCLE, 0, Math.sin(a) * CIRCLE);
      star.scale.setScalar(STAR_SIZE); // the star is 1 across: STAR_SIZE × the group's scale
      group.add(star);
    }
    this.scene.add(group);
    const set = { group, spin: 0 };
    this.sets.set(fighter, set);
    return set;
  }
}
