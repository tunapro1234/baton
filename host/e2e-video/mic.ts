// Shoot harness only (never part of the page): the microphone becomes a synthetic clip, the speech model
// comes from the local copy instead of the network, and every request that would leave the machine is
// logged and blocked. Recognition itself is untouched: MediaRecorder, the Whisper worker and matchPlanNames
// run exactly as they do for a visitor.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const MODELS = `${repo}.baton/models/`;
const ORT = `${repo}node_modules/onnxruntime-web/dist/`;
const CLIPS = `${repo}evals/stt/audio/`;
const CORS = { 'access-control-allow-origin': '*' };

export type Outside = { url: string; served: 'local copy' | 'blocked' };

/** Seconds of audio in a 16-bit mono clip from evals/stt/audio. */
export function clipSeconds(id: string): number {
  const wav = readFileSync(`${CLIPS}${id}.wav`);
  const rate = wav.readUInt32LE(24);
  const bytes = wav.length - 44;
  return bytes / (rate * 2);
}

const type = (path: string) =>
  path.endsWith('.json') ? 'application/json' : path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';

/** Routes for the whole context, so the speech worker's requests are covered too. Returns the log of outside requests. */
export async function keepEverythingLocal(context: BrowserContext): Promise<Outside[]> {
  const outside: Outside[] = [];
  // Registered first, so it runs last: anything not on 127.0.0.1 and not served below is blocked.
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.protocol === 'data:' || url.protocol === 'blob:') return route.fallback();
    outside.push({ url: url.href, served: 'blocked' });
    return route.abort('blockedbyclient');
  });
  await context.route(/^https:\/\/huggingface\.co\/(onnx-community\/whisper-base\.en)\/resolve\/[^/]+\/(.+)$/, (route) => {
    const [, repoId, file] = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/[^/]+\/([^?]+)/.exec(route.request().url())!;
    outside.push({ url: route.request().url(), served: 'local copy' });
    const path = `${MODELS}${repoId}/${file}`;
    if (!existsSync(path)) return route.fulfill({ status: 404, headers: CORS, body: 'not in the local model copy' });
    return route.fulfill({ path, headers: { ...CORS, 'content-type': type(path) } });
  });
  await context.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@[^/]+\/dist\/([^?]+)$/, (route) => {
    const file = /\/dist\/([^?]+)$/.exec(route.request().url())![1]!;
    outside.push({ url: route.request().url(), served: 'local copy' });
    return route.fulfill({ path: `${ORT}${file}`, headers: { ...CORS, 'content-type': type(file) } });
  });
  // The clips themselves, on the page's own origin.
  await context.route(/\/__clips\/(v\d+)\.wav$/, (route) => {
    const id = /\/__clips\/(v\d+)\.wav$/.exec(route.request().url())![1]!;
    return route.fulfill({ path: `${CLIPS}${id}.wav`, headers: { 'content-type': 'audio/wav' } });
  });
  return outside;
}

/**
 * Replaces getUserMedia with a stream that plays the clip chosen by useClip(), and hides the Web Speech
 * constructor so the page picks its Whisper path (the one a visitor gets when on-device Web Speech is missing).
 */
export async function syntheticMicrophone(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true, writable: true });
    const w = window as unknown as { __clip?: string; __clipStartedAt?: number; __loadClip?: (id: string) => Promise<void> };
    let ctx: AudioContext | undefined;
    const buffers = new Map<string, AudioBuffer>();
    const audio = () => (ctx ??= new AudioContext({ sampleRate: 48000 }));
    w.__loadClip = async (id: string) => {
      const data = await (await fetch(`/__clips/${id}.wav`)).arrayBuffer();
      buffers.set(id, await audio().decodeAudioData(data));
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const c = audio();
      await c.resume();
      const dest = c.createMediaStreamDestination();
      const buf = w.__clip ? buffers.get(w.__clip) : undefined;
      if (buf) {
        const src = c.createBufferSource();
        src.buffer = buf;
        src.connect(dest);
        // A short lead so MediaRecorder is running before the first word.
        src.start(c.currentTime + 0.15);
        w.__clipStartedAt = performance.now() + 150;
      }
      w.__clip = undefined;
      return dest.stream;
    };
  });
}

export async function loadClips(page: Page, ids: string[]): Promise<void> {
  for (const id of ids) await page.evaluate((i) => (window as unknown as { __loadClip(id: string): Promise<void> }).__loadClip(i), id);
}

export async function useClip(page: Page, id: string): Promise<void> {
  await page.evaluate((i) => ((window as unknown as { __clip?: string }).__clip = i), id);
}
