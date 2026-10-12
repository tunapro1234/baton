// Speech eval: 30 synthetic adult-voice clips (stt/audio, made by stt-audio.ts) go through the same
// Whisper model the host runs, then through the plan-name matcher. A clip counts when the drug it
// names comes out as that plan name. Prints N/30 after matching and the raw count before it.
// First run downloads the model into .baton/models. No API key.
import { readFileSync } from 'node:fs';
import { env, pipeline } from '@huggingface/transformers';
import { STT_DTYPE, STT_MODEL } from '../../host/src/stt-model.ts';
import { matchPlanNames } from '../../host/src/stt-match.ts';
import { readWav } from './wav.ts';

type Sentence = { id: string; text: string; medId: string; voice: string };

const dir = new URL('../stt/', import.meta.url);
const sentences = JSON.parse(readFileSync(new URL('sentences.json', dir), 'utf8')) as Sentence[];
const plan = JSON.parse(readFileSync(new URL('../../contract/fixtures/june.json', import.meta.url), 'utf8')) as {
  plan: { id: string; generic: string }[];
};
const generic = new Map(plan.plan.map((m) => [m.id, m.generic.toLowerCase()]));
const names = [...generic.values()];

// --dtype q8 tries a smaller encoder without changing what the page runs.
const i = process.argv.indexOf('--dtype');
const dtype = i > 0 ? process.argv[i + 1]! : STT_DTYPE;
env.cacheDir = new URL('../../.baton/models/', import.meta.url).pathname;

const has = (text: string, name: string) => new RegExp(`\\b${name}\\b`, 'i').test(text);
const t0 = Date.now();
const asr = await pipeline('automatic-speech-recognition', STT_MODEL, { dtype: dtype as never });
const loadMs = Date.now() - t0;

let raw = 0;
let matched = 0;
const ms: number[] = [];
for (const s of sentences) {
  const want = generic.get(s.medId);
  if (!want) throw new Error(`${s.id}: ${s.medId} is not in the plan`);
  const t = Date.now();
  const out = (await asr(readWav(readFileSync(new URL(`audio/${s.id}.wav`, dir))))) as { text: string };
  ms.push(Date.now() - t);
  const heard = out.text.trim();
  const fixed = matchPlanNames(heard, names).text;
  const r = has(heard, want);
  const m = has(fixed, want);
  raw += r ? 1 : 0;
  matched += m ? 1 : 0;
  console.log(`${m ? 'ok  ' : 'MISS'} ${s.id} ${s.voice.padEnd(6)} heard "${heard}"${fixed !== heard ? ` -> "${fixed}"` : ''}`);
}
ms.sort((a, b) => a - b);
console.log(`model ${STT_MODEL} ${JSON.stringify(dtype)}, load ${loadMs} ms, median ${ms[ms.length >> 1]} ms per clip on CPU`);
console.log(`stt: ${matched}/${sentences.length} after plan-name matching (raw ${raw}/${sentences.length})`);
