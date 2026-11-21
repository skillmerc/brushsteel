import { defineConfig } from 'vite';

// Relative paths so the build runs from any folder and offline.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
