/** JSON with object keys sorted, so equal values always print the same. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (ArrayBuffer.isView(v)) return stableStringify(Array.from(v as unknown as ArrayLike<number>));
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

/** FNV-1a (32-bit) of a string, as 8 hex digits. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const hash = (v: unknown) => fnv1a(stableStringify(v));

/** Fast hash of raw numbers (e.g. mesh positions) without building a string. */
export function hashNumbers(a: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  for (let i = 0; i < a.length; i++) {
    f[0] = a[i];
    h ^= u[0];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
