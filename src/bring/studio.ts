import { PerspectiveCamera, Scene, type WebGPURenderer } from 'three/webgpu';
import type { BodyData } from '../builder/build';
import type { ImageIn, View } from '../designer/types';
import type { Recipe } from '../recipe/schema';
import type { Tier } from '../render/quality';
import { createRenderer } from '../render/renderer';
import { renderView } from '../render/snapshot';

/**
 * The workshop's studio: a small renderer of its own on its own canvas, so the TV's frame and canvas are never touched.
 * It only takes pictures (a creature at rest, for the designer's look-again passes and for thumbnails): the TV shows no
 * turntable, so `show`, `turn` and `render` do nothing.
 */
export type Studio = {
  canvas: HTMLCanvasElement;
  /** The renderer is up (made during the designer's read). */
  ready: Promise<void>;
  /** Nothing: the TV shows no turntable. */
  show(body: BodyData, recipe: Recipe): Promise<void>;
  /** Nothing (no turntable to turn). */
  turn(dt: number): void;
  /** Nothing (the studio draws only its pictures). */
  render(): void;
  /**
   * A picture of a body in its rest pose for the designer or a thumbnail, with the studio's renderer (`renderView`): the
   * toon fighter as the ring shows it (outline, googly eyes, ring size).
   */
  snapshot(body: BodyData, recipe: Recipe, view: View, size?: number): Promise<ImageIn>;
  dispose(): void;
};

export function createStudio(parent: HTMLElement, tier: Tier): Studio {
  const canvas = document.createElement('canvas');
  canvas.className = 'ws-canvas';
  parent.prepend(canvas);
  // what the canvas shows between pictures: nothing (`renderView` draws it again after each picture)
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  let renderer: WebGPURenderer | null = null;
  let disposed = false;

  // the renderer (a second GPU device): made while the designer reads the drawing
  const ready = (async () => {
    const r = (await createRenderer(canvas, tier)).renderer;
    r.onDeviceLost = (info) => {
      if (!disposed) console.warn('the studio lost its GPU device', info.message);
    };
    if (disposed) return void r.dispose();
    renderer = r;
  })();

  return {
    canvas, ready,
    show: () => Promise.resolve(),
    turn() {},
    render() {},
    async snapshot(body, recipe, view, px) {
      await ready;
      if (disposed || !renderer) throw new Error('the studio has closed');
      return renderView({ renderer, scene, camera }, body, recipe, view, px);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      void renderer?.dispose(); // destroys its GPU device
      canvas.remove();
    },
  };
}
