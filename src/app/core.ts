import type RAPIER from '@dimforge/rapier3d-compat';
import type { PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import type { Announcer } from '../announcer/announcer';
import type { Crowd } from '../audio/crowd';
import type { Mixer } from '../audio/mixer';
import type { Sfx } from '../audio/sfx';
import type { Bring } from '../bring/bring';
import type { Workshop } from '../bring/workshop';
import type { BodyData } from '../builder/build';
import type { Recipe } from '../recipe/schema';
import type { Banner } from '../show/banner';
import type { Capsule } from '../show/capsule';
import type { Pops } from '../show/pops';
import type { RosterLike } from './wiring';

/**
 * The mode-neutral core (spec §6.4): what every mode (the Rumble now, the Super Race later) shares — the renderer and
 * the 3D stage, the physics world, sound and the announcer, the roster, the phones and the workshop that makes
 * creatures, and the words on screen. A mode (`startRumble`) adds its own arena, rules and show on top. Nothing here
 * may import from src/match, src/arena or src/show/entrance.ts (tests/app/boundary.test.ts).
 */
export type Core = {
  renderer: WebGPURenderer; scene: Scene; camera: PerspectiveCamera; world: RAPIER.World;
  mixer: Mixer; sfx: Sfx; crowd: Crowd; announcer: Announcer;
  roster: RosterLike; bring: Bring; workshop: Workshop;
  banner: Banner; pops: Pops;
  /** The page's overlay (banners, menus, the join card). */
  ui: HTMLElement;
  /** The body builder (workers + cache): a roster creature with no cached body is built again. */
  build(recipe: Recipe): Promise<BodyData>;
  /** The "coming soon" capsule the workshop shows while a phone is making a creature. */
  capsule: Capsule;
  /** Whether the browser lets sound play yet (it needs a key, a remote press or a click first). */
  audio: { live(): boolean };
};
