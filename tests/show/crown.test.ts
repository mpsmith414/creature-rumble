import { Scene, Vector3 } from 'three/webgpu';
import { beforeAll, expect, test } from 'vitest';
import { addArenaColliders } from '../../src/arena/colliders';
import { buildBody } from '../../src/builder/build';
import { Fighter, type FightCtx } from '../../src/fight/fighter';
import { planFor } from '../../src/fight/moves';
import { TUNE } from '../../src/fight/tune';
import { ragdollLayout } from '../../src/physics/layout';
import { createWorld, initPhysics } from '../../src/physics/world';
import { driveBones } from '../../src/render/drive';
import { createFighterObject } from '../../src/render/fighter-object';
import { Finale } from '../../src/show/finale';
import { mulberry32 } from '../../src/util/rng';
import { KINDS, loadFixture } from '../fixtures/fighters';

beforeAll(initPhysics);

const DT = 1 / 60;

test.each(KINDS)('%s: after strutting as champion, the crown is on top of its head, above its eyes', (k) => {
  const recipe = loadFixture(k);
  const body = buildBody(recipe, [2]);
  const plan = planFor(recipe, body.skeleton);
  const layout = ragdollLayout(body.skeleton, plan);
  const world = createWorld(TUNE.gravity);
  addArenaColliders(world, TUNE);
  const f = new Fighter(k, world, layout, plan, { tune: TUNE, rng: mulberry32(1) });
  f.ragdoll.pose(new Vector3(1, 0, 1), 0.7);
  f.state = 'fighting';
  const obj = createFighterObject(body, recipe, layout);
  const scene = new Scene();
  scene.add(obj.root);
  const finale = new Finale(scene, { ringRadius: TUNE.ringRadius, rng: mulberry32(2) });
  finale.crown(f);
  const ctx: FightCtx = { others: [f], boast: true, tune: TUNE, rng: mulberry32(3) }; // the champion struts and boasts
  const crown = scene.getObjectByName('crown')!;
  const H = layout.ringHeight, eye = new Vector3();
  let t = 0, checked = 0;
  while (t < 4) {
    f.think(DT, t, ctx);
    world.step();
    t += DT;
    driveBones(obj, f.ragdoll, DT);
    finale.update(DT);
    // checked between boasts (a move may swing the head about), every quarter second from 1 s
    if (t < 1 || f.attack !== 'none' || Math.round(t * 60) % 15 !== 0) continue;
    scene.updateMatrixWorld(true);
    let top = -Infinity;
    for (const e of obj.eyes) top = Math.max(top, eye.setFromMatrixPosition(e.ball!.matrixWorld).y + e.radius);
    const head = (f.ragdoll.head ?? f.ragdoll.torso).body.translation();
    expect(crown.position.y, `${k} at ${t.toFixed(2)} s: crown over the eyes`).toBeGreaterThan(top);
    expect(crown.position.y, `${k} at ${t.toFixed(2)} s: crown near the top`).toBeLessThan(top + 0.6 * H);
    expect(crown.position.y, `${k}: over the head's middle`).toBeGreaterThan(head.y);
    expect(Math.hypot(crown.position.x - head.x, crown.position.z - head.z), `${k}: over the head`).toBeLessThan(0.45 * H);
    checked++;
  }
  expect(checked).toBeGreaterThan(3);
  obj.dispose();
}, 30_000);
