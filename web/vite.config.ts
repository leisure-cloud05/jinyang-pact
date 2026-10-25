/**
 * Vite config of the play UI (`web/`). `npm run play:web:build` writes `web/dist`, which the play server serves;
 * `npm run play:web` runs this dev server with `/api` proxied to the play server (JINYANG_API, default :8787).
 */
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const api = process.env.JINYANG_API ?? 'http://127.0.0.1:8787';

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': { target: api, changeOrigin: false } },
  },
});
