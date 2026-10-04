import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// pooEffects build configuration.
// The render engine runs inside a module Web Worker (OffscreenCanvas + WebGL2),
// so workers are emitted as ES modules.
export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
    sourcemap: false,
  },
  server: {
    port: 5173,
    host: true,
  },
  preview: {
    port: 4173,
    host: true,
  },
});
