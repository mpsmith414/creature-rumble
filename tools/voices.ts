/**
 * Loads the announcer's voice (the first run downloads the model), or says one line.
 * Run: npm run voices                                  loads the voice model into the local cache
 *      npm run voices -- --say "Here comes the Rumble!"   writes data/voice/say.wav (to listen to a line)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { kokoroSynth } from '../server/voice';

const DIR = 'data/voice';

async function main(): Promise<void> {
  const synth = kokoroSynth();
  console.log('loading the voice (the first run downloads the model)...');
  while (!synth.ready()) {
    if (synth.failed?.()) throw new Error('the voice model could not load');
    await new Promise((r) => setTimeout(r, 200));
  }
  const say = process.argv.indexOf('--say');
  if (say >= 0) {
    const text = process.argv[say + 1];
    if (!text) throw new Error('--say needs a line of text');
    await mkdir(DIR, { recursive: true });
    await writeFile(`${DIR}/say.wav`, await synth.speak(text));
    console.log(`wrote ${DIR}/say.wav`);
    return;
  }
  console.log('the voice is ready');
}

await main();
process.exit(0); // the model's threads would otherwise keep the process alive
