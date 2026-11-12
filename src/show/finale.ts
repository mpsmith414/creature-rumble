import {
  AdditiveBlending, CircleGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide, Euler, Group, InstancedMesh, Matrix4, Mesh,
  MeshBasicNodeMaterial, MeshToonNodeMaterial, PlaneGeometry, Quaternion, RingGeometry, SphereGeometry, Vector3, type Scene,
} from 'three/webgpu';
import type { Piece, Ragdoll } from '../physics/ragdoll';
import { toonGradient } from '../render/toon';

/**
 * The crowning (spec §2.8): a gold crown on the champion's head, a confetti shower and a glow on the floor under it
 * (the spike's crown and Confetti, spike/main.ts and spike/fx.ts). The crown rides the head's physics piece — the
 * piece the head bone follows, which the neck holds up — so it stays put through every strut and bob, and tumbles off
 * with the head when the champion is knocked flat. Allocates nothing per frame.
 */

/** Confetti pieces (one instanced mesh). */
export const CONFETTI = 400;
/** Where the shower starts: within this radius of the champion (× its ring height, at least 1 m), this high over its head. */
const SHOWER_SPREAD = 1.5, SHOWER_HIGH = 1.2;
/** Confetti settles flat this far over the ring; anything that misses the ring stops once it is this far down. */
const CONFETTI_REST = 0.015, CONFETTI_GONE = -14;
const CONFETTI_COLOURS = [0xff4f8b, 0x3ec7ff, 0x7dff5a, 0xffc933, 0xb26bff];
const GOLD = 0xffd23f, GEM = 0xff4f8b, GLOW = 0xffe066;
/** The crown is built for a head of this radius (m) and scaled to the champion's, never smaller than this × its ring height. */
const CROWN_FOR = 0.35, CROWN_MIN = 0.14;

type Crownable = { readonly ragdoll: Ragdoll; readonly layout: { readonly ringHeight: number } };

function toon(hex: number): MeshToonNodeMaterial {
  const m = new MeshToonNodeMaterial({ color: hex });
  m.gradientMap = toonGradient();
  return m;
}

/** The spike's crown: an open gold band with five spikes, plus a pink gem on each spike's tip. */
function crownMesh(): Group {
  const g = new Group();
  g.name = 'crown';
  const gold = toon(GOLD);
  gold.side = DoubleSide;
  const band = new Mesh(new CylinderGeometry(0.32, 0.36, 0.22, 16, 1, true), gold);
  band.castShadow = true;
  g.add(band);
  const spikeGeo = new ConeGeometry(0.08, 0.25, 8), gemGeo = new SphereGeometry(0.045, 10, 8), gem = toon(GEM);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const spike = new Mesh(spikeGeo, gold);
    spike.position.set(Math.cos(a) * 0.33, 0.22, Math.sin(a) * 0.33);
    spike.castShadow = true;
    const tip = new Mesh(gemGeo, gem);
    tip.position.y = 0.14;
    spike.add(tip);
    g.add(spike);
  }
  return g;
}

const _t = new Vector3(), _q = new Quaternion(), _rest = new Quaternion(), _m = new Matrix4(), _e = new Euler();

export class Finale {
  /** Who wears the crown (null before a crowning, or after `clear`). */
  champion: Crownable | null = null;
  private readonly crownObj = crownMesh();
  private readonly glow: Group;
  private readonly glowDisc: Mesh;
  private readonly confetti: InstancedMesh;
  private readonly pos = new Float32Array(CONFETTI * 3);
  private readonly vel = new Float32Array(CONFETTI * 3);
  private readonly rot = new Float32Array(CONFETTI * 3);
  private readonly spin = new Float32Array(CONFETTI * 3);
  /** The piece the crown rides: the head, or the torso for a head sunk into a fatter torso. */
  private rider: Piece | null = null;
  /** The crown's place (the top of its rider at rest), in the rider's rest frame, from its centre. */
  private readonly onTop = new Vector3();
  /** Confetti still moving (it stops being updated once every piece has settled or fallen away). */
  private falling = false;
  private clock = 0;
  private readonly ringRadius: number;
  private readonly rng: () => number;

