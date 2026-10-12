// npm run stt:audio -w evals: makes the 30 eval clips in stt/audio/ with a text-to-speech API
// (xAI, adult voices, 16 kHz PCM). The clips are committed, so eval:stt itself needs no key.
// Existing clips are kept; delete one to make it again.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pcm16ToWav, RATE } from './wav.ts';

type Sentence = { id: string; text: string; medId: string; voice: string };

const key = process.env.XAI_API_KEY ?? '';
if (!key) {
  console.error('stt:audio needs XAI_API_KEY. It is not set, so nothing was made.');
  process.exit(2);
}
const dir = new URL('../stt/', import.meta.url);
const sentences = JSON.parse(readFileSync(new URL('sentences.json', dir), 'utf8')) as Sentence[];

for (const s of sentences) {
  const file = new URL(`audio/${s.id}.wav`, dir);
  if (existsSync(file)) continue;
  const res = await fetch('https://api.x.ai/v1/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: s.text, voice_id: s.voice, language: 'en', output_format: { codec: 'pcm', sample_rate: RATE } }),
  });
  if (!res.ok) throw new Error(`${s.id}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  writeFileSync(file, pcm16ToWav(new Uint8Array(await res.arrayBuffer())));
  console.log(`${s.id} ${s.voice}: ${s.text}`);
}
