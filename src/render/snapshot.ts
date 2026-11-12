import { Color, DirectionalLight, HemisphereLight, PerspectiveCamera, Scene, Vector3, type Camera, type WebGPURenderer } from 'three/webgpu';
import type { BodyData } from '../builder/build';
import type { ImageIn, View } from '../designer/types';
import type { Recipe } from '../recipe/schema';
import { planFor } from '../fight/moves';
import { ragdollLayout } from '../physics/layout';
import { createFighterObject } from './fighter-object';

/** The canvas to borrow: its renderer and the stage it shows. */
export type SnapshotContext = { renderer: WebGPURenderer; scene: Scene; camera: Camera };

const FOV = 30;

/** Where the camera sits (unit direction from the creature) to match how a drawing shows it. */
export function viewDirection(view: View): Vector3 {
  // facing left in the picture = head (+z) on the left = camera on the creature's left (+x)
  const sideSign = view.facing === 'right' ? -1 : 1;
  switch (view.angle) {
    case 'side':
      return new Vector3(sideSign, 0.12, 0).normalize();
    case 'front':
      return new Vector3(0, 0.15, 1).normalize();
    case 'threeQuarter':
      return new Vector3(sideSign, 0.3, 1).normalize();
    case 'top':
      return new Vector3(0, 1, 0.02).normalize();
  }
}

/**
 * Photograph a creature in its rest pose on a plain background, framed to its size, from the
 * drawing's angle: the toon fighter (`createFighterObject`), as the ring shows it. Uses the main canvas for one
 * synchronous frame, then puts the stage back.
 */
export async function renderView(ctx: SnapshotContext, body: BodyData, recipe: Recipe, view: View, size = 768): Promise<ImageIn> {
  const { renderer } = ctx;
  const studio = new Scene();
  studio.background = new Color('#e9e6df');
  studio.add(new HemisphereLight('#ffffff', '#b8b0a0', 1.6));
  const key = new DirectionalLight('#ffffff', 2.2);
  key.position.set(2, 4, 3);
  studio.add(key, key.target);
  // the fighter as the ring shows it: toon colours, outline, googly eyes, at its ring size
  const layout = ragdollLayout(body.skeleton, planFor(recipe, body.skeleton));
  const creature = createFighterObject(body, recipe, layout);
  studio.add(creature.root);

  const { min, max } = body.skeleton, s = layout.scale;
  const center = new Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2).multiplyScalar(s);
  const radius = (new Vector3(max.x - min.x, max.y - min.y, max.z - min.z).length() / 2) * s;
  const camera = new PerspectiveCamera(FOV, 1, radius * 0.05, radius * 20);
  const dist = (radius / Math.sin(((FOV / 2) * Math.PI) / 180)) * 1.05;
  camera.position.copy(center).addScaledVector(viewDirection(view), dist);
  camera.lookAt(center);

  await renderer.compileAsync(studio, camera);
  const canvas = renderer.domElement;
  const prev = { w: canvas.width, h: canvas.height, ratio: renderer.getPixelRatio() };
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  renderer.render(studio, camera);
  const url = canvas.toDataURL('image/png'); // same task as the render
  if (prev.w > 0 && prev.h > 0) {
    renderer.setSize(prev.w / prev.ratio, prev.h / prev.ratio, false);
    renderer.setPixelRatio(prev.ratio);
    renderer.render(ctx.scene, ctx.camera); // put the stage back before the browser shows a frame
  }
  creature.dispose();
  return { base64: url.replace(/^data:image\/png;base64,/, ''), mediaType: 'image/png' };
}
