import { norm, type Vec3 } from '../util/vec';
import { inferBuild, inferCoat, inferFace } from './hints';
import {
  ACTIVITY, COVERINGS, MOVES, FEATHER_COATS, FUR_COATS, DEFAULT_COLOR, FEET, FLAT_FACINGS, GAITS, HABITATS, LIMITS, MAX_BONES, MAX_PARTS, MAX_REGIONS,
  NOSES, PATTERNS, ROLES, SCHEMA_VERSION, SOCIAL,
  type FightPlan, type FlatFacing, type Part, type Pattern, type Recipe, type Region, type Role,
} from './schema';

export class RecipeError extends Error {}

type Range = readonly [number, number];
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const COLOR_RE = /^#[0-9a-f]{6}$/i;
/** A feathers region's length (m) when it has none: the natives' feathers are 2–3 cm. */
export const FEATHER_LENGTH = 0.02;

/** Defaults for every section except `parts` (a recipe must bring its own body) and the hints inferred from it. */
export const DEFAULT_RECIPE: Omit<Recipe, 'parts' | 'build' | 'face'> = {
  schemaVersion: SCHEMA_VERSION,
  id: 'creature',
  name: 'Creature',
  seed: 1,
  source: { kind: 'words', description: '' },
  skin: {
    regions: [{ id: 'body', covering: 'skin', color: DEFAULT_COLOR, belly: null, furLength: 0, fluff: 0, coat: null, pattern: null }],
    eyes: { color: '#3a2a1a', pupil: 'round', size: 0.8 },
  },
  motion: { gait: 'walk', bounce: 0.3, sway: 0.5, stance: 'normal' },
  life: {
    sizeM: 0.5, massKg: 5, topSpeed: 3, stamina: 0.5, lifespanDays: 400, maturityDays: 60,
    litterMin: 1, litterMax: 3, juvenileHead: 1.3, juvenileFluff: 0.5,
  },
  mind: {
    plants: ['grass'], preyMin: 0, preyMax: 0, scavenger: false, boldness: 0.5, jumpiness: 0.5,
    social: 'solitary', activity: 'day', habitat: ['ground'],
    senses: { fov: 200, acuity: 0.5, night: 0.3, smell: 0.5, hearing: 0.5, colour: 'normal' },
  },
  inheritance: [{ path: 'life.sizeM', spread: 0.08 }],
  fight: null,
};

/** Guess a part's role from its id when it's missing ("leg2_low" is a leg, "ear1" an ear). */
export function inferRole(id: string): Role {
  const s = id.toLowerCase();
  const has = (...w: string[]) => w.some((x) => s.includes(x));
  if (has('eye')) return 'eye';
  if (has('hand', 'fist')) return 'hand'; // before feet: "paw-hand", "claw-hand"
  if (has('foot', 'feet', 'paw', 'hoof', 'claw', 'talon')) return 'foot';
  if (has('arm')) return 'arm'; // "forearm" too
  if (has('leg', 'thigh', 'shin', 'knee', 'calf')) return 'leg';
  if (has('wing')) return 'wing';
  if (has('fin')) return 'fin';
  if (has('tail')) return 'tail';
  if (has('horn', 'spike', 'antler')) return 'horn';
  if (has('antenna', 'feeler')) return 'antenna';
  if (has('ear')) return 'ear';
  if (has('neck')) return 'neck';
  if (has('head', 'skull', 'face')) return 'head';
  if (has('mouth', 'nose', 'snout', 'beak', 'bill', 'muzzle', 'jaw', 'trunk')) return 'mouth';
  if (has('torso', 'body', 'chest', 'belly', 'hip', 'rump', 'back', 'shell', 'seg')) return 'torso';
  return 'other';
}

/** The natural flat side for each role (ears face forward, fins face sideways, the rest face up). */
export const defaultFlatFacing = (role: Role): FlatFacing => (role === 'ear' ? 'forward' : role === 'fin' ? 'side' : 'up');

const DEFAULT_PART: Omit<Part, 'id' | 'parent' | 'flatFacing'> = {
  role: 'other', attach: 1, offset: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 1 },
  length: 0.1, r0: 0.03, r1: 0.03, squash: 1, pointed: false, mirror: false, region: 'body',
};

