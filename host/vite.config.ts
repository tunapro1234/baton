import { defineConfig } from 'vite';

// Local only: the dev server binds to 127.0.0.1. BATON_HOST_NO_WATCH turns file watching off for
// test runs, where nothing changes and a busy machine can run out of inotify watchers.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: Number(process.env.BATON_HOST_PORT) || 5173,
    strictPort: true,
    watch: process.env.BATON_HOST_NO_WATCH ? null : {},
  },
  preview: { host: '127.0.0.1' },
  // The speech worker imports transformers.js as an ES module; pre-bundling breaks its onnxruntime-web assets.
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});
