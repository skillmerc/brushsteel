# BRUSHSTEEL game

Vite + TypeScript + Three.js. Project overview: `../README.md`.

## Commands

- `npm ci` install the pinned versions
- `npm test` compile `src/core` with tsc and run its unit tests with `node --test` (no DOM)
- `npm run build` type check, then build to `dist/` (`dist/index.html` at the root, relative paths)
- `npm run build:single` one self-contained file, `dist-single/index.html`, that opens from `file://`

Builds, screenshots and the browser smoke test run in CI (`../ci/`, `../.github/workflows/ci.yml`).

## Layout

- `src/core/` pure rules, no DOM and no Three.js, each module with a `*.test.ts` next to it. Import siblings with a `.js` suffix (`./rng.js`) so both Vite and Node resolve them.
- `src/render/` Three.js: stage, camera, paper and ink shaders, figures, landscapes
- `src/input/` mouse, keyboard and controller input, the stroke classifier and the duel loop
- `src/audio/` WebAudio sound, made in code
- `src/ui/` menus, HUD and Path mode screens
- `src/main.ts` entry: builds the stage and starts the render loop
