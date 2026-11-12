import { Vector3 } from 'three/webgpu';
import { SPOT_ON } from '../arena/arena';
import { swing } from './camera';
import type { Fighter } from '../fight/fighter';
import type { Piece } from '../physics/ragdoll';
import {
  column, entranceAt, entranceState, LAND_IN, landingAngle, marchOrder, SHOW_JUMP, WALK_TO, type EntrancePhase,
} from './timeline';

/**
 * Entrances (spec §2.3): fighters bounce down the bridge, show off at its ring end, hop over the bumper into the ring
 * and are handed back to the fight. The walk, the jump, the spin and the hop are posed (`Ragdoll.pose`, kinematic):
 * the bridge has no collider and the bumper spans the entry. While the signature move plays (`Fighter.showOff`, no
 * hits) the limbs that throw it are left free so it shows; once it ends (an entering fighter has no muscles) the whole
 * fighter is posed again until the entrance is done.
 *
 * The fight loop runs it once per physics step, before the fighters think and the world steps; it must keep stepping
 * the world (and calling `think` on entering fighters) while the ring is frozen — `setFrozen` holds the ring still.
 */

/** What an entrance uses of the arena: the entry, the bridge and the spotlight. */
export type EntranceStage = {
  entry: { angle: number; dir: Vector3 };
  bridge: { show(on: boolean): void };
  spot: { intensity: number; position: Vector3; target: { position: Vector3 } };
};

/** Moments the show reacts to (banners, comic words). */
export type EntranceCue =
  | { type: 'maker' | 'name'; fighters: readonly Fighter[] }
  | { type: 'taDa'; fighter: Fighter; at: Vector3 }
  | { type: 'done'; fighters: readonly Fighter[] };

/** The hop over the bumper rises at least this high (m), or this fraction of its length. */
const HOP_MIN = 1.3, HOP_PER_M = 0.35;
/** The spotlight sits this high over the walker. */
const SPOT_UP = 12;
/** TA-DA as the show-off jump nears its top (jump 0 … 1). */
const TA_DA_AT = 0.95;

type Member = {
  f: Fighter;
  /** Walk from / to (m past the ring's edge along the entry). */
  from: number;
  to: number;
  /** Where it ends up (ground point) and the way it faces in the hop and after. */
  land: Vector3;
  hopYaw: number;
  /** The limbs that throw its move. */
  free: Set<Piece>;
  fired: boolean;
  taDa: boolean;
  /** Its ground point this step, and how far past the edge it is along the entry while on the bridge. */
  root: Vector3;
  offset: number;
};

const _a = entranceState();
const _p0 = new Vector3();

export class Entrance {
  /** Seconds into the current entrance (restarted when it is upgraded to a group). */
  t = 0;
  group = false;
  active = false;
  /** Where the spotlight looks: the walker's ground point, or the middle of the group's. */
  readonly focus = new Vector3();
  /** For the camera (`CameraDirector.entrance`): the mean lift (m) off the ground (bounce, jump, hop), the tallest ring height. */
  lift = 0;
  height = 1;
  /** How far the camera has swung from the walk shot to the show-off shot (0 … 1), by the front walker's progress. */
  side = 0;
  private members: Member[] = [];
  private banner: string | null = null;
  private readonly inYaw: number;

  constructor(private readonly stage: EntranceStage, private readonly tune: { readonly ringRadius: number },
    private readonly onCue: (cue: EntranceCue) => void = () => {}) {
    const d = stage.entry.dir;
    this.inYaw = Math.atan2(-d.x, -d.z);
  }

  get phase(): EntrancePhase {
    return this.active ? entranceAt(this.t, this.group, 0, _a).phase : 'done';
  }

  get fighters(): readonly Fighter[] {
    return this.members.map((m) => m.f);
  }

  /** Where a fighter in this entrance stands now (its ground point, before any lift), or null. */
  spotOf(f: Fighter): Vector3 | null {
    return this.members.find((m) => m.f === f)?.root ?? null;
  }

  /**
   * Starts an entrance for `fighters` (a group when `group`; the `champion` among them walks last). Called again while
   * one runs (an arrival joined it: the match's `entranceStart` names everyone), it restarts the clock as a group:
   * those already walking carry on from where they are, at the front, the newcomers fall in behind.
   */
  run(fighters: readonly Fighter[], group: boolean, champion?: Fighter | null): void {
    const was = this.active ? this.members : [];
    const kept = was.filter((m) => fighters.includes(m.f));
    const order = marchOrder([...kept.map((m) => m.f), ...fighters.filter((f) => !kept.some((m) => m.f === f))], champion);
    const { gap, travel } = column(order.length);
    const R = this.tune.ringRadius, dir = this.stage.entry.dir;
    this.members = order.map((f, i) => {
      const old = kept.find((m) => m.f === f);
      const to = WALK_TO + i * gap;
      const a = this.stage.entry.angle + landingAngle(i, order.length, R);
      const land = new Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(R - LAND_IN);
      const start = _p0.copy(dir).multiplyScalar(R + to);
      const m: Member = {
        f, to, land,
        from: old ? Math.max(to, old.offset) : to + travel,
        hopYaw: Math.atan2(land.x - start.x, land.z - start.z),
        free: old?.free ?? moveLimbs(f),
        fired: old?.fired ?? false,
        taDa: old?.taDa ?? false,
        root: new Vector3(),
        offset: 0,
      };
      if (f.state !== 'gone') f.state = 'entering';
      return m;
    });
    // those already walking stay where they are; a newcomer starts at least a gap behind the one in front of it, and
    // a gap ahead of anyone already walking behind it (the champion moved to the back is never sent back up the bridge)
    const ms = this.members, isNew = (m: Member) => !kept.some((k) => k.f === m.f);
    for (let i = 0; i < ms.length; i++) {
      if (!isNew(ms[i])) continue;
      let j = i;
      while (j + 1 < ms.length && isNew(ms[j + 1])) j++;
      // newcomers i … j fall in between those already walking in front (lo) and behind (hi)
      const lo = i > 0 ? ms[i - 1].from : -Infinity, hi = j + 1 < ms.length ? ms[j + 1].from : Infinity, c = j - i + 1;
      if (hi - lo < (c + 1) * gap) {
        for (let k = i; k <= j; k++) ms[k].from = lo + ((hi - lo) * (k - i + 1)) / (c + 1); // too little room: share it
      } else {
        for (let k = i; k <= j; k++) ms[k].from = Math.max(ms[k].from, (k > 0 ? ms[k - 1].from : -Infinity) + gap);
        for (let k = j; k >= i; k--) ms[k].from = Math.min(ms[k].from, (k + 1 < ms.length ? ms[k + 1].from : Infinity) - gap);
      }
      i = j;
    }
    this.t = 0;
    this.group = group;
    this.active = true;
    this.banner = null;
    this.stage.bridge.show(true);
    this.stage.spot.intensity = SPOT_ON;
    this.place();
  }

