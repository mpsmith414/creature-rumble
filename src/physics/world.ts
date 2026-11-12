import RAPIER from '@dimforge/rapier3d-compat';

let ready: Promise<void> | null = null;

/** Loads Rapier's WebAssembly once; every later call shares the same promise. */
export function initPhysics(): Promise<void> {
  return (ready ??= RAPIER.init());
}

/** A physics world pulling down with `gravity` (m/s²), stepping 1/60 s at a time. Call `initPhysics()` first. */
export function createWorld(gravity: number): RAPIER.World {
  const w = new RAPIER.World({ x: 0, y: -gravity, z: 0 });
  w.timestep = 1 / 60;
  return w;
}
