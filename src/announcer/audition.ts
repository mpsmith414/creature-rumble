/**
 * The announcer audition page (`voice.html`): every allowed voice reading every sample line, optionally through the arena
 * sound with a crowd hum underneath, so the owner can pick the voice and speed by ear. Not part of the game.
 */
import { arenaChain } from '../audio/chain';

const VOICES = ['am_michael', 'am_fenrir', 'am_puck', 'am_eric', 'am_liam', 'am_onyx', 'bm_george', 'bm_lewis', 'bm_fable'];
const LINES = [
  "From the bedroom of a mystery maker! Weighing in at one teeny tiny pound! It's... SIR BOUNCES-A-LOT!",
  'OH MY GOODNESS! BLOBZILLA sends him FLYING!',
  'BYE BYE, Captain Noodle! You are OUT of the ring!',
  'Is there ANYONE brave enough to face THE WOBBLER?!',
  'Ladies and gentlemen... your CHAMPION... PRINCESS PICKLE!',
];
/** The crowd hum's level under the arena sound: -24 dB. */
const HUM_GAIN = Math.pow(10, -24 / 20);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let ctx: AudioContext | null = null;
let chain: ReturnType<typeof arenaChain> | null = null;
let hum: GainNode | null = null;
let playing: AudioBufferSourceNode | null = null;

/** The audio graph, made on the first press (browsers need a gesture first). */
function graph(): AudioContext {
  if (ctx) return ctx;
  ctx = new AudioContext();
  chain = arenaChain(ctx, ctx.destination);
  // crowd hum: looping noise through a low-pass, a murmur rather than a hiss
  const len = ctx.sampleRate * 4;
  const noise = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 600;
  hum = ctx.createGain();
  src.connect(lp);
  lp.connect(hum);
  hum.connect(ctx.destination);
  src.start();
  applyArena();
  return ctx;
}

/** Arena sound on: voice through the chain with the hum under it; off: voice straight out, no hum. */
function applyArena(): void {
  if (!chain || !hum) return;
  const on = $<HTMLInputElement>('arena').checked;
  chain.setWet(on ? 1 : 0);
  hum.gain.value = on ? HUM_GAIN : 0;
}

/** Fetch a line in a voice (waiting while the model loads) and play it. */
async function speak(voice: string, text: string, button: HTMLButtonElement): Promise<void> {
  const status = $('status');
  button.disabled = true;
  status.textContent = `${voice}: asking for the line (the first one per voice loads the model)...`;
  try {
    const speed = Number($<HTMLInputElement>('speed').value);
    let res: Response;
    for (;;) {
      res = await fetch('/api/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, voice, speed }) });
      if (res.status !== 503 || ((await res.clone().json().catch(() => ({}))) as { error?: string }).error !== 'loading') break;
      await new Promise((r) => setTimeout(r, 2000)); // the model is still loading
    }
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const c = graph();
    await c.resume();
    const buf = await c.decodeAudioData(await res.arrayBuffer());
    playing?.stop();
    const s = c.createBufferSource();
    s.buffer = buf;
    const arena = $<HTMLInputElement>('arena').checked;
    s.connect(arena ? chain!.input : c.destination);
    playing = s;
    s.start();
    status.textContent = `${voice} at ${speed.toFixed(2)}x${arena ? ', arena sound' : ''}`;
  } catch (e) {
    status.textContent = `${voice}: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    button.disabled = false;
  }
}

const grid = $<HTMLTableElement>('grid');
const head = grid.insertRow();
for (const t of ['voice', ...LINES.map((l, i) => `${i + 1}. ${l.length > 40 ? l.slice(0, 40) + '...' : l}`)]) {
  const th = document.createElement('th');
  th.textContent = t;
  head.append(th);
}
for (const v of VOICES) {
  const row = grid.insertRow();
  row.insertCell().textContent = v;
  LINES.forEach((line, i) => {
    const b = document.createElement('button');
    b.textContent = `Play ${i + 1}`;
    b.title = line;
    b.onclick = () => void speak(v, line, b);
    row.insertCell().append(b);
  });
}
$<HTMLInputElement>('speed').oninput = (e) => {
  $('speedOut').textContent = Number((e.target as HTMLInputElement).value).toFixed(2);
};
$<HTMLInputElement>('arena').onchange = applyArena;
