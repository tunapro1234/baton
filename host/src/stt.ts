// Push-to-talk speech input that stays on the device. Chrome's Web Speech API is used only when it can
// recognise on the device (processLocally); otherwise Whisper runs in a Web Worker with transformers.js.
// Either way the audio never leaves the browser. The transcript then goes through matchPlanNames.
import { STT_RATE } from './stt-model.ts';

export type SttEngine = 'web-speech-local' | 'whisper';
export type SttStatus = { phase: 'loading'; progress: number } | { phase: 'ready' } | { phase: 'error'; message: string };

export interface Recogniser {
  readonly engine: SttEngine;
  start(): Promise<void>;
  /** Stops listening and resolves with what was heard ('' when nothing was). */
  stop(): Promise<string>;
}

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  phrases?: unknown[];
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};
type SpeechRecognitionCtor = {
  new (): SpeechRecognitionLike;
  available?(o: { langs: string[]; processLocally: boolean }): Promise<Availability>;
};

const LANG = 'en-US';

function speechCtor(w: object): SpeechRecognitionCtor | undefined {
  // Only the unprefixed constructor has available() and processLocally; webkitSpeechRecognition sends audio to a server.
  return (w as { SpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition;
}

/** web-speech-local only when the browser says on-device recognition for English is installed. */
export async function pickEngine(w: object = globalThis): Promise<SttEngine> {
  const SR = speechCtor(w);
  if (!SR || typeof SR.available !== 'function') return 'whisper';
  try {
    return (await SR.available({ langs: [LANG], processLocally: true })) === 'available' ? 'web-speech-local' : 'whisper';
  } catch {
    return 'whisper';
  }
}

/** On-device Web Speech. Plan names are passed as phrase hints where the browser supports them. */
export class LocalWebSpeech implements Recogniser {
  readonly engine = 'web-speech-local' as const;
  private rec: SpeechRecognitionLike | undefined;
  private heard: string[] = [];
  private failed: string | undefined;

  constructor(private readonly w: object, private readonly names: () => string[]) {}

  async start(): Promise<void> {
    const SR = speechCtor(this.w);
    if (!SR) throw new Error('Speech recognition is not available');
    const rec = new SR();
    rec.lang = LANG;
    rec.continuous = true;
    rec.interimResults = false;
    rec.processLocally = true;
    const Phrase = (this.w as { SpeechRecognitionPhrase?: new (p: string, boost: number) => unknown }).SpeechRecognitionPhrase;
    if (Phrase) {
      try {
        rec.phrases = this.names().map((n) => new Phrase(n, 5));
      } catch {
        // Phrase hints are optional; the matcher still corrects near misses.
      }
    }
    this.heard = [];
    this.failed = undefined;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        if (r.isFinal) this.heard.push(r[0]!.transcript.trim());
      }
    };
    rec.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') this.failed = e.error;
    };
    this.rec = rec;
    rec.start();
  }

  stop(): Promise<string> {
    const rec = this.rec;
    if (!rec) return Promise.resolve('');
    this.rec = undefined;
    return new Promise((resolve, reject) => {
      rec.onend = () => (this.failed ? reject(new Error(`Speech recognition failed: ${this.failed}`)) : resolve(this.heard.join(' ').trim()));
      rec.stop();
    });
  }
}

export type WorkerLike = {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};
export type WorkerReply =
  | { type: 'progress'; progress: number }
  | { type: 'ready' }
  | { type: 'text'; id: number; text: string }
  | { type: 'error'; id?: number; message: string };

/** Talks to stt-worker.ts: loads the model once and transcribes 16 kHz mono samples. */
export class WhisperClient {
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();

  constructor(private readonly worker: WorkerLike, private readonly onStatus: (s: SttStatus) => void = () => {}) {
    worker.onmessage = (e) => this.receive(e.data as WorkerReply);
  }

  /** Starts the model download early, so the first press does not wait for all of it. */
  preload(): void {
    this.worker.postMessage({ type: 'load' });
  }

  transcribe(samples: Float32Array): Promise<string> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'transcribe', id, samples }, [samples.buffer]);
    });
  }

  private receive(m: WorkerReply): void {
    if (m.type === 'progress') this.onStatus({ phase: 'loading', progress: m.progress });
    else if (m.type === 'ready') this.onStatus({ phase: 'ready' });
    else if (m.type === 'text') {
      this.waiting.get(m.id)?.resolve(m.text.trim());
      this.waiting.delete(m.id);
    } else if (m.id !== undefined) {
      this.waiting.get(m.id)?.reject(new Error(m.message));
      this.waiting.delete(m.id);
    } else {
      this.onStatus({ phase: 'error', message: m.message });
    }
  }
}

/** Records from the microphone while the button is held, then hands 16 kHz samples to Whisper. */
export class WhisperRecogniser implements Recogniser {
  readonly engine = 'whisper' as const;
  private stream: MediaStream | undefined;
  private recorder: MediaRecorder | undefined;
  private chunks: Blob[] = [];

  constructor(private readonly client: WhisperClient) {}

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => this.chunks.push(e.data);
    this.recorder.start();
  }

  async stop(): Promise<string> {
    const recorder = this.recorder;
    if (!recorder) return '';
    this.recorder = undefined;
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    const blob = new Blob(this.chunks, { type: recorder.mimeType });
    if (blob.size === 0) return '';
    // decodeAudioData resamples to the context rate, which is the rate Whisper expects.
    const ctx = new AudioContext({ sampleRate: STT_RATE });
    try {
      const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
      return await this.client.transcribe(new Float32Array(audio.getChannelData(0)));
    } finally {
      void ctx.close();
    }
  }
}

/** The recogniser for this browser, or undefined when there is no microphone API at all. */
export async function createRecogniser(names: () => string[], onStatus: (s: SttStatus) => void): Promise<Recogniser | undefined> {
  if ((await pickEngine()) === 'web-speech-local') return new LocalWebSpeech(globalThis, names);
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return undefined;
  const worker = new Worker(new URL('./stt-worker.ts', import.meta.url), { type: 'module' });
  const client = new WhisperClient(worker, onStatus);
  client.preload();
  return new WhisperRecogniser(client);
}