/**
 * Make any recipe-shaped input safe to build: fill gaps, clamp numbers, fix the part tree.
 * Every change is described in `fixes`. Throws `RecipeError` only when there is no usable body.
 */
export function normalizeRecipe(raw: unknown): { recipe: Recipe; fixes: string[] } {
  if (!isObj(raw)) throw new RecipeError('recipe is not an object');
  const fixes: string[] = [];

  const num = (v: unknown, r: Range, name: string, fallback?: number): number => {
    let n = typeof v === 'number' && Number.isFinite(v) ? v : NaN;
    if (Number.isNaN(n)) {
      n = fallback ?? r[0];
      fixes.push(`${name} missing → ${n}`);
    }
    const c = Math.min(r[1], Math.max(r[0], n));
    if (c !== n) fixes.push(`${name} ${n} → ${c}`);
    return c;
  };
  const pick = <T extends string>(v: unknown, opts: readonly T[], name: string, fallback: T): T => {
    if (opts.includes(v as T)) return v as T;
    fixes.push(`${name} "${String(v)}" → "${fallback}"`);
    return fallback;
  };
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
  const color = (v: unknown, name: string): string => {
    if (typeof v === 'string' && COLOR_RE.test(v)) return v.toLowerCase();
    fixes.push(`${name} "${String(v)}" → ${DEFAULT_COLOR}`);
    return DEFAULT_COLOR;
  };
  const colorOrNull = (v: unknown, name: string): string | null => (v === null || v === undefined ? null : color(v, name));
  const vec = (v: unknown, fallback: Vec3): Vec3 => {
    const o = isObj(v) ? v : {};
    const f = (k: 'x' | 'y' | 'z') => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : fallback[k]);
    return { x: f('x'), y: f('y'), z: f('z') };
  };
  const section = (k: string): Obj => (isObj(raw[k]) ? (raw[k] as Obj) : {});

  // ---- regions first, so parts can point at them ----
  const skinIn = section('skin');
  const regionsIn = Array.isArray(skinIn.regions) ? skinIn.regions.filter(isObj) : [];
  if (regionsIn.length === 0) fixes.push('no skin regions → default "body"');
  const regionSrc = regionsIn.length ? regionsIn : (DEFAULT_RECIPE.skin.regions as unknown as Obj[]);
  if (regionSrc.length > MAX_REGIONS) fixes.push(`${regionSrc.length} regions → ${MAX_REGIONS}`);
  const regionIds = new Set<string>();
  const regions: Region[] = regionSrc.slice(0, MAX_REGIONS).map((r, i) => {
    let id = str(r.id, `region${i}`);
    while (regionIds.has(id)) id = `${id}_2`;
    regionIds.add(id);
    const p = isObj(r.pattern) ? r.pattern : null;
    const pattern: Pattern | null = p && {
      kind: pick(p.kind, PATTERNS, `region ${id} pattern`, 'spots'),
      color: color(p.color, `region ${id} pattern colour`),
      scale: num(p.scale, LIMITS.patScale, `region ${id} pattern scale`, 0.05),
      amount: num(p.amount, LIMITS.unit, `region ${id} pattern amount`, 0.5),
      along: bool(p.along, false),
    };
    const covering = pick(r.covering, COVERINGS, `region ${id} covering`, 'skin');
    // feathers with no length would draw none (the feather shell and the skin's feathers both need one), and a designer's
    // bird often leaves it out: smooth or downy, they get a default
    const feathers = covering === 'feathers';
    let furLength = num(r.furLength, LIMITS.furLength, `region ${id} furLength`, feathers ? FEATHER_LENGTH : 0);
    if (feathers && furLength <= 0) {
      fixes.push(`region ${id} furLength ${furLength} → ${FEATHER_LENGTH} (feathers need a length)`);
      furLength = FEATHER_LENGTH;
    }
    const fluff = num(r.fluff, LIMITS.unit, `region ${id} fluff`, 0);
    // a missing, unknown or mismatched coat word (fur's on feathers, any on scales) is inferred from the rest
    const fits = covering === 'fur' ? FUR_COATS : covering === 'feathers' ? FEATHER_COATS : [];
    const coat = fits.includes(r.coat as never) ? (r.coat as Region['coat']) : inferCoat({ covering, furLength, fluff });
    if (coat !== (r.coat ?? null)) fixes.push(`skin.regions[${i}].coat → ${coat}`);
    return {
      id,
      covering,
      color: color(r.color, `region ${id} colour`),
      belly: r.belly === null || r.belly === undefined ? null : color(r.belly, `region ${id} belly`),
      furLength,
      fluff,
      coat,
      pattern,
    };
  });

  // ---- parts: ids, root, parents, cycles, order, limits ----
  const partsIn = Array.isArray(raw.parts) ? raw.parts.filter(isObj) : [];
  if (partsIn.length === 0) throw new RecipeError('recipe has no parts');
  if (partsIn.length > MAX_PARTS) fixes.push(`${partsIn.length} parts → ${MAX_PARTS}`);
  const ids = new Set<string>();
  let parts: Part[] = partsIn.slice(0, MAX_PARTS).map((p, i) => {
    const want = str(p.id, `part${i}`);
    let id = want;
    for (let n = 2; ids.has(id); n++) id = `${want}_${n}`;
    if (id !== want) fixes.push(`duplicate part id "${want}" → "${id}"`);
    ids.add(id);
    const name = `part ${id}`;
    const region = typeof p.region === 'string' && regionIds.has(p.region) ? p.region : regions[0].id;
    if (region !== p.region) fixes.push(`${name} region "${String(p.region)}" → "${region}"`);
    const dir = vec(p.dir, DEFAULT_PART.dir);
    // non-unit directions are normal input (silently scaled); only a zero one is a fix
    if (Math.hypot(dir.x, dir.y, dir.z) < 1e-9) fixes.push(`${name} dir was zero → forward`);
    // already-unit directions are kept bit-for-bit, so normalising is idempotent
    const nd = Math.abs(Math.hypot(dir.x, dir.y, dir.z) - 1) < 1e-9 ? dir : norm(dir);
    const role = pick(p.role ?? inferRole(id), ROLES, `${name} role`, inferRole(id));
    if (p.role === undefined) fixes.push(`${name} role missing → ${role}`);
    return {
      id,
      parent: typeof p.parent === 'string' ? p.parent : null,
      role,
      attach: num(p.attach, LIMITS.attach, `${name} attach`, 1),
      offset: vec(p.offset, DEFAULT_PART.offset),
      dir: nd,
      length: num(p.length, LIMITS.length, `${name} length`, 0.1),
      r0: num(p.r0, LIMITS.radius, `${name} r0`, 0.03),
      r1: num(p.r1, LIMITS.radius, `${name} r1`, 0.03),
      squash: num(p.squash, LIMITS.squash, `${name} squash`, 1),
      flatFacing: pick(p.flatFacing ?? defaultFlatFacing(role), FLAT_FACINGS, `${name} flatFacing`, defaultFlatFacing(role)),
      pointed: bool(p.pointed, false),
      mirror: bool(p.mirror, false),
      region,
    };
  });

  // one root: the first part without a parent (or the first part)
  const root = parts.find((p) => p.parent === null) ?? parts[0];
  if (root.parent !== null) {
    fixes.push(`no root part → "${root.id}" is the root`);
    root.parent = null;
  }
  for (const p of parts) {
    if (p === root) continue;
    if (p.parent === null) {
      fixes.push(`extra root "${p.id}" → attached to "${root.id}"`);
      p.parent = root.id;
    } else if (!ids.has(p.parent) || p.parent === p.id) {
      fixes.push(`part ${p.id} parent "${p.parent}" → "${root.id}"`);
      p.parent = root.id;
    }
  }
  // break cycles: walking up from any part must reach the root
  const byId = new Map(parts.map((p) => [p.id, p]));
  for (const p of parts) {
    const seen = new Set<string>([p.id]);
    let cur = p;
    while (cur.parent !== null) {
      const up = byId.get(cur.parent)!;
      if (seen.has(up.id)) {
        fixes.push(`cycle through "${cur.id}" → attached to "${root.id}"`);
        cur.parent = root.id;
        break;
      }
      seen.add(up.id);
      cur = up;
    }
  }
  // parents before children (stable)
  const ordered: Part[] = [];
  const placed = new Set<string>();
  const place = (p: Part) => {
    if (placed.has(p.id)) return;
    if (p.parent !== null) place(byId.get(p.parent)!);
    placed.add(p.id);
    ordered.push(p);
  };
  parts.forEach(place);
  parts = ordered;

  // bone budget after mirroring (a part below the root is doubled when it or an ancestor mirrors; the root is always one
  // bone), leaving one for the jaw the builder adds
  const doubled = (p: Part): boolean => p.parent !== null && (p.mirror || doubled(byId.get(p.parent)!));
  let bones = parts.reduce((n, p) => n + (doubled(p) ? 2 : 1), 0);
  while (bones > MAX_BONES - 1 && parts.length > 1) {
    // drop the last leaf (topological order makes the last part a leaf)
    const leaf = parts.pop()!;
    bones -= doubled(leaf) ? 2 : 1;
    fixes.push(`too many bones → dropped "${leaf.id}"`);
  }

  // ---- the fight plan: kept when its move is known; weapons must name parts ----
  let fight: FightPlan | null = null;
  if (raw.fight !== undefined && raw.fight !== null) {
    const f = isObj(raw.fight) ? raw.fight : {};
    if (!MOVES.includes(f.move as never)) {
      fixes.push(`fight move "${String(f.move)}" → no fight plan`);
    } else {
      const named = Array.isArray(f.weapons) ? f.weapons.filter((w): w is string => typeof w === 'string') : [];
      const partIds = new Set(parts.map((p) => p.id));
      const weapons = named.filter((w) => partIds.has(w));
      const dropped = named.filter((w) => !partIds.has(w));
      if (dropped.length) fixes.push(`fight weapons ${dropped.map((w) => `"${w}"`).join(', ')} name no part → dropped`);
      const words = (v: unknown, name: string) => {
        if (typeof v === 'string') return v;
        fixes.push(`fight ${name} missing → ""`);
        return '';
      };
      fight = { move: f.move as FightPlan['move'], weapons, weight: words(f.weight, 'weight'), intro: words(f.intro, 'intro') };
    }
  }

  // ---- the other sections ----
  const eyesIn = isObj(skinIn.eyes) ? skinIn.eyes : {};
  const d = DEFAULT_RECIPE;
  const m = section('motion');
  const l = section('life');
  const mi = section('mind');
  const se = isObj(mi.senses) ? mi.senses : {};
  const src = section('source');

  const litterMin = Math.round(num(l.litterMin, LIMITS.litter, 'life.litterMin', d.life.litterMin));
  const litterMax = Math.max(litterMin, Math.round(num(l.litterMax, LIMITS.litter, 'life.litterMax', d.life.litterMax)));
  const preyMin = num(mi.preyMin, LIMITS.prey, 'mind.preyMin', 0);
  const preyMax = Math.max(preyMin, num(mi.preyMax, LIMITS.prey, 'mind.preyMax', 0));
  const habitat = Array.isArray(mi.habitat) ? [...new Set(mi.habitat.filter((h) => HABITATS.includes(h as never)))] : [];
  if (habitat.length === 0) fixes.push('mind.habitat empty → ground');

  const body: Omit<Recipe, 'build' | 'face'> = {
    schemaVersion: SCHEMA_VERSION,
    id: str(raw.id, d.id),
    name: str(raw.name, d.name),
    seed: Math.round(num(raw.seed, LIMITS.seed, 'seed', d.seed)),
    source: {
      kind: pick(src.kind ?? d.source.kind, ['native', 'drawing', 'words', 'both'] as const, 'source.kind', 'words'),
      description: typeof src.description === 'string' ? src.description : '',
    },
    parts,
    skin: {
      regions,
      eyes: {
        color: eyesIn.color === undefined ? d.skin.eyes.color : color(eyesIn.color, 'eyes colour'),
        pupil: pick(eyesIn.pupil ?? d.skin.eyes.pupil, ['round', 'slit', 'bar', 'none'] as const, 'eyes pupil', 'round'),
        size: num(eyesIn.size, LIMITS.eyeSize, 'eyes size', d.skin.eyes.size),
      },
    },
    motion: {
      gait: pick(m.gait ?? d.motion.gait, GAITS, 'motion.gait', 'walk'),
      bounce: num(m.bounce, LIMITS.unit, 'motion.bounce', d.motion.bounce),
      sway: num(m.sway, LIMITS.unit, 'motion.sway', d.motion.sway),
      stance: pick(m.stance ?? d.motion.stance, ['low', 'normal', 'upright'] as const, 'motion.stance', 'normal'),
    },
    life: {
      sizeM: num(l.sizeM, LIMITS.sizeM, 'life.sizeM', d.life.sizeM),
      massKg: num(l.massKg, LIMITS.massKg, 'life.massKg', d.life.massKg),
      topSpeed: num(l.topSpeed, LIMITS.topSpeed, 'life.topSpeed', d.life.topSpeed),
      stamina: num(l.stamina, LIMITS.unit, 'life.stamina', d.life.stamina),
      lifespanDays: num(l.lifespanDays, LIMITS.lifespanDays, 'life.lifespanDays', d.life.lifespanDays),
      maturityDays: num(l.maturityDays, LIMITS.maturityDays, 'life.maturityDays', d.life.maturityDays),
      litterMin,
      litterMax,
      juvenileHead: num(l.juvenileHead, LIMITS.juvenileHead, 'life.juvenileHead', d.life.juvenileHead),
      juvenileFluff: num(l.juvenileFluff, LIMITS.unit, 'life.juvenileFluff', d.life.juvenileFluff),
    },
    mind: {
      plants: Array.isArray(mi.plants) ? mi.plants.filter((s): s is string => typeof s === 'string') : [...d.mind.plants],
      preyMin,
      preyMax,
      scavenger: bool(mi.scavenger, false),
      boldness: num(mi.boldness, LIMITS.unit, 'mind.boldness', d.mind.boldness),
      jumpiness: num(mi.jumpiness, LIMITS.unit, 'mind.jumpiness', d.mind.jumpiness),
      social: pick(mi.social ?? d.mind.social, SOCIAL, 'mind.social', 'solitary'),
      activity: pick(mi.activity ?? d.mind.activity, ACTIVITY, 'mind.activity', 'day'),
      habitat: habitat.length ? (habitat as Recipe['mind']['habitat']) : ['ground'],
      senses: {
        fov: num(se.fov, LIMITS.fov, 'senses.fov', d.mind.senses.fov),
        acuity: num(se.acuity, LIMITS.unit, 'senses.acuity', d.mind.senses.acuity),
        night: num(se.night, LIMITS.unit, 'senses.night', d.mind.senses.night),
        smell: num(se.smell, LIMITS.unit, 'senses.smell', d.mind.senses.smell),
        hearing: num(se.hearing, LIMITS.unit, 'senses.hearing', d.mind.senses.hearing),
        colour: pick(se.colour ?? d.mind.senses.colour, ['muted', 'normal', 'vivid'] as const, 'senses.colour', 'normal'),
      },
    },
    inheritance: (Array.isArray(raw.inheritance) ? raw.inheritance.filter(isObj) : d.inheritance)
      .filter((t) => typeof t.path === 'string')
      .map((t) => ({ path: t.path as string, spread: num(t.spread, LIMITS.spread, `inheritance ${String(t.path)}`, 0.05) })),
    fight,
  };

  // ---- build and face hints: whatever is missing is inferred from the body above ----
  const bi = isObj(raw.build) ? raw.build : null;
  const fi = isObj(raw.face) ? raw.face : null;
  if (!bi) fixes.push('build missing → inferred');
  if (!fi) fixes.push('face missing → inferred');
  const hb = inferBuild(body);
  const hf = inferFace(body);
  const build = bi
    ? { muscle: num(bi.muscle, LIMITS.muscle, 'build.muscle', hb.muscle), feet: pick(bi.feet, FEET, 'build.feet', hb.feet) }
    : hb;
  const face = fi
    ? {
        nose: pick(fi.nose, NOSES, 'face.nose', hf.nose),
        noseColor: colorOrNull(fi.noseColor, 'face.noseColor'),
        lids: bool(fi.lids, hf.lids),
        earInner: colorOrNull(fi.earInner, 'face.earInner'),
        brow: num(fi.brow, LIMITS.brow, 'face.brow', hf.brow),
      }
    : hf;
  const recipe: Recipe = { ...body, build, face };
  return { recipe, fixes };
}
