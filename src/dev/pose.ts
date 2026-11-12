// Dev only (`/?dev=pose`): every fighter fixture standing in a row under toon lighting, to check the cartoon look by eye.
// `&shot=1` saves the first full frame as .shots/fighters.png (the dev server's /__shot).
import {
  CircleGeometry, Color, DirectionalLight, HemisphereLight, Mesh, MeshToonNodeMaterial, PerspectiveCamera, Scene, Vector3 as V3,
} from 'three/webgpu';
import { BuilderClient } from '../builder/client';
import { planFor } from '../fight/moves';
import { ragdollLayout } from '../physics/layout';
import { Ragdoll } from '../physics/ragdoll';
import { createWorld, initPhysics } from '../physics/world';
import type { Recipe } from '../recipe/schema';
import { driveBones } from '../render/drive';
import { createFighterObject } from '../render/fighter-object';
import { createRenderer } from '../render/renderer';
import { toonGradient } from '../render/toon';

/** The seven kinds in the spec's order, then any other fixture (a live sample, when one was saved). */
const ORDER = ['fists', 'legs', 'tiny', 'blob', 'wings', 'tail', 'horns'];
const GAP = 0.5;

/** Every fighter fixture as a recipe: the seven kinds in order, then the rest by name. */
export function fixtures(): Recipe[] {
  const all = import.meta.glob<{ default: unknown }>('../fixtures/fighters/*.json', { eager: true });
  const named = Object.entries(all).map(([path, m]) => ({ name: path.replace(/^.*\/|\.json$/g, ''), recipe: structuredClone(m.default) as Recipe }));
  const rank = (n: string) => (ORDER.includes(n) ? ORDER.indexOf(n) : ORDER.length);
  return named.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name)).map((x) => x.recipe);
}

export async function showPoses(canvas: HTMLCanvasElement, opts: { shot: boolean }): Promise<void> {
  const [{ renderer }] = await Promise.all([createRenderer(canvas, 'high'), initPhysics()]);
  const fit = () => {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    camera.aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    camera.updateProjectionMatrix();
  };
  const scene = new Scene();
  scene.background = new Color('#7fd8ff');
  scene.add(new HemisphereLight('#fff0ff', '#6040a0', 1.6));
  const sun = new DirectionalLight('#ffffff', 2.2);
  sun.position.set(6, 14, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 40 });
  scene.add(sun, sun.target);
  const floorMat = new MeshToonNodeMaterial({ color: new Color('#ffe3f0') });
  floorMat.gradientMap = toonGradient();
  const floor = new Mesh(new CircleGeometry(30, 48), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const camera = new PerspectiveCamera(30, 1, 0.1, 200);
  addEventListener('resize', fit);
  fit();

  const recipes = fixtures();
  const builder = new BuilderClient();
  const bodies = await Promise.all(recipes.map((r) => builder.build(r)));
  const world = createWorld(20);
  const row = bodies.map((body, i) => {
    const sk = body.skeleton;
    const layout = ragdollLayout(sk, planFor(recipes[i], sk));
    return { body, recipe: recipes[i], layout, width: (sk.max.x - sk.min.x) * layout.scale, height: layout.ringHeight };
  });
  const total = row.reduce((t, f) => t + f.width, 0) + GAP * (row.length - 1);
  let x = -total / 2;
  for (const f of row) {
    const rag = new Ragdoll(world, f.layout, { bounce: 0.35 });
    rag.pose(new V3(x + f.width / 2, 0, 0), 0); // standing at rest, facing the camera (no physics step)
    const obj = createFighterObject(f.body, f.recipe, f.layout);
    scene.add(obj.root);
    driveBones(obj, rag);
    x += f.width + GAP;
  }
  const tall = Math.max(...row.map((f) => f.height));
  const look = new V3(0, tall * 0.45, 0);
  const halfW = total / 2 + 0.6, fov = (camera.fov * Math.PI) / 180;
  const dist = Math.max(halfW / (Math.tan(fov / 2) * camera.aspect), (tall * 0.75) / Math.tan(fov / 2));
  camera.position.set(0, tall * 0.9, dist);
  camera.lookAt(look);

  await renderer.compileAsync(scene, camera);
  renderer.render(scene, camera);
  if (opts.shot) {
    const url = canvas.toDataURL('image/png'); // the same task as the render
    await fetch('/__shot?name=fighters', { method: 'POST', body: url });
    console.info('saved .shots/fighters.png');
  }
  renderer.setAnimationLoop(() => renderer.render(scene, camera));
  Object.assign(window, { __pose: { scene, camera, renderer, world } });
}
