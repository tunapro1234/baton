// Engine choice and the two recognisers' plumbing, with fake browser objects. The real Whisper model
// runs in npm run eval:stt, not here.
import { describe, expect, it } from 'vitest';
import { LocalWebSpeech, WhisperClient, pickEngine, type SttStatus, type WorkerLike } from '../src/stt.ts';

function speechWindow(available?: (o: { langs: string[]; processLocally: boolean }) => Promise<string>) {
  const made: FakeRecognition[] = [];
  class FakeRecognition {
    lang = '';
    continuous = false;
    interimResults = true;
    processLocally = false;
    phrases: unknown[] = [];
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    started = false;
    constructor() {
      made.push(this);
    }
    start() {
      this.started = true;
    }
    stop() {
      this.onend?.();
    }
    say(...finals: string[]) {
      const results = finals.map((t) => Object.assign([{ transcript: t }], { isFinal: true }));
      this.onresult?.({ resultIndex: 0, results });
    }
  }
  if (available) (FakeRecognition as unknown as { available: typeof available }).available = available;
  class SpeechRecognitionPhrase {
    constructor(readonly phrase: string, readonly boost: number) {}
  }
  return { w: { SpeechRecognition: FakeRecognition, SpeechRecognitionPhrase }, made };
}

describe('pickEngine', () => {
  it('uses Whisper when there is no Web Speech API', async () => {
    expect(await pickEngine({})).toBe('whisper');
  });

  it('ignores the prefixed webkitSpeechRecognition, which recognises on a server', async () => {
    expect(await pickEngine({ webkitSpeechRecognition: class {} })).toBe('whisper');
  });

  it('uses Whisper when the browser cannot report on-device availability', async () => {
    expect(await pickEngine(speechWindow().w)).toBe('whisper');
  });

  it('uses Web Speech only when on-device English is available', async () => {
    const asked: unknown[] = [];
    const yes = speechWindow(async (o) => (asked.push(o), 'available'));
    expect(await pickEngine(yes.w)).toBe('web-speech-local');
    expect(asked).toEqual([{ langs: ['en-US'], processLocally: true }]);
    expect(await pickEngine(speechWindow(async () => 'downloadable').w)).toBe('whisper');
    expect(await pickEngine(speechWindow(async () => { throw new Error('nope'); }).w)).toBe('whisper');
  });
});

describe('LocalWebSpeech', () => {
  it('asks for on-device recognition with plan names as phrase hints', async () => {
    const { w, made } = speechWindow(async () => 'available');
    const r = new LocalWebSpeech(w, () => ['metformin', 'levothyroxine']);
    await r.start();
    const rec = made[0]!;
    expect(rec).toMatchObject({ lang: 'en-US', processLocally: true, interimResults: false, started: true });
    expect(rec.phrases).toEqual([
      { phrase: 'metformin', boost: 5 },
      { phrase: 'levothyroxine', boost: 5 },
    ]);
    rec.say('I just gave her', 'the metformin');
    expect(await r.stop()).toBe('I just gave her the metformin');
  });

  it('resolves empty when nothing was said and rejects on a real error', async () => {
    const { w, made } = speechWindow(async () => 'available');
    const r = new LocalWebSpeech(w, () => []);
    await r.start();
    made[0]!.onerror?.({ error: 'no-speech' });
    expect(await r.stop()).toBe('');
    await r.start();
    made[1]!.onerror?.({ error: 'audio-capture' });
    await expect(r.stop()).rejects.toThrow('audio-capture');
  });
});

describe('WhisperClient', () => {
  function fakeWorker() {
    const sent: { m: any; transfer?: Transferable[] }[] = [];
    const worker: WorkerLike = { onmessage: null, postMessage: (m, transfer) => sent.push({ m, transfer }) };
    const reply = (data: unknown) => worker.onmessage?.({ data } as MessageEvent);
    return { worker, sent, reply };
  }

  it('reports load progress, then readiness', () => {
    const { worker, sent, reply } = fakeWorker();
    const seen: SttStatus[] = [];
    const c = new WhisperClient(worker, (s) => seen.push(s));
    c.preload();
    expect(sent[0]!.m).toEqual({ type: 'load' });
    reply({ type: 'progress', progress: 0.5 });
    reply({ type: 'ready' });
    reply({ type: 'error', message: 'Speech model failed to load: offline' });
    expect(seen).toEqual([
      { phase: 'loading', progress: 0.5 },
      { phase: 'ready' },
      { phase: 'error', message: 'Speech model failed to load: offline' },
    ]);
  });

  it('matches replies to requests by id and transfers the samples', async () => {
    const { worker, sent, reply } = fakeWorker();
    const c = new WhisperClient(worker);
    const a = c.transcribe(new Float32Array(16000));
    const b = c.transcribe(new Float32Array(8000));
    const [ma, mb] = sent.map((s) => s.m);
    expect(ma).toMatchObject({ type: 'transcribe', id: 1 });
    expect(sent[0]!.transfer?.[0]).toBe(ma.samples.buffer);
    reply({ type: 'text', id: mb.id, text: ' second ' });
    reply({ type: 'error', id: ma.id, message: 'decode failed' });
    await expect(b).resolves.toBe('second');
    await expect(a).rejects.toThrow('decode failed');
  });
});
