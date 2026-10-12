import { defineConfig } from 'vite';

// Local only: the dev server binds to 127.0.0.1.
export default defineConfig({
  server: { host: '127.0.0.1', port: Number(process.env.BATON_HOST_PORT) || 5173, strictPort: true },
  preview: { host: '127.0.0.1' },
});
