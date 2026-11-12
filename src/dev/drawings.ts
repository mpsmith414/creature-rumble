// Dev only (`/?dev=drawings`): the drawing test set (the valley's, ported). Every image in src/fixtures/drawings goes
// through the real designer, and each row shows the drawing beside the fighter built from it (the toon fighter standing,
// from the drawing's angle and from three-quarters) with a 1/2/3 score: "not mine" / "kind of" / "that's MY one!".
// When the designer rests (its API key rejected, the day's limit reached, the API not running) the page says so plainly.
// `&passes=N` sets the look-again passes (default 3); `&shot=1` runs them all, then saves the page as .shots/drawings.png.
import { PerspectiveCamera, Scene } from 'three/webgpu';
import { BuilderClient } from '../builder/client';
import { api, DesignerInvalid, DesignerResting, designerModel, type RestingReason } from '../designer/api';
import { imageUrl, prepareImage } from '../designer/image';
import { designCreature } from '../designer/loop';
import { createRenderer } from '../render/renderer';
import { renderView } from '../render/snapshot';
import { clear, h } from '../shared/dom';

const SCORES_KEY = 'rumble.drawingScores';
const SCORE_WORDS = ['', 'Not mine', 'Kind of', 'That’s MY one!'];
const SCORE_FACES = ['', '1 😕', '2 🙂', '3 🤩'];

/** What the page says when the designer rests, by why. */
const RESTING: Record<RestingReason, string> = {
  key: 'The designer is resting: its API key was rejected. Put a working ANTHROPIC_API_KEY in .env, then restart npm run dev.',
  limit: 'The designer is resting: today’s creature limit is reached (raise it from the TV menu, or try tomorrow).',
  busy: 'The designer is resting (busy or down). Try again in a minute.',
  network: 'The designer can’t be reached. Is npm run dev running (the API on port 8797)?',
};

const CSS = `
.rm-drawings { position: fixed; inset: 0; overflow: auto; z-index: 50; padding: 24px; box-sizing: border-box;
  background: #f8f3e9; color: #2b2620; font-family: 'Nunito', system-ui, sans-serif; }
.rm-drawings h1 { margin: 0 0 4px; font-weight: 900; }
.rm-drawings p { margin: 0 0 12px; color: #6b6155; max-width: 70ch; }
.rm-drawings .banner { margin: 0 0 14px; padding: 10px 14px; border-radius: 12px; font-weight: 800; background: #fffdf8; border: 2px solid #ddd0bb; max-width: 90ch; }
.rm-drawings .banner.bad { background: #ffe9e4; border-color: #e0832e; color: #7a2a10; }
.rm-drawings button { font: inherit; font-weight: 700; cursor: pointer; border: 2px solid #ddd0bb; background: #fffdf8; border-radius: 14px; padding: 0.35em 0.9em; }
.rm-drawings button.primary { background: #e0832e; border-color: #e0832e; color: #fff; }
.rm-drawings button.on { background: #4f7a35; border-color: #4f7a35; color: #fff; }
.rm-drawings button:disabled { opacity: 0.5; cursor: default; }
.rm-drawings table { border-collapse: separate; border-spacing: 0 12px; }
.rm-drawings td { background: #fffdf8; padding: 10px; vertical-align: middle; }
.rm-drawings td:first-child { border-radius: 16px 0 0 16px; }
.rm-drawings td:last-child { border-radius: 0 16px 16px 0; }
.rm-drawings th { text-align: left; color: #6b6155; font-weight: 800; padding: 0 10px; }
.rm-drawings img { width: 220px; height: 220px; object-fit: contain; background: #e9e6df; border-radius: 12px; display: block; }
.rm-drawings .name { font-weight: 900; font-size: 1.1em; margin-bottom: 4px; }
.rm-drawings .status { color: #6b6155; font-weight: 800; max-width: 300px; }
.rm-drawings .status.bad { color: #a33a12; }
.rm-drawings .score { display: flex; gap: 6px; margin-top: 10px; }
.rm-drawings .notes { font-size: 0.85em; color: #6b6155; max-width: 320px; margin-top: 6px; }
`;

