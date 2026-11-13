import { AdditiveBlending, Color, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, RingGeometry, type Scene } from 'three/webgpu';

/**
 * A special's shockwave on the floor (big-fights design §3): a flat bright ring that bursts out from the impact to its
 * reach and fades. A small pool of rings made once and reused (the oldest is taken when all are busy); nothing is made
 * per impact or per frame.
 */

/** How long one ring lasts (s), and how many can be out at once. */
export const SHOCK_S = 0.6, SHOCK_POOL = 4;
/** It starts at this fraction of its reach; a reach is never less than this (m). */
export const SHOCK_START = 0.15, SHOCK_MIN = 0.8;
/** How bright it starts (opacity) and how far over the floor it lies (m, clear of the ring's top). */
const SHOCK_OPACITY = 0.85, SHOCK_LIFT = 0.04;
const SHOCK_COLOUR = 0xfff1a8;

/**
 * A shockwave `t` s after its impact, for a reach of `radius` m: how big it is (its outer radius, m) and how bright
 * (opacity 0 … 1). It bursts out fast and slows (an ease-out to its full reach at SHOCK_S) as it fades away; past
 * SHOCK_S it is gone (`alive` false, opacity 0).
 */
export function shockwaveAt(t: number, radius: number): { scale: number; opacity: number; alive: boolean } {
  const reach = Math.max(SHOCK_MIN, Number.isFinite(radius) ? radius : SHOCK_MIN);
  if (!(t >= 0) || t >= SHOCK_S) return { scale: reach, opacity: 0, alive: false };
  const u = t / SHOCK_S;
  const out = 1 - (1 - u) ** 3;
  return { scale: reach * (SHOCK_START + (1 - SHOCK_START) * out), opacity: SHOCK_OPACITY * (1 - u) ** 1.5, alive: true };
}

type Wave = { mesh: Mesh; mat: MeshBasicNodeMaterial; t: number; radius: number; born: number };

export class Shockwaves {
  readonly group = new Group();
  private readonly waves: Wave[] = [];
  private readonly geo = new RingGeometry(0.82, 1, 48);
  private born = 0;

  constructor(private readonly scene: Scene) {
    this.group.name = 'shockwaves';
    this.geo.rotateX(-Math.PI / 2); // flat on the floor
    for (let i = 0; i < SHOCK_POOL; i++) {
      const mat = new MeshBasicNodeMaterial({ color: new Color(SHOCK_COLOUR), transparent: true, opacity: 0, depthWrite: false });
      mat.side = DoubleSide;
      mat.blending = AdditiveBlending;
      mat.toneMapped = false;
      const mesh = new Mesh(this.geo, mat);
      mesh.name = 'shockwave';
      mesh.visible = false;
      mesh.renderOrder = 2;
      this.group.add(mesh);
      this.waves.push({ mesh, mat, t: SHOCK_S, radius: 1, born: -1 });
    }
    scene.add(this.group);
  }

  /** How many rings are out now. */
  get live(): number {
    return this.waves.filter((w) => w.mesh.visible).length;
  }

  /** A ring bursting out from `at` (its floor point is used) to `radius` m. */
  spawn(at: { x: number; y: number; z: number }, radius: number): void {
    const w = this.waves.find((x) => !x.mesh.visible) ?? this.waves.reduce((a, b) => (b.born < a.born ? b : a));
    w.t = 0;
    w.radius = radius;
    w.born = ++this.born;
    w.mesh.position.set(at.x, Math.max(0, Math.min(at.y, 0.5)) + SHOCK_LIFT, at.z);
    w.mesh.visible = true;
    this.place(w);
  }

  /** Once a frame: every ring grows and fades; a finished one hides. */
  update(dt: number): void {
    for (const w of this.waves) {
      if (!w.mesh.visible) continue;
      w.t += Math.max(0, dt);
      this.place(w);
    }
  }

  /** Every ring off (a new round). */
  clear(): void {
    for (const w of this.waves) {
      w.t = SHOCK_S;
      w.mesh.visible = false;
    }
  }

  /** Out of the scene for good (the geometry and materials are freed). */
  dispose(): void {
    this.scene.remove(this.group);
    this.geo.dispose();
    for (const w of this.waves) w.mat.dispose();
  }

  private place(w: Wave): void {
    const s = shockwaveAt(w.t, w.radius);
    w.mesh.visible = s.alive;
    w.mesh.scale.setScalar(s.scale);
    w.mat.opacity = s.opacity;
  }
}
