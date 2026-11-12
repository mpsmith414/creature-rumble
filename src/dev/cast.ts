// Dev only (`/?dev=cast`): the valley's cast (deer, rabbit, fox, wolf, duck, hawk, trout, frog) stood up as fighters by
// `ensureFighter`, each beside its original build as the valley made it, all seen from the side at the same size, to
// judge by eye whether standing up keeps a creature's shape (no API key needed). `&shot=1` saves the first full frame,
// labels included, as .shots/cast.png (the dev server's /__shot).
import {
  Color, DirectionalLight, HemisphereLight, OrthographicCamera, Scene, Vector3 as V3,
} from 'three/webgpu';
import { BuilderClient } from '../builder/client';
import type { Skeleton } from '../builder/skeleton';
import { planFor } from '../fight/moves';
import { ragdollLayout } from '../physics/layout';
import { Ragdoll } from '../physics/ragdoll';
import { createWorld, initPhysics } from '../physics/world';
import { ensureFighter } from '../recipe/fighter';
import type { Recipe } from '../recipe/schema';
import { driveBones } from '../render/drive';
import { createFighterObject } from '../render/fighter-object';
import { createRenderer } from '../render/renderer';

/** The cast's order in the valley (tests/fixtures/cast/index.ts). */
const ORDER = ['deer', 'rabbit', 'fox', 'wolf', 'duck', 'hawk', 'trout', 'frog'];
const PER_ROW = 4;
/** Gaps in metres at ring size: between a creature's two builds, between pairs, and the label band over each row. */
const PAIR_GAP = 0.25, CELL_GAP = 0.8, LABEL = 0.55;
/** Turned a quarter about +y, a creature facing +z faces +x: to the right, seen from the camera on +z. */
const SIDE = Math.PI / 2;

/** The valley's cast as recipes (copied to src/fixtures/cast by tools/cast-fixtures.ts), in the valley's order. */
function cast(): Recipe[] {
  const all = import.meta.glob<{ default: unknown }>('../fixtures/cast/*.json', { eager: true });
  const named = Object.entries(all).map(([path, m]) => ({ id: path.replace(/^.*\/|\.json$/g, ''), recipe: structuredClone(m.default) as Recipe }));
  const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
  return named.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id)).map((x) => x.recipe);
}

const extent = (sk: Skeleton) => ({ w: sk.max.z - sk.min.z, h: sk.max.y - sk.min.y });