  /** `ringRadius`: where the confetti can land (6.5 m by default). */
  constructor(private readonly scene: Scene, o: { ringRadius?: number; rng?: () => number } = {}) {
    this.ringRadius = o.ringRadius ?? 6.5;
    this.rng = o.rng ?? Math.random;
    this.crownObj.visible = false;
    const disc = new MeshBasicNodeMaterial({ color: GLOW, transparent: true, opacity: 0.45, blending: AdditiveBlending, depthWrite: false });
    disc.toneMapped = false;
    const rim = new MeshBasicNodeMaterial({ color: GLOW, transparent: true, opacity: 0.8, blending: AdditiveBlending, depthWrite: false });
    rim.toneMapped = false;
    this.glowDisc = new Mesh(new CircleGeometry(1, 48), disc);
    const ring = new Mesh(new RingGeometry(0.92, 1.05, 48), rim);
    this.glow = new Group();
    this.glow.name = 'podium-glow';
    for (const m of [this.glowDisc, ring]) {
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 1;
      this.glow.add(m);
    }
    this.glow.visible = false;

    const paper = new MeshBasicNodeMaterial({ side: DoubleSide });
    paper.toneMapped = false;
    this.confetti = new InstancedMesh(new PlaneGeometry(0.18, 0.28), paper, CONFETTI);
    const c = new Color();
    for (let i = 0; i < CONFETTI; i++) this.confetti.setColorAt(i, c.setHex(CONFETTI_COLOURS[i % CONFETTI_COLOURS.length]));
    this.confetti.name = 'confetti';
    this.confetti.frustumCulled = false; // its pieces fly far from the bounds of one plane
    this.confetti.visible = false;
    scene.add(this.crownObj, this.glow, this.confetti);
  }

  /** Crowns `fighter`: the crown on its head, a confetti shower over it, the glow under it. */
  crown(fighter: Crownable): void {
    this.champion = fighter;
    const rag = fighter.ragdoll, head = rag.head ?? rag.torso, torso = rag.torso;
    // a head sunk into a fatter torso (a blob's, a big fist's) would hide the crown: then it sits on the torso's top
    const top = (p: Piece) => Math.max(p.seg.a.y, p.seg.b.y) + p.seg.radius;
    const on = top(torso) > top(head) ? torso : head;
    this.rider = on;
    // the top of that piece at rest (its higher end, plus its radius), from its centre
    const s = on.seg, end = s.a.y > s.b.y ? s.a : s.b;
    this.onTop.set(end.x - on.restP.x, end.y + s.radius * 1.05 - on.restP.y, end.z - on.restP.z);
    const H = fighter.layout.ringHeight;
    this.crownObj.scale.setScalar(Math.max(head.seg.radius, CROWN_MIN * H) / CROWN_FOR); // sized for the head either way
    this.crownObj.visible = true;
    const size = Math.max(0.6, H * 0.8);
    this.glow.scale.set(size, 1, size);
    this.glow.visible = true;
    const p = rag.torso.body.translation();
    this.placeCrown();
    this.burst(_t.set(p.x, 0, p.z), H);
  }

  /** Once a frame: the crown rides the head, the glow follows the champion and pulses, the confetti falls. */
  update(dt: number): void {
    this.clock += dt;
    if (this.champion && this.rider && this.champion.ragdoll.pieces.length) {
      this.placeCrown();
      const p = this.champion.ragdoll.torso.body.translation();
      this.glow.position.set(p.x, 0.02, p.z);
      (this.glowDisc.material as MeshBasicNodeMaterial).opacity = 0.35 + 0.15 * Math.sin(this.clock * 4);
    }
    if (this.falling) this.fall(dt);
  }

  /** Ends the shower and the glow; the champion keeps its crown (the group entrance after "Again!" shows it off). */
  stop(): void {
    this.falling = false;
    this.confetti.visible = false;
    this.glow.visible = false;
  }

