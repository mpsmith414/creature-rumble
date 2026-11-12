import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The folders the body cache's key hashes (vite.config.ts builderHash): code the builder runs must all live in them. */
const HASHED = ['src/builder', 'src/recipe', 'src/util'];
/** npm packages the builder may use (their versions are pinned by the lock file, not the hash). */
const PACKAGES = new Set(['idb', 'zod']);

/** Every module specifier a file imports or re-exports (static, dynamic, `import type` included). */
function specifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm))
    out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

describe('the builder imports only what the body cache key covers', () => {
  it('finds static, dynamic, side-effect and re-export imports, multi-line ones too', () => {
    expect(specifiers(`import { a,\n  b } from './x';\nimport type { T } from "../y";\nexport { c } from './z';\nconst w = await import('./w');\nimport 'side';`))
      .toEqual(['./x', '../y', './z', './w', 'side']);
  });

  it('every import in src/builder, src/recipe and src/util stays in those folders, or is idb or zod', () => {
    const files = HASHED.flatMap((d) => readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /\.ts$/.test(e.name)).map((e) => join(e.parentPath, e.name)));
    expect(files.length).toBeGreaterThan(20);
    const outside: string[] = [];
    for (const f of files)
      for (const s of specifiers(readFileSync(f, 'utf8'))) {
        if (!s.startsWith('.')) {
          if (!PACKAGES.has(s)) outside.push(`${f}: ${s}`);
          continue;
        }
        const to = relative('.', join(dirname(f), s)).replaceAll('\\', '/');
        if (!HASHED.some((d) => to === d || to.startsWith(`${d}/`))) outside.push(`${f}: ${s}`);
      }
    expect(outside).toEqual([]);
  });
});
