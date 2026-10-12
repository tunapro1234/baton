// Web Worker: runs Whisper with transformers.js so the page stays responsive while it loads and listens.
import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { STT_DTYPE, STT_MODEL } from './stt-model.ts';

type Inbound = { type: 'load' } | { type: 'transcribe'; id: number; samples: Float32Array };

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
let model: Promise<AutomaticSpeechRecognitionPipeline> | undefined;

function load(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!model) {
    const loaded = new Map<string, number>();
    const total = new Map<string, number>();
    model = pipeline('automatic-speech-recognition', STT_MODEL, {
      dtype: STT_DTYPE,
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status !== 'progress' || !p.file) return;
        loaded.set(p.file, p.loaded ?? 0);
        total.set(p.file, p.total ?? 0);
        const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
        const t = sum(total);
        if (t > 0) post({ type: 'progress', progress: sum(loaded) / t });
      },
    }) as Promise<AutomaticSpeechRecognitionPipeline>;
    model.then(
      () => post({ type: 'ready' }),
      (e: Error) => {
        model = undefined;
        post({ type: 'error', message: `Speech model failed to load: ${e.message}` });
      },
    );
  }
  return model;
}

self.onmessage = async (e: MessageEvent<Inbound>) => {
  const m = e.data;
  if (m.type === 'load') {
    void load().catch(() => {});
    return;
  }
  try {
    const asr = await load();
    const out = (await asr(m.samples)) as { text: string };
    post({ type: 'text', id: m.id, text: out.text });
  } catch (err) {
    post({ type: 'error', id: m.id, message: (err as Error).message });
  }
};
