import type RAPIER from '@dimforge/rapier3d-compat';
import {
  BoxGeometry, CanvasTexture, CircleGeometry, Color, CylinderGeometry, DirectionalLight, HemisphereLight, InstancedMesh, Matrix4, Mesh,
  MeshToonNodeMaterial, type Scene, SphereGeometry, SpotLight, SRGBColorSpace, TorusGeometry, type Vector3,
} from 'three/webgpu';
import { color, mix, screenUV, vec2 } from 'three/tsl';
import type { Tune } from '../fight/tune';
import { toonGradient } from '../render/toon';
import { mulberry32 } from '../util/rng';
import { addArenaColliders } from './colliders';
import {
  BRIDGE_LEN, BUMPER_TUBE, bridgeStep, bridgeY, bumperScale, ENTRY_ANGLE, entryDir, postAngles,
} from './geometry';

export type Arena = {
  /** Where entrances come in: the angle round the ring and the flat unit direction from the centre out to it. */
  entry: { angle: number; dir: Vector3 };
  /** The entrance bridge: `show(true)` raises it, `show(false)` drops it out of sight. `update` eases it (Arena.update calls it). */
  bridge: { show(on: boolean): void; update(dt: number): void };
  /** The entrance spotlight: off (intensity 0) until an entrance turns it on (`SPOT_ON`); its target is in the scene. */
  spot: SpotLight;
  /** Once a frame: eases the bridge and follows a live change of `tune.bumper`. Allocates nothing. */
  update(dt: number): void;
};

/** The ball pit's floor, far below the ring: anyone knocked out lands here. */
export const PIT_Y = -12;
/** The entrance spotlight's intensity when it is on (the spike's). */
export const SPOT_ON = 600;

const PIT_BALLS = 900;
const PIT_COLOURS = [0xff4f8b, 0x3ec7ff, 0x7dff5a, 0xffc933, 0xb26bff, 0xff7a2f];
/** The bridge only shows once it is this far up (progress), so a lowered one costs nothing. */
const BRIDGE_SHOWS = 0.01;

/** A flat-coloured toon material in the fighters' three bands. */
function toon(hex: number): MeshToonNodeMaterial {
  const m = new MeshToonNodeMaterial({ color: hex });
  m.gradientMap = toonGradient();
  return m;
}

