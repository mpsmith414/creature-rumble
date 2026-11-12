import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * The race-ready split (spec §6.4): the TV's mode-neutral core — main.ts and core.ts and everything they reach — never
 * imports the Rumble's own pieces (its match rules, its arena, its entrances). Only the mode (rumble.ts) and the dev pages
 * may, so the Super Race can later start on the same core.
 */
const CORE = ['src/app/main.ts', 'src/app/core.ts'];
/** Where the walk stops: the Rumble mode itself and the dev-only pages. */
const MODE = ['src/app/rumble.ts', 'src/app/dev.ts', 'src/dev/'];
const FORBIDDEN = ['src/match/', 'src/arena/', 'src/show/entrance.ts', 'src/fight/'];
/**
 * The fight files the shared core may reach, each for a reason that is not the Rumble's rules:
 * tune.ts (gravity for the world), scale.ts (a creature's ring size: the ragdoll layout uses it, Ruling R2),
 * types.ts (the fight plan's type, which is part of the recipe and re-exported from src/recipe/schema.ts) and
 * moves.ts (`planFor`: the ragdoll layout needs a plan, and the studio's snapshot lays the fighter out from it).
 * The fight brain, fighter, muscles and simulation (brain.ts, fighter.ts, muscles.ts, sim.ts) stay out.
 */
const ALLOWED = ['src/fight/tune.ts', 'src/fight/scale.ts', 'src/fight/types.ts', 'src/fight/moves.ts'];

/** Every module specifier a file imports or re-exports (static, dynamic, `import type` included). */
function specifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm))
    out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** A relative specifier as a repo path to a .ts file (null for css, json, packages). */
function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = relative('.', join(dirname(from), spec)).replaceAll('\\', '/');
  for (const p of [base, `${base}.ts`, `${base}/index.ts`]) if (/\.ts$/.test(p) && existsSync(p)) return p;
  return null;
}

/** The core's whole import graph, stopping at the mode: each file with the files it reaches it from. */
function walk(roots: string[]): Map<string, string> {
  const seen = new Map<string, string>(roots.map((r) => [r, '(root)']));
  const todo = [...roots];
  while (todo.length) {
    const f = todo.pop()!;
    for (const s of specifiers(readFileSync(f, 'utf8'))) {
      const to = resolve(f, s);
      if (!to || seen.has(to)) continue;
      seen.set(to, f);
      if (!MODE.some((m) => to === m || (m.endsWith('/') && to.startsWith(m)))) todo.push(to);
    }
  }
  return seen;
}

const forbidden = (f: string) => !ALLOWED.includes(f) && FORBIDDEN.some((x) => (x.endsWith('/') ? f.startsWith(x) : f === x));

describe('the core stays mode-neutral (spec §6.4)', () => {
  test('nothing the core reaches imports src/match, src/arena, src/show/entrance.ts or the fight brain', () => {
    const graph = walk(CORE);
    expect(graph.size).toBeGreaterThan(20);
    expect(graph.has('src/app/rumble.ts')).toBe(true); // the mode is reached, and the walk stops there
    const bad = [...graph].filter(([f]) => forbidden(f)).map(([f, by]) => `${by} → ${f}`);
    expect(bad).toEqual([]);
  });

  test('the check would catch it: the Rumble mode does reach them', () => {
    const graph = walk(['src/app/rumble.ts']);
    for (const f of ['src/match/match.ts', 'src/arena/arena.ts', 'src/show/entrance.ts', 'src/fight/fighter.ts']) expect(graph.has(f)).toBe(true);
  });
});
