import { Color, InstancedMesh, Matrix4, MeshBasicNodeMaterial, Quaternion, SphereGeometry, Vector3, type Scene } from 'three/webgpu';

/**
 * Motion trails for fliers (big-fights design §3): a short line of ghost balls in the fighter's colour left behind its
 * torso while it is in the air, each shrinking away. Every ghost of every trail is one instance of a single instanced
 * mesh made once (TRAILS × GHOSTS), so a whole flying ring is one draw call and nothing is allocated per frame. At most
 * TRAILS fighters trail at once; a trail's slot is freed once it has faded and its fighter has landed.
 */

/** Fighters that can trail at once, and ghosts per trail. */
export const TRAILS = 8, GHOSTS = 8;
/** A ghost is dropped every TRAIL_EVERY s while flying, and shrinks away over TRAIL_LIFE s. */
export const TRAIL_EVERY = 0.04, TRAIL_LIFE = 0.32;
/** A new ghost's radius (× the fighter's ring height), never smaller than TRAIL_MIN m. */
const TRAIL_SIZE = 0.22, TRAIL_MIN = 0.12;
const TRAIL_OPACITY = 0.45;

/** How big a ghost `age` s old is (× its new size): 1 when dropped, shrinking to 0 at TRAIL_LIFE. */
export function ghostFade(age: number): number {
  if (!(age >= 0) || age >= TRAIL_LIFE) return 0;
  const u = 1 - age / TRAIL_LIFE;
  return u * u * (3 - 2 * u) * 0.85 + 0.15 * u;
}

/**
 * How many ghosts to drop this frame: the time since the last one plus `dt`, every TRAIL_EVERY s (at most GHOSTS, so a
 * stalled frame cannot overrun the trail). Returns the count and the time left over toward the next.
 */
export function ghostsDue(since: number, dt: number): { n: number; left: number } {
  const t = Math.max(0, since) + Math.max(0, dt);
  const n = Math.min(GHOSTS, Math.floor(t / TRAIL_EVERY + 1e-9));
  return { n, left: n === GHOSTS ? 0 : t - n * TRAIL_EVERY };
}

type Slot = { index: number; key: object | null; head: number; since: number; size: number; at: Float32Array; age: Float64Array; colour: Color };
/** The age of a ghost slot that holds no ghost. */
const DEAD = 1e9;

const _m = new Matrix4(), _p = new Vector3(), _s = new Vector3(), _q = new Quaternion();

export class Trails {
  readonly mesh: InstancedMesh;
  private readonly slots: Slot[] = [];
  private readonly byKey = new Map<object, Slot>();
  private readonly geo = new SphereGeometry(1, 10, 8);
  private readonly mat: MeshBasicNodeMaterial;
  private dirty = false;

  constructor(private readonly scene: Scene) {
    this.mat = new MeshBasicNodeMaterial({ transparent: true, opacity: TRAIL_OPACITY, depthWrite: false });
    this.mat.toneMapped = false;
    this.mesh = new InstancedMesh(this.geo, this.mat, TRAILS * GHOSTS);
    this.mesh.name = 'trails';
    this.mesh.frustumCulled = false;
    const white = new Color(1, 1, 1);
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < TRAILS * GHOSTS; i++) {
      this.mesh.setMatrixAt(i, _m);
      this.mesh.setColorAt(i, white);
    }
    for (let i = 0; i < TRAILS; i++) {
      this.slots.push({ index: i, key: null, head: 0, since: 0, size: 0, at: new Float32Array(GHOSTS * 3), age: new Float64Array(GHOSTS).fill(DEAD), colour: new Color() });
    }
    scene.add(this.mesh);
  }

  /** How many fighters have a trail now. */
  get count(): number { return this.byKey.size; }
  /** How many ghosts are showing. */
  get ghosts(): number {
    let n = 0;
    for (const s of this.slots) for (const a of s.age) if (a < TRAIL_LIFE) n++;
    return n;
  }

  /**
   * Once a frame per fighter (`key`): while it flies (`air`) ghosts are dropped at its torso (`at`); either way its old
   * ghosts shrink. `height` (its ring height, m) sizes them; `colour` is its own.
   */
  update(key: object, at: { x: number; y: number; z: number }, height: number, air: boolean, colour: Color, dt: number): void {
    let s = this.byKey.get(key);
    if (!s) {
      if (!air) return;
      s = this.slots.find((x) => x.key === null);
      if (!s) return; // every trail is in use: this flier goes without
      s.key = key;
      s.since = TRAIL_EVERY; // the first ghost drops at once
      s.age.fill(DEAD);
      this.byKey.set(key, s);
    }
    s.colour.copy(colour);
    s.size = Math.max(TRAIL_MIN, TRAIL_SIZE * height);
    let live = false;
    for (let g = 0; g < GHOSTS; g++) {
      if (s.age[g] < TRAIL_LIFE) s.age[g] += Math.max(0, dt);
      if (s.age[g] < TRAIL_LIFE) live = true;
    }
    if (air) {
      const due = ghostsDue(s.since, dt);
      s.since = due.left;
      for (let k = 0; k < due.n; k++) {
        const g = s.head;
        s.head = (s.head + 1) % GHOSTS;
        s.at[g * 3] = at.x;
        s.at[g * 3 + 1] = at.y;
        s.at[g * 3 + 2] = at.z;
        s.age[g] = (due.n - 1 - k) * TRAIL_EVERY; // a stalled frame's ghosts sit on one spot but fade in turn
        live = true;
      }
    } else s.since = TRAIL_EVERY;
    this.write(s);
    if (!air && !live) this.free(s);
  }

  /** Once a frame after every `update`: hands the moved ghosts to the GPU. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** A fighter's trail goes now (it left the world). */
  remove(key: object): void {
    const s = this.byKey.get(key);
    if (s) this.free(s);
  }

  /** Every trail goes (a new round). */
  clear(): void {
    for (const s of this.slots) if (s.key !== null) this.free(s);
  }

  /** Out of the scene for good. */
  dispose(): void {
    this.clear();
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
    this.mesh.dispose();
  }

  private free(s: Slot): void {
    if (s.key) this.byKey.delete(s.key);
    s.key = null;
    s.age.fill(DEAD);
    this.write(s);
  }

  private write(s: Slot): void {
    const base = s.index * GHOSTS;
    for (let g = 0; g < GHOSTS; g++) {
      const k = ghostFade(s.age[g]) * s.size;
      _p.set(s.at[g * 3], s.at[g * 3 + 1], s.at[g * 3 + 2]);
      _m.compose(_p, _q, _s.set(k, k, k));
      this.mesh.setMatrixAt(base + g, _m);
      this.mesh.setColorAt(base + g, s.colour);
    }
    this.dirty = true;
  }
}

/** A fighter's trail colour: the colour of the region on its root part (its body), a little toward white so it reads. */
export function trailColour(recipe: { parts: readonly { parent: string | null; region: string }[]; skin: { regions: readonly { id: string; color: string }[] } }): Color {
  const root = recipe.parts.find((p) => p.parent === null);
  const region = recipe.skin.regions.find((r) => r.id === root?.region) ?? recipe.skin.regions[0];
  const c = new Color(1, 1, 1);
  try {
    if (region) c.set(region.color);
  } catch { /* a colour three cannot read: white */ }
  return c.lerp(WHITE, 0.25);
}
const WHITE = new Color(1, 1, 1);
