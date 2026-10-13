import { defineConfig } from 'vite';

// BATON_DEMO_UPSTREAM (tests only): forward the demo service's paths to it, the way the reverse proxy
// in front of the public demo does, so the demo build runs same-origin.
const upstream = process.env.BATON_DEMO_UPSTREAM;
const proxy = upstream ? { '/r/': upstream, '/assistant/': upstream } : undefined;

// Local only: the dev server binds to 127.0.0.1. BATON_HOST_NO_WATCH turns file watching off for
// test runs, where nothing changes and a busy machine can run out of inotify watchers.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: Number(process.env.BATON_HOST_PORT) || 5173,
    strictPort: true,
    watch: process.env.BATON_HOST_NO_WATCH ? null : {},
    proxy,
  },
  preview: { host: '127.0.0.1', proxy },
  // The speech worker imports transformers.js as an ES module; pre-bundling breaks its onnxruntime-web assets.
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});
