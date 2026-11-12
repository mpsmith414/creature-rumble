/**
 * Dev-mode checks on the three.js internals the app leans on (written against r186). `probe(ok, what)` warns once per
 * `what` when `ok` is false, so an upgrade that moves one shows up in the console instead of as a quiet slowdown or a
 * wrong picture. Production builds skip the warning. Returns `ok`.
 */
const warned = new Set<string>();
export function probe(ok: boolean, what: string): boolean {
  if (!ok && import.meta.env.DEV && !warned.has(what)) {
    warned.add(what);
    console.warn(`three workaround: ${what}. Check it against the installed three (written for r186).`);
  }
  return ok;
}
