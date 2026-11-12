/** Settings remembered per browser (localStorage), shared by the lab and the valley. */

/** Read a remembered value, or the fallback when there is none (or storage is unavailable). */
export const stored = <T>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
};

/** Remember a value for next time. */
export const remember = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode: settings just won't stick */
  }
};