function loadScores(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SCORES_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

export async function showDrawings(view: HTMLCanvasElement, opts: { shot: boolean; passes: number }): Promise<void> {
  view.style.display = 'none'; // the page is the table; the pictures come from a canvas of their own
  const files = import.meta.glob('../fixtures/drawings/*.{png,jpg,jpeg}', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
  const scores = loadScores();
  const saveScores = () => {
    try {
      localStorage.setItem(SCORES_KEY, JSON.stringify(scores));
    } catch { /* the scores just won't stick */ }
  };

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const banner = h('div', { class: 'banner', role: 'status', 'aria-live': 'polite' }, 'Checking the designer…');
  const say = (text: string, bad = false) => {
    banner.textContent = text;
    banner.classList.toggle('bad', bad);
  };
  const runAll = h('button', { class: 'primary', type: 'button' }, `▶ Run all (${opts.passes} look-again pass${opts.passes === 1 ? '' : 'es'} each)`);

  const rows = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, url]) => {
    const name = path.split('/').pop()!.replace(/\.\w+$/, '');
    const status = h('div', { class: 'status' }, 'Not run yet');
    const front = h('img', { alt: `${name}: the fighter from the drawing's angle` });
    const turned = h('img', { alt: `${name}: the fighter from three-quarters` });
    const notes = h('div', { class: 'notes' });
    const scoreBox = h('div', { class: 'score', role: 'group', 'aria-label': `Score for ${name}` });
    const renderScore = () => {
      clear(scoreBox).append(...[1, 2, 3].map((n) => h('button', {
        type: 'button', class: scores[name] === n ? 'on' : '', title: SCORE_WORDS[n], 'aria-pressed': scores[name] === n ? 'true' : 'false',
        onclick: () => { scores[name] = n; saveScores(); renderScore(); },
      }, SCORE_FACES[n])));
    };
    renderScore();
    const tr = h('tr', {},
      h('td', {}, h('div', { class: 'name' }, name), h('img', { src: url, alt: `${name}: the drawing` })),
      h('td', {}, front), h('td', {}, turned),
      h('td', {}, status, notes, scoreBox),
    );
    const show = (text: string, bad = false) => {
      status.textContent = text;
      status.classList.toggle('bad', bad);
    };
    return { name, url, tr, show, front, turned, notes };
  });

  const page = h('main', { class: 'rm-drawings' },
    h('h1', {}, 'Drawing test set'),
    h('p', {}, 'Each drawing goes through the real creature designer and comes out as a fighter. Score each one: 1 = “not mine”, 2 = “kind of”, 3 = “that’s MY one!”. ' +
      'Add photos of real drawings to src/fixtures/drawings/ (as .jpg) and reload. Every run makes real designer calls, and each read counts towards today’s creature limit.'),
    banner,
    h('div', { style: 'margin-bottom: 8px' }, runAll),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Drawing'), h('th', {}, 'Fighter, as drawn'), h('th', {}, 'Fighter, three-quarters'), h('th', {}, 'Result'))),
      h('tbody', {}, ...rows.map((r) => r.tr))),
  );
  document.body.append(page);

  // is the designer's server up? (a rejected key only shows on the first real call)
  const model = await designerModel();
  if (model) say(`The designer (${model}) is answering. Press Run all.`);
  else say(RESTING.network, true);

  const studio = h('canvas', { width: 768, height: 768, hidden: true });
  document.body.append(studio);
  const { renderer } = await createRenderer(studio, 'high');
  const ctx = { renderer, scene: new Scene(), camera: new PerspectiveCamera() };
  const builder = new BuilderClient();

  /** Runs one drawing; the reason when the designer is resting (the rest are not worth trying), else null. */
  async function runOne(r: (typeof rows)[number]): Promise<RestingReason | null> {
    const t0 = performance.now();
    r.show('Reading the drawing…');
    clear(r.notes);
    try {
      const image = await prepareImage(await (await fetch(r.url)).blob());
      const out = await designCreature(
        { image, words: '' },
        { api, build: (x) => builder.build(x), snapshot: (b, x, v) => renderView(ctx, b, x, v) },
        { passes: opts.passes },
        (s) => {
          if (s.kind === 'looking') {
            r.front.src = imageUrl(s.render);
            r.show(`Look-again pass ${s.pass}…`);
          } else if (s.kind === 'building') r.show('Building…');
          else if (s.kind === 'fixing') r.show(s.note);
        },
      );
      if (out.status !== 'ok') {
        r.show(`${out.status === 'noCreature' ? 'No creature found' : 'Declined'}: ${out.message}`, true);
        return null;
      }
      r.front.src = imageUrl(await renderView(ctx, out.body, out.recipe, out.view, 512));
      r.turned.src = imageUrl(await renderView(ctx, out.body, out.recipe, { angle: 'threeQuarter', facing: 'right' }, 512));
      const secs = ((performance.now() - t0) / 1000).toFixed(0);
      r.show(`${out.cards.name} · ${out.recipe.fight?.move ?? 'no move'} · ${out.history.length} pass${out.history.length === 1 ? '' : 'es'} · ${secs} s`);
      r.notes.append(
        h('div', {}, `Saw: ${out.checklist.join(', ') || '(nothing listed)'}`),
        h('div', {}, `${out.recipe.parts.length} parts, ${out.recipe.skin.regions.length} skin regions, patterns: ${out.recipe.skin.regions.flatMap((g) => (g.pattern ? [g.pattern.kind] : [])).join(', ') || 'none'}`),
        ...out.history.map((p) => h('div', {}, `${p.pass}. ${p.verdict === 'matches' ? '✓ matches' : `${p.edits} edits`}: ${p.note}`)),
      );
      return null;
    } catch (e) {
      if (e instanceof DesignerResting) {
        r.show(RESTING[e.reason], true);
        return e.reason;
      }
      r.show(e instanceof DesignerInvalid ? 'The designer got muddled (its answer could not be used, twice).' : `Error: ${String(e)}`, true);
      return null;
    }
  }

  const runEvery = async () => {
    runAll.disabled = true;
    try {
      for (const [i, r] of rows.entries()) {
        const resting = await runOne(r);
        if (!resting) continue;
        say(RESTING[resting], true);
        for (const rest of rows.slice(i + 1)) rest.show('Not run: the designer is resting.', true);
        return;
      }
      say('All drawings done. Score each one.');
    } finally {
      runAll.disabled = false;
    }
  };
  runAll.addEventListener('click', () => void runEvery());
  Object.assign(window, { __drawings: { rows, runOne, runEvery } });

  if (opts.shot) {
    await runEvery();
    await saveShot(page);
  }
}

/** The whole page (scrolled or not) as .shots/drawings.png, through the dev server's /__shot. */
async function saveShot(page: HTMLElement): Promise<void> {
  const { toPng } = await import('html-to-image');
  // the library waits on frames, which stall while the pane is hidden: stand in for them
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 0);
  let png: string;
  try {
    png = await toPng(page, { width: page.scrollWidth, height: page.scrollHeight, style: { position: 'static', overflow: 'visible', height: 'auto' }, skipFonts: true });
  } finally { window.requestAnimationFrame = raf; }
  await fetch('/__shot?name=drawings', { method: 'POST', body: png });
  console.info('saved .shots/drawings.png');
}
