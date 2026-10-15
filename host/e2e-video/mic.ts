// Shoot harness only (never part of the page): the microphone becomes a synthetic clip, the speech model
// comes from the local copy instead of the network, and every request that would leave the machine is
// logged and blocked. Recognition itself is untouched: MediaRecorder, the Whisper worker and matchPlanNames
// run exactly as they do for a visitor.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

let modelBase: Promise<string> | undefined;
let modelHttp: ReturnType<typeof createServer> | undefined;

/**
 * Serves the local model copy over plain HTTP on 127.0.0.1. route.fulfill sends a body through the DevTools
 * pipe as base64, and the 82 MB (79 MiB) fp32 encoder becomes 110 MB, over Chromium's 100 MiB limit: the browser drops
 * the connection. A redirect to this server keeps the bytes off the pipe.
 */
function modelServer(): Promise<string> {
  modelBase ??= new Promise((resolve) => {
    const server = createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname).replace(/^\/+/, '');
      const path = `${MODELS}${rel}`;
      if (rel.split('/').includes('..') || !existsSync(path) || !statSync(path).isFile()) {
        res.writeHead(404, CORS).end('not in the local model copy');
        return;
      }
      res.writeHead(200, { ...CORS, 'content-type': type(path), 'content-length': statSync(path).size });
      if (req.method === 'HEAD') res.end();
      else createReadStream(path).pipe(res);
    });
    modelHttp = server;
    server.unref();
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`));
  });
  return modelBase;
}

/** Stops the model server once the shoot is done (it only ever listens on 127.0.0.1). */
export function stopModelServer(): Promise<void> {
  const server = modelHttp;
  modelHttp = undefined;
  modelBase = undefined;
  if (!server) return Promise.resolve();
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

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
    return modelServer().then((base) => route.fulfill({ status: 302, headers: { ...CORS, location: `${base}${repoId}/${file}` } }));
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
    // The first document of a new page is about:blank, which has no mediaDevices.
    if (!navigator.mediaDevices) return;
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