  /** Takes everything away, crown too. */
  clear(): void {
    this.stop();
    this.crownObj.visible = false;
    this.champion = null;
    this.rider = null;
  }

  /** Takes it all out of the scene and frees its geometries and materials (the toon gradient is shared and kept). */
  dispose(): void {
    this.clear();
    this.scene.remove(this.crownObj, this.glow, this.confetti);
    const geos = new Set<{ dispose(): void }>(), mats = new Set<{ dispose(): void }>();
    for (const root of [this.crownObj, this.glow, this.confetti]) {
      root.traverse((o) => {
        if (!(o instanceof Mesh)) return;
        geos.add(o.geometry);
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m);
      });
    }
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
    this.confetti.dispose();
  }

  private placeCrown(): void {
    const h = this.rider!;
    const t = h.body.translation(), r = h.body.rotation();
    // the rider's turn from rest: now × rest⁻¹
    _q.set(r.x, r.y, r.z, r.w).multiply(_rest.copy(h.restQ).invert());
    this.crownObj.position.copy(this.onTop).applyQuaternion(_q).add(_t.set(t.x, t.y, t.z));
    this.crownObj.quaternion.copy(_q);
  }

  /** A shower raining down round and over the champion (`height` m tall), so it shows in the close champion shot. */
  private burst(at: Vector3, height: number): void {
    const r = this.rng, P = this.pos, V = this.vel, S = this.spin, A = this.rot;
    const spread = Math.max(1, SHOWER_SPREAD * height), top = height + SHOWER_HIGH;
    for (let i = 0; i < CONFETTI * 3; i += 3) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * spread;
      P[i] = at.x + Math.cos(a) * d;
      P[i + 1] = top + r() * 3;
      P[i + 2] = at.z + Math.sin(a) * d;
      V[i] = (r() - 0.5) * 4;
      V[i + 1] = r() * 3;
      V[i + 2] = (r() - 0.5) * 4;
      S[i] = r() * 10;
      S[i + 1] = r() * 10;
      S[i + 2] = r() * 10;
      A[i] = A[i + 1] = A[i + 2] = 0;
    }
    this.falling = true;
    this.confetti.visible = true;
    this.fall(0);
  }

  /** Flutters every piece down; a piece reaching the ring lies flat on it, one that misses falls away and stops. */
  private fall(dt: number): void {
    const P = this.pos, V = this.vel, A = this.rot, S = this.spin, drag = Math.max(0, 1 - 1.5 * dt), R = this.ringRadius;
    let moving = 0;
    for (let k = 0, i = 0; k < CONFETTI; k++, i += 3) {
      if (dt > 0 && V[i] === 0 && V[i + 1] === 0 && V[i + 2] === 0) continue; // settled
      V[i + 1] -= 6 * dt;
      V[i] *= drag; V[i + 1] *= drag; V[i + 2] *= drag;
      P[i] += V[i] * dt; P[i + 1] += V[i + 1] * dt; P[i + 2] += V[i + 2] * dt;
      A[i] += S[i] * dt; A[i + 1] += S[i + 1] * dt; A[i + 2] += S[i + 2] * dt;
      const onRing = Math.hypot(P[i], P[i + 2]) < R && P[i + 1] > -0.5;
      if ((onRing && P[i + 1] <= CONFETTI_REST) || P[i + 1] < CONFETTI_GONE) {
        if (onRing) P[i + 1] = CONFETTI_REST;
        V[i] = V[i + 1] = V[i + 2] = 0;
        A[i] = -Math.PI / 2; A[i + 1] = 0; // flat
      } else moving++;
      _m.makeRotationFromEuler(_e.set(A[i], A[i + 1], A[i + 2])).setPosition(P[i], P[i + 1], P[i + 2]);
      this.confetti.setMatrixAt(k, _m);
    }
    this.confetti.instanceMatrix.needsUpdate = true;
    if (dt > 0 && moving === 0) this.falling = false; // all down: it stays on the ring, costing nothing more
  }
}
