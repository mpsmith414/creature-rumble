import { DEFAULT_RECIPE, defaultFlatFacing } from '../../../src/recipe/normalize';
import { inferBuild, inferCoat, inferFace } from '../../../src/recipe/hints';
import { SCHEMA_VERSION, type Build, type Face, type Part, type Recipe, type Region, type Role } from '../../../src/recipe/schema';

type V = [number, number, number];
type PartOpts = Partial<Pick<Part, 'squash' | 'pointed' | 'mirror' | 'region' | 'flatFacing'>> & { at?: number; offset?: V };

/** Compact part maker for hand-written recipes: part(id, parent, role, dir, length, r0, r1, options). */
export function part(id: string, parent: string | null, role: Role, dir: V, length: number, r0: number, r1: number, o: PartOpts = {}): Part {
  const l = Math.hypot(...dir);
  const [ox, oy, oz] = o.offset ?? [0, 0, 0];
  return {
    id, parent, role,
    attach: o.at ?? 1,
    offset: { x: ox, y: oy, z: oz },
    dir: { x: dir[0] / l, y: dir[1] / l, z: dir[2] / l },
    length, r0, r1,
    squash: o.squash ?? 1,
    flatFacing: o.flatFacing ?? defaultFlatFacing(role),
    pointed: o.pointed ?? false,
    mirror: o.mirror ?? false,
    region: o.region ?? 'body',
  };
}

/** A skin region; the coat is inferred from the covering, length and fluff unless given. */
export function region(id: string, covering: Region['covering'], color: string, o: Partial<Omit<Region, 'id' | 'covering' | 'color'>> = {}): Region {
  const furLength = o.furLength ?? 0, fluff = o.fluff ?? 0;
  return { id, covering, color, belly: o.belly ?? null, furLength, fluff, coat: o.coat === undefined ? inferCoat({ covering, furLength, fluff }) : o.coat, pattern: o.pattern ?? null };
}

type RecipeParts = Pick<Recipe, 'id' | 'name' | 'parts' | 'skin'> & {
  motion?: Partial<Recipe['motion']>;
  life?: Partial<Recipe['life']>;
  mind?: Partial<Omit<Recipe['mind'], 'senses'>> & { senses?: Partial<Recipe['mind']['senses']> };
  inheritance?: Recipe['inheritance'];
  seed?: number;
  build?: Partial<Build>;
  face?: Partial<Face>;
};

/** A complete native recipe: anything not given comes from the defaults (build and face hints from the body). */
export function native(r: RecipeParts): Recipe {
  const d = DEFAULT_RECIPE;
  const motion = { ...d.motion, ...r.motion };
  const life = { ...d.life, ...r.life };
  const mind = { ...d.mind, ...r.mind, senses: { ...d.mind.senses, ...r.mind?.senses } };
  const hint = { parts: r.parts, skin: r.skin, motion, mind, life };
  return {
    schemaVersion: SCHEMA_VERSION,
    id: r.id,
    name: r.name,
    seed: r.seed ?? 1,
    source: { kind: 'native', description: '' },
    parts: r.parts,
    skin: r.skin,
    build: { ...inferBuild(hint), ...r.build },
    face: { ...inferFace(hint), ...r.face },
    motion,
    life,
    mind,
    inheritance: r.inheritance ?? [{ path: 'life.sizeM', spread: 0.06 }, { path: 'life.topSpeed', spread: 0.05 }],
    fight: null,
  };
}
