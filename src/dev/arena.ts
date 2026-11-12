// Dev only (`/?dev=arena`): the candy ring arena with the seven fixture fighters standing in it (for scale), the bridge
// up and the entrance spotlight on, to check the look by eye. `&shot=1` saves the first full frame as .shots/arena.png
// (the dev server's /__shot); `&fighters=0` leaves the ring empty. The camera then orbits slowly.
import { PerspectiveCamera, Scene, Vector3 as V3 } from 'three/webgpu';
import { createArena, SPOT_ON } from '../arena/arena';
import { BuilderClient } from '../builder/client';
import { planFor } from '../fight/moves';
import { TUNE } from '../fight/tune';
import { ragdollLayout } from '../physics/layout';
import { Ragdoll } from '../physics/ragdoll';
import { createWorld, initPhysics } from '../physics/world';
import { driveBones } from '../render/drive';
import { createFighterObject } from '../render/fighter-object';
import { createRenderer } from '../render/renderer';
import { fixtures } from './pose';

const ORBIT = 0.4, DIST = 14, HIGH = 8.5;

export async function showArena(canvas: HTMLCanvasElement, opts: { shot: boolean; fighters: boolean }): Promise<void> {
  const [{ renderer }] = await Promise.all([createRenderer(canvas, 'high'), initPhysics()]);
  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 1, 0.1, 300);
  const fit = () => {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    camera.aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', fit);
  fit();

  const world = createWorld(TUNE.gravity);
  const arena = createArena(scene, world, TUNE);
  arena.bridge.show(true);
  arena.update(5); // all the way up
  const look = new V3(0, 0.5, 0);
  const place = (orbit: number) => {
    camera.position.set(Math.sin(orbit) * DIST, HIGH, Math.cos(orbit) * DIST);
    camera.lookAt(look);
  };
  place(ORBIT);

  if (opts.fighters) {
    try {
      const recipes = fixtures().slice(0, 7);
      const builder = new BuilderClient();
      const bodies = await Promise.all(recipes.map((r) => builder.build(r)));
      bodies.forEach((body, i) => {
        const layout = ragdollLayout(body.skeleton, planFor(recipes[i], body.skeleton));
        const a = (i / bodies.length) * Math.PI * 2 + 0.3, at = new V3(Math.cos(a) * 3.4, 0, Math.sin(a) * 3.4);
        const rag = new Ragdoll(world, layout, { bounce: TUNE.bounce });
        rag.pose(at, Math.atan2(camera.position.x - at.x, camera.position.z - at.z)); // facing the camera, no physics step
        const obj = createFighterObject(body, recipes[i], layout);
        scene.add(obj.root);
        driveBones(obj, rag);
      });
      // the spotlight on the first one, as an entrance would
      const first = new V3(Math.cos(0.3) * 3.4, 0, Math.sin(0.3) * 3.4);
      arena.spot.intensity = SPOT_ON;
      arena.spot.target.position.copy(first);
      arena.spot.position.copy(first).setY(12);
    } catch (e) {
      console.warn('arena dev page: no fighters', e);
    }
  }

  await renderer.compileAsync(scene, camera);
  renderer.render(scene, camera);
  if (opts.shot) {
    const url = canvas.toDataURL('image/png'); // the same task as the render
    await fetch('/__shot?name=arena', { method: 'POST', body: url });
    console.info('saved .shots/arena.png');
  }
  let orbit = ORBIT, last = performance.now();
  renderer.setAnimationLoop((now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    orbit += dt * 0.06;
    place(orbit);
    arena.update(dt);
    renderer.render(scene, camera);
  });
  Object.assign(window, { __arena: { scene, camera, renderer, world, arena } });
}
