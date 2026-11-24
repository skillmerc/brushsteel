import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// One self-contained HTML file that opens from file:// with no server.
// The game shows package.json's version on the title, Pause and Credits.
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;
export default defineConfig({
  base: './',
  define: { __BRUSHSTEEL_VERSION__: JSON.stringify(version) },
  plugins: [viteSingleFile()],
  build: {
    outDir: 'dist-single',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
