export const MAX_IN_RING = 8;
export const ENTRANCE_S = 8.5;
export const GROUP_ENTRANCE_S = 5;
export const SHARE_WINDOW_S = 1.5;

export type MatchEvent =
  | { type: 'entranceStart'; ids: string[]; group: boolean }
  | { type: 'entranceEnd'; ids: string[] }
  | { type: 'ringOut'; ids: string[] }
  | { type: 'holdsRing'; id: string }
  | { type: 'lone'; id: string }
  | { type: 'tie'; ids: string[] }
  | { type: 'crowned'; id: string; others: string[] }
  | { type: 'again'; ids: string[] };

/** True when a fighter is no longer in play: broken numbers, fallen below the floor, or far outside the ring. */
export function isOut(p: { x: number; y: number; z: number }, ringRadius: number): boolean {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return true;
  if (p.y < -2.5) return true;
  return Math.hypot(p.x, p.z) > ringRadius + 4;
}