  /** One physics step (s): poses everyone, fires show-offs, cues the show; hands the fighters back when done. */
  update(dt: number): void {
    if (!this.active) return;
    this.t += dt;
    this.place();
    if (entranceAt(this.t, this.group, 0, _a).phase === 'done') this.finish();
  }

  /** Stops an entrance part way (the champion was crowned): bridge down, spot off; the fighters are left as they are. */
  cancel(): void {
    if (!this.active) return;
    this.active = false;
    this.members = [];
    this.stage.bridge.show(false);
    this.stage.spot.intensity = 0;
  }

  private finish(): void {
    const fs = this.members.map((m) => m.f);
    for (const f of fs) if (f.state === 'entering') f.state = 'fighting';
    this.cancel();
    this.onCue({ type: 'done', fighters: fs });
  }

  /** Poses every member for now and keeps the spotlight on them. */
  private place(): void {
    const R = this.tune.ringRadius, dir = this.stage.entry.dir, n = this.members.length;
    const banner = entranceAt(this.t, this.group, 0, _a).banner;
    if (banner !== this.banner) {
      this.banner = banner;
      if (banner) this.onCue({ type: banner, fighters: this.members.map((m) => m.f) });
    }
    this.focus.set(0, 0, 0);
    let counted = 0, lifts = 0;
    for (let i = 0; i < n; i++) {
      const m = this.members[i], f = m.f;
      if (f.state === 'gone') continue;
      const a = entranceAt(this.t, this.group, i, _a);
      let yaw = this.inYaw, lift = a.bob;
      if (a.phase === 'walk' || a.phase === 'showOff') {
        m.offset = m.from + (m.to - m.from) * a.walk;
        m.root.copy(dir).multiplyScalar(R + m.offset);
        lift += a.jump * SHOW_JUMP * f.layout.ringHeight;
      } else {
        // the hop: from the bridge's ring end over the bumper to its spot in the ring, in an arc
        const start = _p0.copy(dir).multiplyScalar(R + m.to);
        const len = start.distanceTo(m.land);
        m.root.copy(start).lerp(m.land, a.hop);
        lift += 4 * a.hop * (1 - a.hop) * Math.max(HOP_MIN, HOP_PER_M * len);
        yaw = m.hopYaw;
      }
      if (a.phase === 'showOff' && !m.fired) {
        m.fired = true;
        f.showOff();
      }
      // the move's limbs swing free while it plays; the rest (and, once it is over, everything) is held
      f.ragdoll.pose(m.root, yaw, lift, a.spin, f.attack !== 'none' ? m.free : null);
      if (a.phase === 'showOff' && !m.taDa && a.jump >= TA_DA_AT) {
        m.taDa = true;
        this.onCue({ type: 'taDa', fighter: f, at: m.root.clone().setY(lift + f.layout.ringHeight * 1.15) });
      }
      this.focus.add(m.root);
      lifts += lift;
      this.height = counted ? Math.max(this.height, f.layout.ringHeight) : f.layout.ringHeight;
      if (counted === 0) this.side = a.phase === 'walk' ? swing(m.offset) : 1;
      counted++;
    }
    if (counted) {
      this.focus.divideScalar(counted);
      this.lift = lifts / counted;
    }
    const spot = this.stage.spot;
    spot.target.position.copy(this.focus);
    spot.position.copy(this.focus).y += SPOT_UP;
  }
}

/**
 * The pieces that throw a fighter's move: each weapon piece and its parents up to (not including) the torso, and
 * everything hanging off them. A torso weapon (a belly bump) frees nothing: the body itself is held.
 */
export function moveLimbs(f: Fighter): Set<Piece> {
  const ps = f.ragdoll.pieces, free = new Set<Piece>();
  for (const w of ps) {
    if (!w.seg.weapon || w.seg.parent < 0) continue;
    for (let p = w; p.seg.parent >= 0; p = ps[p.seg.parent]) free.add(p);
  }
  for (const p of ps) if (p.seg.parent >= 0 && free.has(ps[p.seg.parent])) free.add(p); // parents come first
  return free;
}

/**
 * Freezes fighters mid-flail (spec §2.3: the fight freezes during an entrance) or lets them go on exactly as they
 * were: their bodies leave the simulation and keep their motion, so the world can still step for the entrance.
 */
export function setFrozen(fighters: readonly Fighter[], frozen: boolean): void {
  for (const f of fighters) for (const p of f.ragdoll.pieces) if (p.body.isEnabled() === frozen) p.body.setEnabled(!frozen);
}