export async function showCast(canvas: HTMLCanvasElement, opts: { shot: boolean }): Promise<void> {
  const [{ renderer }] = await Promise.all([createRenderer(canvas, 'high'), initPhysics()]);
  const scene = new Scene();
  scene.background = new Color('#cdeffd');
  scene.add(new HemisphereLight('#fff0ff', '#6040a0', 1.6));
  const sun = new DirectionalLight('#ffffff', 2.2);
  sun.position.set(3, 10, 12);
  scene.add(sun, sun.target);
  const camera = new OrthographicCamera();
  const labels = document.createElement('canvas');
  Object.assign(labels.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
  document.body.append(labels);

  const recipes = cast();
  const builder = new BuilderClient();
  const fighters = recipes.map((r) => ensureFighter(r));
  const [originals, stood] = await Promise.all([
    Promise.all(recipes.map((r) => builder.build(r))),
    Promise.all(fighters.map((f) => builder.build(f.recipe))),
  ]);
  const world = createWorld(20);

  // lay the pairs out in rows: the original on the left, the fighter on the right, both facing right, at the fighter's scale
  type Cell = { name: string; fixes: string; x: number; w: number; wO: number; h: number; place(base: number): void };
  const rows: { cells: Cell[]; base: number; h: number }[] = [];
  let width = 0;
  recipes.forEach((recipe, i) => {
    const sk = stood[i].skeleton, skO = originals[i].skeleton;
    const layout = ragdollLayout(sk, planFor(fighters[i].recipe, sk));
    const s = layout.scale;
    const o = extent(skO), f = extent(sk);
    if (i % PER_ROW === 0) rows.push({ cells: [], base: 0, h: 0 });
    const row = rows[rows.length - 1];
    const x = row.cells.reduce((t, c) => t + c.w + CELL_GAP, 0);
    const place = (base: number) => {
      // the original as the valley built it: its rest pose, not driven (so its root may move and turn)
      const orig = createFighterObject(originals[i], recipe, ragdollLayout(skO, planFor(recipe, skO)));
      orig.root.scale.setScalar(s);
      orig.root.rotation.y = SIDE;
      orig.root.position.set(x - skO.min.z * s, base - skO.min.y * s, 0);
      scene.add(orig.root);
      // the fighter, posed standing by its ragdoll as the ring shows it (its root stays put: the bones are placed in the world)
      const rag = new Ragdoll(world, layout, { bounce: 0.35 });
      rag.pose(new V3(x + o.w * s + PAIR_GAP - sk.min.z * s, base, 0), SIDE);
      const obj = createFighterObject(stood[i], fighters[i].recipe, layout);
      scene.add(obj.root);
      driveBones(obj, rag);
    };
    const cell: Cell = { name: recipe.name, fixes: fighters[i].fixes.join('; '), x, w: (o.w + f.w) * s + PAIR_GAP, wO: o.w * s, h: Math.max(o.h, f.h) * s, place };
    row.cells.push(cell);
    row.h = Math.max(row.h, cell.h);
    width = Math.max(width, x + cell.w);
  });
  let top = 0;
  for (const row of rows) {
    top -= LABEL;
    row.base = top - row.h;
    top = row.base - CELL_GAP * 0.5;
    for (const c of row.cells) c.place(row.base);
  }
  const height = -top;

  const fit = () => {
    const w = canvas.clientWidth || 1280, hh = canvas.clientHeight || 720;
    renderer.setSize(w, hh, false);
    const pad = 0.4, aspect = w / hh;
    let halfW = width / 2 + pad, halfH = height / 2 + pad;
    if (halfW / halfH > aspect) halfH = halfW / aspect;
    else halfW = halfH * aspect;
    Object.assign(camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH, near: 0.1, far: 100 });
    camera.position.set(width / 2, -height / 2, 30);
    camera.lookAt(width / 2, -height / 2, 0);
    camera.updateProjectionMatrix();
    labels.width = Math.round(w * devicePixelRatio);
    labels.height = Math.round(hh * devicePixelRatio);
  };
  addEventListener('resize', fit);
  fit();

  /** The names over each pair ("as drawn" · "fighter"), drawn on `g` at the canvas's pixel size. */
  const drawLabels = (g: CanvasRenderingContext2D, pxW: number, pxH: number) => {
    const at = (x: number, y: number) => {
      const p = new V3(x, y, 0).project(camera);
      return { x: ((p.x + 1) / 2) * pxW, y: ((1 - p.y) / 2) * pxH };
    };
    const big = Math.max(12, Math.round(pxH / 40)), small = Math.round(big * 0.6);
    g.textAlign = 'center';
    g.fillStyle = '#14304a';
    for (const row of rows) {
      for (const c of row.cells) {
        const name = at(c.x + c.w / 2, row.base + row.h + LABEL * 0.55);
        g.font = `800 ${big}px Nunito, system-ui, sans-serif`;
        g.fillText(c.name, name.x, name.y);
        g.font = `700 ${small}px Nunito, system-ui, sans-serif`;
        const left = at(c.x + c.wO / 2, row.base + row.h + LABEL * 0.15), right = at(c.x + c.wO + PAIR_GAP + (c.w - c.wO - PAIR_GAP) / 2, row.base + row.h + LABEL * 0.15);
        g.fillText('as drawn', left.x, left.y);
        g.fillText('fighter', right.x, right.y);
      }
    }
  };
  const label = () => {
    const g = labels.getContext('2d')!;
    g.clearRect(0, 0, labels.width, labels.height);
    drawLabels(g, labels.width, labels.height);
  };
  addEventListener('resize', label);

  await renderer.compileAsync(scene, camera);
  renderer.render(scene, camera);
  label();
  if (opts.shot) {
    const frame = canvas.toDataURL('image/png'); // the same task as the render
    const img = new Image();
    await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = fail; img.src = frame; });
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const g = out.getContext('2d')!;
    g.drawImage(img, 0, 0);
    drawLabels(g, out.width, out.height);
    await fetch('/__shot?name=cast', { method: 'POST', body: out.toDataURL('image/png') });
    console.info('saved .shots/cast.png');
  }
  renderer.setAnimationLoop(() => renderer.render(scene, camera));
  console.table(rows.flatMap((r) => r.cells).map((c) => ({ name: c.name, standUp: c.fixes })));
  Object.assign(window, { __cast: { scene, camera, renderer, world } });
}
