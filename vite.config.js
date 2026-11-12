import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works from any subpath (e.g. GitHub Pages).
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 },
  optimizeDeps: { exclude: ['@mintplex-labs/piper-tts-web', 'onnxruntime-web'] },
});
