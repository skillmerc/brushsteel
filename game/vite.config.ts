import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Relative paths so the build runs from any folder and offline.
// The game shows package.json's version on the title, Pause and Credits.
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;
export default defineConfig({
  base: './',
  define: { __BRUSHSTEEL_VERSION__: JSON.stringify(version) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
