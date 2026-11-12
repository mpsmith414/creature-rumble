import type { BufferGeometry, Camera, Material, Object3D } from 'three/webgpu';

/** The part of the renderer `compileTogether` uses. */
export type Compiler = { compileAsync(object: Object3D, camera: Camera, scene?: Object3D | null): Promise<void> };

type Drawable = Object3D & { material?: Material | Material[]; geometry?: BufferGeometry };

/** What makes a pipeline differ, roughly: the material, the kind of object and the geometry's attributes. */
const pipelineKey = (o: Drawable, m: Material) =>
  `${m.uuid}|${o.type}|${o.geometry ? Object.keys(o.geometry.attributes).sort().join() + (o.geometry.index ? '|i' : '') : ''}`;

/**
 * Compile everything in `root` that `camera` can see now, with the GPU compiling the pipelines side by side.
 *
 * Why: three's `compileAsync` (r186) builds and compiles one pipeline at a time, waiting for each, and on D3D12 one
 * pipeline takes 0.05 to 2.3 s (measured in the Valley: the ground, water and plant pipelines took 9 s one after another).
 * Here one `compileAsync` per distinct pipeline (one object per material, object type and geometry layout) runs at once, so
 * their node builds and GPU compiles overlap, plus one over the whole of `root` as a safety net (almost all cache hits).
 *
 * Every call gathers what it will compile before its first `await` (three r186), so this has gathered everything by the
 * time it returns its promise: a caller may undo temporary visibility at once (see `VegetationTiles.compile`). Check both
 * on a three upgrade.
 */
export function compileTogether(renderer: Compiler, root: Object3D, camera: Camera, scene: Object3D = root): Promise<void> {
  const firsts = new Map<string, Object3D>();
  root.traverseVisible((o: Drawable) => {
    if (!o.material || !o.layers.test(camera.layers)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      const k = pipelineKey(o, m);
      if (!firsts.has(k)) firsts.set(k, o);
    }
  });
  const calls = [...new Set(firsts.values())].map((o) => renderer.compileAsync(o, camera, scene));
  calls.push(renderer.compileAsync(root, camera, scene));
  return Promise.all(calls).then(() => {});
}