/** The candy-striped ring top: rings of pink, cream, sky blue and lemon round a gold star (the spike's, at 2× size). */
function ringTexture(): CanvasTexture {
  const S = 1024, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const bands = ['#ff7ab8', '#ffe3f0', '#7fd8ff', '#ffe3f0', '#ff7ab8', '#fff4a8'];
  for (let i = 0; i < 12; i++) {
    g.fillStyle = bands[i % bands.length];
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2 - i * 42, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = '#ffd23f';
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2, r = i % 2 ? 44 : 100;
    g.lineTo(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r);
  }
  g.fill();
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * The spike's bright backdrop (a CSS radial gradient there): pink round a point 30% down the screen, through purple, to
 * deep indigo at the corners. Drawn by the GPU behind everything, so it costs one full-screen pass and no geometry.
 */
function backdrop() {
  const t = screenUV.sub(vec2(0.5, 0.3)).div(vec2(0.5, 0.7)).length().div(Math.SQRT2);
  const inner = mix(color(0xff9ad5), color(0xa35cff), t.div(0.45).clamp(0, 1));
  return mix(inner, color(0x2b1460), t.sub(0.45).div(0.55).clamp(0, 1));
}

/**
 * The candy ring: the spike's arena rebuilt with node materials. Adds the ring's colliders to `world`
 * (`addArenaColliders`) and its look, lights and backdrop to `scene`. Reads `tune.bumper` live; the ring's radius is
 * fixed at creation. Do not also call `addArenaColliders` on the same world — the ring would be doubled.
 */
export function createArena(scene: Scene, world: RAPIER.World, tune: Tune): Arena {
  const R = tune.ringRadius;
  const colliders = addArenaColliders(world, tune);
  const angle = ENTRY_ANGLE, dir = entryDir(angle);

  // ---- backdrop and lights ----
  scene.backgroundNode = backdrop();
  scene.add(new HemisphereLight(0xfff0ff, 0x6040a0, 1.6));
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(6, 14, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 40 });
  scene.add(sun, sun.target);
  // kept in the scene at intensity 0 (not hidden), so turning it on never changes the lighting's shader
  const spot = new SpotLight(0xfff6c0, 0, 30, 0.35, 0.5);
  spot.position.set(0, 14, 0);
  scene.add(spot, spot.target);

  // ---- the ring: striped top, purple skirt, padded white bumper ----
  const top = new Mesh(new CircleGeometry(R, 64), new MeshToonNodeMaterial({ map: ringTexture() }));
  (top.material as MeshToonNodeMaterial).gradientMap = toonGradient();
  top.rotation.x = -Math.PI / 2;
  top.position.y = 0.001;
  top.receiveShadow = true;
  const skirt = new Mesh(new CylinderGeometry(R, R * 0.92, 1.4, 64, 1, true), toon(0x8a4dff));
  skirt.position.y = -0.7;
  const bumper = new Mesh(new TorusGeometry(R + 0.15, BUMPER_TUBE, 12, 96), toon(0xffffff));
  bumper.rotation.x = Math.PI / 2; // its local z is now up: scaling z sets the height
  bumper.castShadow = bumper.receiveShadow = true;
  scene.add(top, skirt, bumper);
  let shownBumper = NaN;
  const setBumper = (h: number) => {
    if (h !== shownBumper && !Number.isNaN(shownBumper)) colliders.rebuildBumper(h); // the first height is already built
    shownBumper = h;
    bumper.visible = h > 0;
    bumper.scale.set(1, 1, bumperScale(h));
    bumper.position.y = h / 2; // spans 0 … h, like the colliders
  };
  setBumper(tune.bumper);

  // ---- posts: one shared geometry and material per part, gaps at the entry ----
  const postGeo = new CylinderGeometry(0.16, 0.2, 2.2, 12), knobGeo = new SphereGeometry(0.3, 14, 10);
  const postMats = [toon(0x3ec7ff), toon(0xffc933)], knobMat = toon(0xff4f8b);
  postAngles(angle).forEach((a, i) => {
    const post = new Mesh(postGeo, postMats[i % 2]);
    post.position.set(Math.cos(a) * (R + 0.6), -0.2, Math.sin(a) * (R + 0.6));
    post.castShadow = true;
    const knob = new Mesh(knobGeo, knobMat);
    knob.position.y = 1.2;
    knob.castShadow = true;
    post.add(knob);
    scene.add(post);
  });

  // ---- ball pit far below: one floor, ~900 balls in one draw call ----
  const pitFloor = new Mesh(new CircleGeometry(60, 48), toon(0x5b2fb0));
  pitFloor.rotation.x = -Math.PI / 2;
  pitFloor.position.y = PIT_Y;
  const balls = new InstancedMesh(new SphereGeometry(0.5, 10, 8), toon(0xffffff), PIT_BALLS);
  {
    const rng = mulberry32(0x5eed), m = new Matrix4(), c = new Color();
    for (let i = 0; i < PIT_BALLS; i++) {
      const a = rng() * Math.PI * 2, d = 2 + Math.sqrt(rng()) * 30;
      m.setPosition(Math.cos(a) * d, PIT_Y + 0.3 + rng() * 0.6, Math.sin(a) * d);
      balls.setMatrixAt(i, m);
      balls.setColorAt(i, c.setHex(PIT_COLOURS[i % PIT_COLOURS.length]));
    }
    balls.computeBoundingSphere();
  }
  scene.add(pitFloor, balls);

  // ---- entrance bridge: rises out of the pit to the ring's edge for walk-ins, drops away after ----
  const deck = new Mesh(new BoxGeometry(BRIDGE_LEN, 0.4, 2.2), toon(0xffe14d));
  deck.position.copy(dir).multiplyScalar(R + BRIDGE_LEN / 2 - 0.3);
  deck.rotation.y = -angle; // its long side (local x) along `dir`
  deck.castShadow = deck.receiveShadow = true;
  scene.add(deck);
  let raise = 0, wantUp = false;
  const placeBridge = () => {
    deck.position.y = bridgeY(raise);
    deck.visible = raise > BRIDGE_SHOWS;
  };
  placeBridge();
  const bridge = {
    show(on: boolean) { wantUp = on; },
    update(dt: number) {
      const next = bridgeStep(raise, wantUp, dt);
      if (next === raise) return;
      raise = next;
      placeBridge();
    },
  };

  return {
    entry: { angle, dir },
    bridge,
    spot,
    update(dt: number) {
      bridge.update(dt);
      if (tune.bumper !== shownBumper) setBumper(tune.bumper);
    },
  };
}
