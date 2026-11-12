/**
 * Writes a few synthetic "kid-style" crayon drawings to src/fixtures/drawings/ for the drawing test set (`/?dev=drawings`).
 * Run: npx tsx tools/make-test-drawings.ts
 * Photos of real drawings go in the same folder as .jpg files (kept out of git).
 */
import { writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { mulberry32 } from '../src/util/rng';

const W = 1024, H = 768;
type P = [number, number];

function crayon(seed: number) {
  const rng = mulberry32(seed);
  const j = (a: number) => (rng() * 2 - 1) * a;
  /** A wobbly line through points (a child's hand), drawn twice slightly apart like crayon. */
  const line = (pts: P[], color: string, width = 9, close = false) => {
    const pass = (wob: number) => {
      const p = pts.map(([x, y]) => [x + j(wob), y + j(wob)] as P);
      if (close) p.push(p[0]);
      let d = `M${p[0][0].toFixed(1)},${p[0][1].toFixed(1)}`;
      for (let i = 1; i < p.length; i++) {
        const [x0, y0] = p[i - 1], [x1, y1] = p[i];
        const mx = (x0 + x1) / 2 + j(wob), my = (y0 + y1) / 2 + j(wob);
        d += ` Q${mx.toFixed(1)},${my.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
      }
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>`;
    };
    return pass(3) + pass(5);
  };
  const ellipsePts = (cx: number, cy: number, rx: number, ry: number, n = 18): P[] =>
    Array.from({ length: n }, (_, i) => [cx + Math.cos((i / n) * Math.PI * 2) * rx, cy + Math.sin((i / n) * Math.PI * 2) * ry]);
  /** Colouring-in that wanders a little outside the lines. */
  const fill = (pts: P[], color: string) => {
    const p = pts.map(([x, y]) => `${(x + j(10)).toFixed(1)},${(y + j(10)).toFixed(1)}`).join(' ');
    return `<polygon points="${p}" fill="${color}" opacity="0.75"/>`;
  };
  const dot = (x: number, y: number, r: number, color: string) => `<circle cx="${x + j(2)}" cy="${y + j(2)}" r="${r}" fill="${color}"/>`;
  return { line, fill, ellipsePts, dot };
}

const paper = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fbf8f1"/>${body}</svg>`;

const drawings: Record<string, () => string> = {
  // 1. a purple six-legged lizard with three horns and a zigzag tail
  'lizard-six-legs': () => {
    const c = crayon(1);
    const body = c.ellipsePts(470, 400, 210, 85);
    const head = c.ellipsePts(740, 360, 80, 65);
    let s = c.fill(body, '#8e55c9') + c.fill(head, '#8e55c9') + c.line(body, '#4b2a73', 9, true) + c.line(head, '#4b2a73', 9, true);
    for (const x of [330, 470, 610]) s += c.line([[x, 470], [x - 25, 560], [x - 50, 575]], '#4b2a73') + c.line([[x + 20, 470], [x + 40, 560], [x + 65, 575]], '#4b2a73');
    for (const [x, y] of [[700, 300], [745, 290], [790, 305]]) s += c.line([[x - 15, y + 5], [x, y - 70], [x + 15, y + 5]], '#e0a020', 8);
    s += c.line([[265, 400], [210, 350], [170, 420], [120, 350], [80, 420], [40, 360]], '#4b2a73', 10);
    s += c.dot(770, 345, 12, '#111') + c.line([[730, 395], [760, 410], [795, 395]], '#111', 6);
    return paper(s);
  },
  // 2. a round orange fluff-ball with two tiny legs and huge ears
  'fluffball-big-ears': () => {
    const c = crayon(2);
    const ball = c.ellipsePts(512, 430, 190, 180, 26).map(([x, y], i) => [x + (i % 2 ? 14 : -6), y + (i % 2 ? 14 : -6)] as [number, number]);
    let s = c.fill(c.ellipsePts(430, 170, 45, 140), '#f08a2a') + c.fill(c.ellipsePts(600, 170, 45, 140), '#f08a2a');
    s += c.line(c.ellipsePts(430, 170, 45, 140), '#8a4510', 9, true) + c.line(c.ellipsePts(600, 170, 45, 140), '#8a4510', 9, true);
    s += c.fill(ball, '#f08a2a') + c.line(ball, '#8a4510', 9, true);
    s += c.line([[460, 600], [455, 680], [425, 690]], '#8a4510') + c.line([[565, 600], [570, 680], [600, 690]], '#8a4510');
    s += c.dot(450, 400, 22, '#111') + c.dot(575, 400, 22, '#111') + c.dot(458, 392, 6, '#fff') + c.dot(583, 392, 6, '#fff');
    s += c.line([[480, 480], [512, 505], [545, 480]], '#111', 7);
    return paper(s);
  },
  // 3. a long blue snake with butterfly wings
  'snake-butterfly-wings': () => {
    const c = crayon(3);
    const spine: [number, number][] = Array.from({ length: 12 }, (_, i) => [120 + i * 68, 470 + Math.sin(i * 0.9) * 70]);
    let s = '';
    for (const [cx, cy, rx, ry, col] of [[470, 300, 120, 90, '#f2c230'], [610, 290, 110, 95, '#f2c230'], [480, 410, 70, 55, '#ef7aa0'], [600, 405, 70, 55, '#ef7aa0']] as const) {
      const pts = c.ellipsePts(cx, cy, rx, ry);
      s += c.fill(pts, col) + c.line(pts, '#7a5a10', 8, true) + c.dot(cx, cy, 16, '#3a7bd5');
    }
    s += c.line(spine, '#2f6fd0', 46) + c.line(spine, '#173f80', 8);
    s += c.fill(c.ellipsePts(925, 440, 55, 42), '#2f6fd0') + c.line(c.ellipsePts(925, 440, 55, 42), '#173f80', 8, true);
    s += c.dot(940, 425, 10, '#111') + c.line([[978, 450], [1010, 455], [1020, 440]], '#d02020', 5) + c.line([[1010, 455], [1018, 470]], '#d02020', 5);
    return paper(s);
  },
  // 4. a green turtle-ish creature with a spotted shell and a very long neck
  'turtle-long-neck': () => {
    const c = crayon(4);
    const shell: [number, number][] = [...c.ellipsePts(450, 470, 220, 140, 20).filter(([, y]) => y <= 475), [230, 480], [670, 480]];
    let s = c.fill(shell, '#4fa84a') + c.line(shell, '#245a22', 10, true);
    for (const [x, y] of [[380, 400], [470, 380], [560, 410], [430, 450], [520, 455]]) s += c.dot(x, y, 22, '#8a5a2a');
    s += c.line([[650, 450], [720, 330], [760, 200], [790, 130]], '#245a22', 34) + c.line([[650, 450], [720, 330], [760, 200], [790, 130]], '#6fc06a', 22);
    s += c.fill(c.ellipsePts(820, 115, 60, 42), '#6fc06a') + c.line(c.ellipsePts(820, 115, 60, 42), '#245a22', 9, true);
    s += c.dot(838, 100, 10, '#111') + c.line([[840, 135], [870, 128]], '#111', 6);
    for (const x of [300, 390, 520, 610]) s += c.line([[x, 485], [x - 5, 560], [x + 25, 565]], '#245a22', 16);
    s += c.line([[230, 470], [180, 500], [165, 485]], '#245a22', 12);
    return paper(s);
  },
};

for (const [name, draw] of Object.entries(drawings)) {
  const png = new Resvg(draw(), { background: '#fbf8f1' }).render().asPng();
  writeFileSync(`src/fixtures/drawings/${name}.png`, png);
  console.log(`src/fixtures/drawings/${name}.png`);
}
